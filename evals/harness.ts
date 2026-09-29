import { createHarness, toJsonValue, type JsonValue } from "vitest-evals";
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

export type IncidentTriageEvalOutput = Record<string, JsonValue>;

export interface IncidentTriageExecutionResult {
  output: IncidentTriageEvalOutput;
  metadata: {
    scenario: string;
    mode: IncidentTriageEvalMode;
    run_status: JsonValue | undefined;
  };
  scenarioArtifact: {
    name: string;
    incident_id: string;
    service: string;
    mode: IncidentTriageEvalMode;
  };
}

export const incidentTriageHarness = createHarness<IncidentTriageEvalInput, IncidentTriageEvalOutput>({
  name: "incident-triage-workflow",
  run: async ({ input, setArtifact }) => {
    const result = await runIncidentTriage(input);
    setArtifact("scenario", result.scenarioArtifact);
    return { output: result.output, metadata: result.metadata };
  },
});

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
  const response = toJsonValue(runToResponse(run));
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Incident triage eval produced a non-object response.");
  }
  return {
    output: response as IncidentTriageEvalOutput,
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

export function liveEvalEnabled(): boolean {
  return process.env.RUN_LIVE_FLUE_EVALS === "1";
}
