import { createJudge } from "vitest-evals";
import type { IncidentTriageEvalInput, IncidentTriageEvalOutput } from "./harness";

export const RecommendationQualityJudge = createJudge<IncidentTriageEvalInput, IncidentTriageEvalOutput>(
  "RecommendationQualityJudge",
  ({ output }) => {
    const findingSummary = stringValue(output.finding_summary);
    const recommendation = objectValue(output.recommendation);
    const decision = objectValue(output.decision);
    const rationale = stringValue(recommendation?.rationale);
    const recommendationEvidenceIds = stringArrayValue(recommendation?.evidence_ids);
    const decisionEvidenceIds = stringArrayValue(decision?.evidence_ids);
    const verificationPlan = stringArrayValue(decision?.verification_plan);
    const caveats = stringArrayValue(decision?.caveats);

    const checks = [
      {
        name: "finding summary names concrete signal",
        passed: /\b(alert|latency|error|timeout|cpu|deploy|capacity|runbook)\b/i.test(findingSummary),
      },
      {
        name: "recommendation cites evidence",
        passed: recommendationEvidenceIds.length > 0 && recommendationEvidenceIds.every((id) => decisionEvidenceIds.includes(id)),
      },
      {
        name: "rationale is incident-specific",
        passed: /\b(alert|log|runbook|deploy|verification|timeout|latency|cpu|queue)\b/i.test(rationale),
      },
      {
        name: "verification plan names recovery signal",
        passed: verificationPlan.some((step) => /\b(confirm|verify|check|monitor)\b/i.test(step)) &&
          verificationPlan.some((step) => /\b(latency|error|timeout|cpu|queue|traffic|slo|baseline)\b/i.test(step)),
      },
      {
        name: "caveats are specific when present",
        passed: caveats.length === 0 || caveats.every((caveat) => caveat.split(/\s+/).length >= 4),
      },
    ];
    const passed = checks.filter((check) => check.passed).length;
    return {
      score: passed / checks.length,
      metadata: {
        rationale: `${passed}/${checks.length} explanation quality checks passed.`,
        output: checks,
      },
    };
  },
);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
