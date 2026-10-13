export const incidentLifecycleStates = [
  "open",
  "awaiting_verification",
  "recovering",
  "needs_human",
  "resolved",
] as const;

export type IncidentLifecycleState = (typeof incidentLifecycleStates)[number];

export const verificationOutcomes = ["resolved", "unresolved", "inconclusive"] as const;
export type VerificationOutcome = (typeof verificationOutcomes)[number];

export const verificationSources = ["operator", "observability"] as const;
export type VerificationSource = (typeof verificationSources)[number];

export const recoveryFailureClasses = [
  "provider_unavailable",
  "invalid_model_output",
  "connector_failure",
  "unresolved_mitigation",
] as const;

export type RecoveryFailureClass = (typeof recoveryFailureClasses)[number];
export type RecoveryFailureKind = RecoveryFailureClass | "missing_evidence" | "policy_block";

export const recoveryResetReasons = ["operator_reset", "material_evidence"] as const;
export type RecoveryResetReason = (typeof recoveryResetReasons)[number];

export const outcomeCandidateCategories = [
  "unresolved_mitigation",
  "recovery_exhausted",
  "corrected_finding",
  "reasoned_rejection",
] as const;

export type OutcomeCandidateCategory = (typeof outcomeCandidateCategories)[number];

export interface VerificationOutcomeInput {
  outcome: VerificationOutcome;
  source: VerificationSource;
  sourceReference: string;
  runId: string;
  evidenceIds: string[];
  rationale: string;
}

export interface LifecycleSeed {
  incidentId: string;
  runId?: string;
  verificationRequired?: boolean;
  approvalStatus?: string;
}

export interface IncidentLifecycleProjection {
  incidentId: string;
  state: IncidentLifecycleState;
  runId?: string;
  verificationOutcome?: VerificationOutcome;
  latestEventId?: string;
  updatedAt?: string;
}

export type IncidentLifecycleEvent =
  | {
    type: "verification_recorded";
    eventId: string;
    incidentId: string;
    createdAt: string;
    verification: VerificationOutcomeInput;
  }
  | {
    type: "recovery_attempted";
    eventId: string;
    incidentId: string;
    createdAt: string;
    failureClass: RecoveryFailureClass;
    runId?: string;
  }
  | {
    type: "recovery_exhausted";
    eventId: string;
    incidentId: string;
    createdAt: string;
    failureClass: RecoveryFailureClass;
    runId?: string;
  }
  | {
    type: "recovery_reset";
    eventId: string;
    incidentId: string;
    createdAt: string;
    failureClass: RecoveryFailureClass;
    reason: RecoveryResetReason;
    runId?: string;
  }
  | {
    type: "reentry_recorded";
    eventId: string;
    incidentId: string;
    createdAt: string;
    material: boolean;
    runId?: string;
  };

export function initialLifecycleProjection(seed: LifecycleSeed): IncidentLifecycleProjection {
  const awaitsVerification = seed.verificationRequired === true
    && (seed.approvalStatus === "human_approved" || seed.approvalStatus === "simulated");
  return {
    incidentId: requiredText(seed.incidentId, "incident_id"),
    state: awaitsVerification ? "awaiting_verification" : "open",
    ...(seed.runId ? { runId: seed.runId } : {}),
  };
}

export function applyLifecycleEvent(
  projection: IncidentLifecycleProjection,
  event: IncidentLifecycleEvent,
): IncidentLifecycleProjection {
  if (event.incidentId !== projection.incidentId) {
    throw new Error(`Lifecycle event incident ${event.incidentId} does not match ${projection.incidentId}.`);
  }

  const next: IncidentLifecycleProjection = {
    ...projection,
    latestEventId: event.eventId,
    updatedAt: event.createdAt,
    ...("runId" in event && event.runId ? { runId: event.runId } : {}),
  };

  switch (event.type) {
    case "verification_recorded":
      next.runId = event.verification.runId;
      next.verificationOutcome = event.verification.outcome;
      next.state = verificationState(event.verification.outcome);
      return next;
    case "recovery_attempted":
      next.state = "recovering";
      return next;
    case "recovery_exhausted":
      next.state = "needs_human";
      return next;
    case "recovery_reset":
      next.state = "open";
      return next;
    case "reentry_recorded":
      if (projection.state === "resolved" && !event.material) {
        throw new Error("A resolved incident can reopen only after material evidence.");
      }
      if (event.material) {
        next.state = "open";
        delete next.verificationOutcome;
      }
      return next;
  }
}

export function parseVerificationOutcomeInput(value: unknown): VerificationOutcomeInput {
  const record = objectValue(value, "verification outcome");
  const outcome = enumValue(record.outcome, verificationOutcomes, "outcome");
  const source = enumValue(record.source, verificationSources, "source");
  const sourceReference = requiredText(record.sourceReference ?? record.source_reference, "source_reference");
  const runId = requiredText(record.runId ?? record.run_id, "run_id");
  const evidenceIds = stringArray(record.evidenceIds ?? record.evidence_ids, "evidence_ids");
  const rationale = requiredText(record.rationale, "rationale");
  if (evidenceIds.length === 0) {
    throw new Error("verification outcome requires at least one evidence_id.");
  }
  return { outcome, source, sourceReference, runId, evidenceIds, rationale };
}

export function classifyRecoveryFailure(kind: RecoveryFailureKind): RecoveryFailureClass | undefined {
  return recoveryFailureClasses.includes(kind as RecoveryFailureClass)
    ? kind as RecoveryFailureClass
    : undefined;
}

export function isOutcomeCandidateCategory(value: string): value is OutcomeCandidateCategory {
  return outcomeCandidateCategories.includes(value as OutcomeCandidateCategory);
}

function verificationState(outcome: VerificationOutcome): IncidentLifecycleState {
  if (outcome === "resolved") {
    return "resolved";
  }
  if (outcome === "unresolved") {
    return "recovering";
  }
  return "awaiting_verification";
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T[number];
}
