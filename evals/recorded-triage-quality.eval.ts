import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { incidentTriageHarness, type IncidentTriageEvalOutput } from "./harness";
import {
  evaluateRecordedTriageQuality,
  formatRecordedTriageQualityReport,
  type RecordedTriageQualityGateName,
} from "./quality-gates";

const recordedScenarios = [
  "checkout-payment-timeout",
  "capacity-saturation",
  "bad-deploy-latency",
] as const;

describeEval("recorded triage quality gates", { harness: incidentTriageHarness }, (it) => {
  it.for(recordedScenarios.map((scenarioName) => ({
    name: `${scenarioName} passes recorded triage quality gates`,
    input: { scenarioName },
  })))("$name", async ({ input }, { run }) => {
    const result = await run(input);
    assertAllGatesPass(result.output);
  });

  it("known-good recorded response proves gates are passable", () => {
    const response = JSON.parse(readFileSync("docs/examples/recorded-triage-response.json", "utf8")) as IncidentTriageEvalOutput;

    assertAllGatesPass(response);
  });

  it("quality gates fail independently for targeted response defects", async ({ run }) => {
    const result = await run({ scenarioName: "checkout-payment-timeout" });

    assertOnlyGateFails(withoutRecommendationRationale(result.output), "recorded_triage_readability");
    assertOnlyGateFails(withoutSafety(result.output), "safety_contract");
    assertOnlyGateFails(withInvalidRecommendationEvidence(result.output), "evidence_grounding");
    assertOnlyGateFails(withoutProvenance(result.output), "provenance_support");
  });
});

function assertAllGatesPass(response: IncidentTriageEvalOutput): void {
  const report = evaluateRecordedTriageQuality(response);

  expect(
    report.failures.map((failure) => failure.name),
    formatRecordedTriageQualityReport(report, response),
  ).toEqual([]);
}

function assertOnlyGateFails(response: IncidentTriageEvalOutput, expectedGate: RecordedTriageQualityGateName): void {
  const report = evaluateRecordedTriageQuality(response);

  expect(
    report.failures.map((failure) => failure.name),
    formatRecordedTriageQualityReport(report, response),
  ).toEqual([expectedGate]);
}

function withoutRecommendationRationale(response: IncidentTriageEvalOutput): IncidentTriageEvalOutput {
  const clone = deepClone(response);
  clone.recommendation = {
    ...objectValue(clone.recommendation),
    rationale: "",
  };
  return clone;
}

function withoutSafety(response: IncidentTriageEvalOutput): IncidentTriageEvalOutput {
  const clone = deepClone(response);
  delete clone.safety;
  return clone;
}

function withInvalidRecommendationEvidence(response: IncidentTriageEvalOutput): IncidentTriageEvalOutput {
  const clone = deepClone(response);
  clone.recommendation = {
    ...objectValue(clone.recommendation),
    evidence_ids: ["unknown:evidence-id"],
  };
  return clone;
}

function withoutProvenance(response: IncidentTriageEvalOutput): IncidentTriageEvalOutput {
  const clone = deepClone(response);
  delete clone.provenance;
  return clone;
}

function deepClone(response: IncidentTriageEvalOutput): IncidentTriageEvalOutput {
  return JSON.parse(JSON.stringify(response)) as IncidentTriageEvalOutput;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
