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

export const incidentTriageHarness = createHarness<IncidentTriageEvalInput, IncidentTriageEvalOutput>({
  name: "incident-triage-workflow",
  run: async ({ input, setArtifact }) => {
    const scenario = loadScenario("fixtures", input.scenarioName);
    const llmClient = input.mode === "live"
      ? new FlueDecisionClient(loadConfig(".env"))
      : new StaticDecisionClient({
        [scenario.name]: input.mockResponseText ?? JSON.stringify(input.mockResponse ?? mockDecisionForScenario(scenario)),
      });
    const run = await new TriageWorkflow(loadTools("fixtures"), llmClient).run(scenario);
    const response = toJsonValue(runToResponse(run));
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Incident triage eval produced a non-object response.");
    }

    setArtifact("scenario", {
      name: scenario.name,
      incident_id: scenario.incident.incidentId,
      service: scenario.incident.service,
      mode: input.mode ?? "mock",
    });

    return {
      output: response as IncidentTriageEvalOutput,
      metadata: {
        scenario: scenario.name,
        mode: input.mode ?? "mock",
        run_status: response.run_status,
      },
    };
  },
});

export function liveEvalEnabled(): boolean {
  return process.env.RUN_LIVE_FLUE_EVALS === "1";
}
