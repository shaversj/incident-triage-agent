import type { AppConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import {
  FlueDecisionClient,
  StaticDecisionClient,
  runIncidentTriageSkill,
  type FlueCommandResult,
} from "../src/llm";
import { mockDecisionForScenario } from "../src/mock-decisions";
import { runToResponse } from "../src/server";
import { TriageWorkflow } from "../src/workflow";

export type IncidentTriageEvalMode = "mock" | "live";

export interface IncidentTriageEvalInput {
  scenarioName: string;
  mode?: IncidentTriageEvalMode;
  mockResponse?: object;
  mockResponseText?: string;
  mockFlueResult?: FlueCommandResult;
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
  if (mode === "live" && input.mockFlueResult) {
    throw new Error("mockFlueResult cannot be used with live mode.");
  }
  const llmClient = input.mockFlueResult
    ? new FlueDecisionClient(evalAppConfig(), (evidencePackage, config, logger) =>
      runIncidentTriageSkill(
        evidencePackage,
        config,
        logger,
        async () => input.mockFlueResult!,
      ))
    : mode === "live"
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

function evalAppConfig(): AppConfig {
  return {
    minimaxApiKey: "eval-placeholder",
    modelName: "eval-model",
    minimaxBaseUrl: "https://example.invalid",
    redacted: {
      MINIMAX_API_KEY: "<redacted>",
      MODEL_NAME: "eval-model",
      MINIMAX_BASE_URL: "https://example.invalid",
    },
  };
}
