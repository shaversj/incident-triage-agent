import { createHarness, toJsonValue, type JsonValue } from "vitest-evals";
import {
  runIncidentTriage,
  type IncidentTriageEvalInput,
  type IncidentTriageEvalMode,
  type IncidentTriageExecutionResult,
} from "./incident-triage-runner";

export type { IncidentTriageEvalInput, IncidentTriageEvalMode, IncidentTriageExecutionResult };
export type IncidentTriageEvalOutput = Record<string, JsonValue>;

export const incidentTriageHarness = createHarness<IncidentTriageEvalInput, IncidentTriageEvalOutput>({
  name: "incident-triage-workflow",
  run: async ({ input, setArtifact }) => {
    const result = await runIncidentTriage(input);
    setArtifact("scenario", result.scenarioArtifact);
    const output = toJsonValue(result.output) as IncidentTriageEvalOutput;
    return { output, metadata: { ...result.metadata, run_status: output.run_status } };
  },
});

export function liveEvalEnabled(): boolean {
  return process.env.RUN_LIVE_FLUE_EVALS === "1";
}
