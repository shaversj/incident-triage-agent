import { loadConfig } from "../src/config";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { FlueDecisionClient, StaticDecisionClient } from "../src/llm";
import { mockDecisionForScenario } from "../src/mock-decisions";
import { runToResponse } from "../src/server";
import { TriageWorkflow } from "../src/workflow";

export type IncidentTriageEvalMode = "mock" | "live";

export interface IncidentTriageEvalInput {
  scenarioName: string;
  mode?: IncidentTriageEvalMode;
  mockResponse?: object;
  mockResponseText?: string;
}

export type IncidentTriageEvalOutput = Record<string, unknown>;

export interface IncidentTriageExecutionResult {
  output: IncidentTriageEvalOutput;
  metadata: {
    scenario: string;
    mode: IncidentTriageEvalMode;
    run_status: unknown;
  };
  scenarioArtifact: {
    name: string;
    incident_id: string;
    service: string;
    mode: IncidentTriageEvalMode;
  };
}

export async function runIncidentTriage(
  input: IncidentTriageEvalInput,
  fixturesDir = "fixtures",
): Promise<IncidentTriageExecutionResult> {
  const scenario = loadScenario(fixturesDir, input.scenarioName);
  const mode = input.mode ?? "mock";
  const llmClient = mode === "live"
    ? new FlueDecisionClient(loadConfig(".env"))
    : new StaticDecisionClient({
      [scenario.name]: input.mockResponseText ?? JSON.stringify(input.mockResponse ?? mockDecisionForScenario(scenario)),
    });
  const run = await new TriageWorkflow(loadTools(fixturesDir), llmClient).run(scenario);
  const response = runToResponse(run);
  return {
    output: response,
    metadata: {
      scenario: scenario.name,
      mode,
      run_status: response.run_status,
    },
    scenarioArtifact: {
      name: scenario.name,
      incident_id: scenario.incident.incidentId,
      service: scenario.incident.service,
      mode,
    },
  };
}
