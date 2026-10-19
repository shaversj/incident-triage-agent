import type { OutcomeCandidateCategory } from "./incident-lifecycle";
import type { OutcomeReviewCandidateInput } from "./persistence/contracts";

const allowedSnapshotKeys = new Set([
  "approval_status",
  "attempt",
  "failure_class",
  "incident_class",
  "limit",
  "next_action",
  "outcome",
  "source",
  "source_reference",
]);

export function buildReducedOutcomeCandidate(input: {
  incidentId: string;
  runId?: string;
  sourceEventId: string;
  category: OutcomeCandidateCategory;
  rationale: string;
  evidenceIds: string[];
  snapshot?: Record<string, unknown>;
}): OutcomeReviewCandidateInput {
  rejectCredentialFields(input.snapshot ?? {});
  const snapshot = Object.fromEntries(
    Object.entries(input.snapshot ?? {}).filter(([key]) => allowedSnapshotKeys.has(key)),
  );
  return {
    incidentId: requiredText(input.incidentId, "incident_id"),
    sourceEventId: requiredText(input.sourceEventId, "source_event_id"),
    category: input.category,
    rationale: requiredText(input.rationale, "rationale"),
    evidenceIds: [...new Set(input.evidenceIds.map((value) => requiredText(value, "evidence_id")))],
    snapshot,
    ...(input.runId ? { runId: requiredText(input.runId, "run_id") } : {}),
  };
}

function rejectCredentialFields(value: unknown, path = "snapshot"): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(password|secret|token|authorization|api[_-]?key)/i.test(key)) {
      throw new Error(`${path}.${key} is not allowed in an outcome candidate.`);
    }
    rejectCredentialFields(nested, `${path}.${key}`);
  }
}

function requiredText(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
