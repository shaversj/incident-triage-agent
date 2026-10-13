import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config";
import { loadScenario } from "../src/domain";
import { EvidencePackage, loadTools, type Evidence } from "../src/evidence";
import { FlueMaterialityClassifier } from "../src/llm";
import { evaluateEvidenceReentry, type MaterialityOutcome } from "../src/reentry";
import { liveEvalEnabled } from "./harness";

interface AmbiguityCase {
  name: string;
  candidate: (prior: EvidencePackage) => EvidencePackage;
  expected: Exclude<MaterialityOutcome, "first_observation">;
  rationale: string;
}

const cases: AmbiguityCase[] = [
  {
    name: "useful new guidance can change verification",
    candidate: (prior) => addEvidence(prior, {
      evidenceId: "runbook:recovery-check",
      source: "runbook",
      sourceTier: "guidance",
      summary: "Recovery verification addendum",
      detail: "Verify payment timeout rate and retry queue depth together.",
    }),
    expected: "material",
    rationale: "The new guidance adds a verification condition that can change the triage recommendation.",
  },
  {
    name: "irrelevant historical context stays suppressed",
    candidate: (prior) => addEvidence(prior, {
      evidenceId: "prior:unrelated",
      source: "prior_incident",
      sourceTier: "historical_context",
      summary: "Unrelated catalog outage",
      detail: "A catalog service incident from last year had no checkout or payment symptoms.",
    }),
    expected: "not_material",
    rationale: "The historical incident is unrelated to the current checkout evidence.",
  },
  {
    name: "removal-only guidance delta stays suppressed",
    candidate: (prior) => new EvidencePackage(
      prior.scenarioName,
      prior.incident,
      prior.evidence.filter((item) => item.sourceTier !== "guidance"),
      prior.missingContext,
      prior.investigationSteps,
    ),
    expected: "not_material",
    rationale: "Removing guidance alone does not change the current operational finding.",
  },
  {
    name: "conflicting low-signal history retriggers conservatively",
    candidate: (prior) => addEvidence(prior, {
      evidenceId: "prior:conflict",
      source: "prior_incident",
      sourceTier: "historical_context",
      summary: "Prior false positive with similar alert names",
      detail: "The prior alert recovered without intervention, conflicting with the current dependency hypothesis.",
    }),
    expected: "material",
    rationale: "The conflicting analogy could lower confidence and warrants a fresh triage decision.",
  },
];

describe("evidence re-entry materiality", () => {
  test.each(cases)("deterministic harness: $name", async (case_) => {
    const prior = evidencePackage();
    const result = await evaluateEvidenceReentry({
      prior,
      candidate: case_.candidate(prior),
      classifier: {
        classify: async (input) => ({
          material: case_.expected === "material",
          rationale: case_.rationale,
          evidence_refs: [input.deltaRefs[0]],
        }),
      },
    });

    expect(result.decision).toMatchObject({
      outcome: case_.expected,
      basis: "classifier",
      rationale: case_.rationale,
    });
    expect(result.decision.citedDeltaRefs).toHaveLength(1);
    expect(result.decision.citedDeltaRefs[0]).toMatch(/^(added|removed):/);
  });

  const liveTest = liveEvalEnabled() ? test : test.skip;
  liveTest.each(cases)("live Flue classifier: $name", async (case_) => {
    const prior = evidencePackage();
    const result = await evaluateEvidenceReentry({
      prior,
      candidate: case_.candidate(prior),
      classifier: new FlueMaterialityClassifier(loadConfig(".env")),
    });

    expect(result.decision.outcome).toBe(case_.expected);
    expect(result.decision.basis).toBe("classifier");
    expect(result.decision.citedDeltaRefs.length).toBeGreaterThan(0);
  });
});

function evidencePackage(): EvidencePackage {
  return loadTools("fixtures").buildEvidencePackage(loadScenario("fixtures", "checkout-payment-timeout"));
}

function addEvidence(package_: EvidencePackage, evidence: Evidence): EvidencePackage {
  return new EvidencePackage(
    package_.scenarioName,
    package_.incident,
    [...package_.evidence, evidence],
    package_.missingContext,
    package_.investigationSteps,
  );
}
