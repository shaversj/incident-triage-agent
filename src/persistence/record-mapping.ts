import { createHash } from "node:crypto";

import {
  applyLifecycleEvent,
  initialLifecycleProjection,
  type IncidentLifecycleEvent,
  type RecoveryFailureClass,
  type RecoveryResetReason,
} from "../incident-lifecycle";
import type { TriageRun } from "../workflow";
import type {
  EvidenceGateCandidate,
  EvidenceGateDecisionRecord,
  EvidenceSnapshotRecord,
  IncidentLifecycleReviewRecord,
  OutcomeReviewCandidateInput,
  OutcomeReviewCandidateRecord,
  PersistTriageRunOptions,
  RecoveryBudgetRecord,
  RecoveryEventRecord,
  RecoveryEventType,
  RecoveryFailureWriteInput,
  ReplayKeyInput,
  RetentionClass,
  TriageRunRecord,
  TriageRunReviewEnvelope,
  VerificationOutcomeRecord,
  VerificationOutcomeWriteInput,
} from "./contracts";

const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;

export function buildReplayKey(input: ReplayKeyInput): string {
  const digest = createHash("sha256")
    .update(input.sender)
    .update("\0")
    .update(input.signature)
    .update("\0")
    .update(input.timestamp)
    .update("\0")
    .update(input.bodyDigest)
    .digest("hex");
  return `replay:${digest}`;
}

export function buildRunRecord(
  run: TriageRun,
  options: PersistTriageRunOptions,
  lineage: { parentRunId?: string; gateDecisionId?: string } = {},
): TriageRunRecord {
  const { createdAt, expiresAt, retentionClass } = persistenceMetadata(options);
  const validationStatus = run.validation ? (run.validation.valid ? "valid" : "invalid") : "not_available";
  const evidenceIds = run.evidencePackage?.evidence.map((item) => item.evidenceId) ?? [];
  const record: TriageRunRecord = {
    runId: run.runId,
    incidentId: run.scenario.incident.incidentId,
    incidentTitle: run.scenario.incident.title,
    severity: run.scenario.incident.severity,
    incidentStatus: run.scenario.incident.status,
    startedAt: run.scenario.incident.startedAt,
    scenarioName: run.scenario.name,
    service: run.scenario.incident.service,
    runStatus: run.runStatus,
    validationStatus,
    evidenceIds,
    retentionClass,
    correlationId: options.correlationId ?? run.runId,
    createdAt,
    expiresAt,
  };
  if (lineage.parentRunId) {
    record.parentRunId = lineage.parentRunId;
  }
  if (lineage.gateDecisionId) {
    record.gateDecisionId = lineage.gateDecisionId;
  }
  if (run.safety) {
    record.safetyStatus = run.safety.status;
  }
  if (run.mitigationControl) {
    record.mitigationStatus = run.mitigationControl.status;
  }
  if (run.scorecard) {
    record.scorecard = run.scorecard;
  }
  const reviewEnvelope = buildReviewEnvelope(run);
  if (Object.keys(reviewEnvelope).length > 0) {
    record.reviewEnvelope = reviewEnvelope;
  }
  return record;
}

function buildReviewEnvelope(run: TriageRun): TriageRunReviewEnvelope {
  const envelope: TriageRunReviewEnvelope = {};
  if (run.investigation) {
    envelope.investigation = run.investigation;
  }
  if (run.validation) {
    envelope.validation = {
      valid: run.validation.valid,
      errors: run.validation.errors,
    };
    if (run.validation.decision) {
      envelope.decision = run.validation.decision;
    }
  }
  if (run.explanation) {
    envelope.explanation = run.explanation;
  }
  if (run.explanationValidation) {
    envelope.explanationValidation = run.explanationValidation;
  }
  if (run.safety) {
    envelope.safety = run.safety;
  }
  if (run.mitigationControl) {
    envelope.mitigationControl = run.mitigationControl;
  }
  if (run.evidencePackage) {
    envelope.provenance = run.evidencePackage.provenanceSummary(run.validation?.decision?.evidenceIds ?? []);
  }
  return envelope;
}

export function buildEvidenceSnapshot(
  run: TriageRun,
  record: TriageRunRecord,
  options: PersistTriageRunOptions,
): EvidenceSnapshotRecord {
  return {
    runId: record.runId,
    incidentId: record.incidentId,
    evidence: run.evidencePackage?.evidence ?? [],
    missingContext: run.evidencePackage?.missingContext ?? [],
    retentionClass: options.retentionClass ?? record.retentionClass,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export function boundedLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}


export function buildGateDecisionRecord(
  candidate: EvidenceGateCandidate,
  options: PersistTriageRunOptions,
  childRunId?: string,
): EvidenceGateDecisionRecord {
  const { createdAt, expiresAt, retentionClass } = persistenceMetadata(options);
  const record: EvidenceGateDecisionRecord = {
    decisionId: gateDecisionId(candidate),
    incidentId: candidate.incidentId,
    canonicalizationVersion: candidate.canonicalizationVersion,
    candidateDigest: candidate.candidateDigest,
    baselineKey: baselineKey(candidate),
    outcome: candidate.decision.outcome,
    basis: candidate.decision.basis,
    delta: candidate.delta,
    rationale: candidate.decision.rationale,
    citedDeltaRefs: candidate.decision.citedDeltaRefs,
    retentionClass,
    createdAt,
    expiresAt,
  };
  if (candidate.priorRunId) {
    record.priorRunId = candidate.priorRunId;
  }
  if (childRunId) {
    record.childRunId = childRunId;
  }
  return record;
}

function gateDecisionId(candidate: EvidenceGateCandidate): string {
  return stableId("gate", candidate.incidentId, baselineKey(candidate), candidate.candidateDigest);
}

export function baselineKey(candidate: EvidenceGateCandidate): string {
  return candidate.priorRunId ?? "none";
}

export function gateDecisionKey(candidate: EvidenceGateCandidate): string {
  return `${candidate.incidentId}\0${baselineKey(candidate)}\0${candidate.candidateDigest}`;
}

export function gateDecisionRecordKey(record: EvidenceGateDecisionRecord): string {
  return `${record.incidentId}\0${record.baselineKey}\0${record.candidateDigest}`;
}


const recoveryAttemptLimit = 3;

export function buildVerificationRecord(
  input: VerificationOutcomeWriteInput,
  options: PersistTriageRunOptions,
): VerificationOutcomeRecord {
  const { createdAt, expiresAt, retentionClass } = persistenceMetadata(options);
  return {
    eventId: stableId("verification", input.incidentId, input.sourceEventKey),
    incidentId: input.incidentId,
    sourceEventKey: input.sourceEventKey,
    verification: input.verification,
    retentionClass,
    createdAt,
    expiresAt,
  };
}

export function initialRecoveryBudget(
  input: Pick<RecoveryFailureWriteInput, "incidentId" | "failureClass">,
  options: PersistTriageRunOptions,
): RecoveryBudgetRecord {
  const { createdAt, expiresAt } = persistenceMetadata(options);
  return {
    incidentId: input.incidentId,
    failureClass: input.failureClass,
    attempts: 0,
    limit: recoveryAttemptLimit,
    exhausted: false,
    generation: 0,
    updatedAt: createdAt,
    expiresAt,
  };
}

export function buildRecoveryEvent(
  input: RecoveryFailureWriteInput,
  eventType: RecoveryEventType,
  generation: number,
  options: PersistTriageRunOptions,
  detail: { attempt?: number; reason?: RecoveryResetReason; actor?: string } = {},
): RecoveryEventRecord {
  const { createdAt, expiresAt, retentionClass } = persistenceMetadata(options);
  return {
    eventId: stableId("recovery", input.incidentId, input.sourceEventKey),
    incidentId: input.incidentId,
    sourceEventKey: input.sourceEventKey,
    eventType,
    failureClass: input.failureClass,
    rationale: input.rationale,
    generation,
    retentionClass,
    createdAt,
    expiresAt,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(detail.attempt !== undefined ? { attempt: detail.attempt } : {}),
    ...(detail.reason ? { reason: detail.reason } : {}),
    ...(detail.actor ? { actor: detail.actor } : {}),
  };
}

export function buildOutcomeCandidate(
  input: OutcomeReviewCandidateInput,
  options: PersistTriageRunOptions,
): OutcomeReviewCandidateRecord {
  const { createdAt, expiresAt, retentionClass } = persistenceMetadata(options);
  return {
    candidateId: stableId("outcome", input.incidentId, input.category, input.sourceEventId),
    incidentId: input.incidentId,
    sourceEventId: input.sourceEventId,
    category: input.category,
    rationale: input.rationale,
    evidenceIds: [...new Set(input.evidenceIds)],
    snapshot: input.snapshot,
    status: "pending",
    retentionClass,
    createdAt,
    expiresAt,
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

export function candidateFromVerification(record: VerificationOutcomeRecord): OutcomeReviewCandidateInput {
  return {
    incidentId: record.incidentId,
    runId: record.verification.runId,
    sourceEventId: record.eventId,
    category: "unresolved_mitigation",
    rationale: record.verification.rationale,
    evidenceIds: record.verification.evidenceIds,
    snapshot: {
      outcome: record.verification.outcome,
      source: record.verification.source,
      source_reference: record.verification.sourceReference,
    },
  };
}

export function candidateFromRecoveryExhaustion(record: RecoveryEventRecord): OutcomeReviewCandidateInput {
  return {
    incidentId: record.incidentId,
    ...(record.runId ? { runId: record.runId } : {}),
    sourceEventId: record.eventId,
    category: "recovery_exhausted",
    rationale: record.rationale,
    evidenceIds: [],
    snapshot: {
      failure_class: record.failureClass,
      attempt: record.attempt ?? recoveryAttemptLimit,
      limit: recoveryAttemptLimit,
    },
  };
}

export function verificationLifecycleEvent(record: VerificationOutcomeRecord): IncidentLifecycleEvent {
  return {
    type: "verification_recorded",
    eventId: record.eventId,
    incidentId: record.incidentId,
    createdAt: record.createdAt,
    verification: record.verification,
  };
}

export function recoveryLifecycleEvent(record: RecoveryEventRecord): IncidentLifecycleEvent {
  const common = {
    eventId: record.eventId,
    incidentId: record.incidentId,
    createdAt: record.createdAt,
    failureClass: record.failureClass,
    ...(record.runId ? { runId: record.runId } : {}),
  };
  if (record.eventType === "exhausted") {
    return { type: "recovery_exhausted", ...common };
  }
  if (record.eventType === "reset") {
    return { type: "recovery_reset", ...common, reason: record.reason ?? "operator_reset" };
  }
  return { type: "recovery_attempted", ...common };
}

export function compareLifecycleEvents(left: IncidentLifecycleEvent, right: IncidentLifecycleEvent): number {
  const chronological = left.createdAt.localeCompare(right.createdAt);
  if (chronological !== 0) {
    return chronological;
  }
  const priority: Record<IncidentLifecycleEvent["type"], number> = {
    recovery_attempted: 0,
    recovery_exhausted: 1,
    recovery_reset: 2,
    reentry_recorded: 3,
    verification_recorded: 4,
  };
  return priority[left.type] - priority[right.type];
}

export function buildIncidentLifecycleReview(
  incidentId: string,
  verificationEvents: VerificationOutcomeRecord[],
  recoveryEvents: RecoveryEventRecord[],
  recoveryBudgets: RecoveryBudgetRecord[],
  candidates: OutcomeReviewCandidateRecord[],
): IncidentLifecycleReviewRecord {
  const lifecycleEvents = [
    ...verificationEvents.map(verificationLifecycleEvent),
    ...recoveryEvents.map(recoveryLifecycleEvent),
  ].sort(compareLifecycleEvents);
  return {
    incidentId,
    projection: lifecycleEvents.reduce(applyLifecycleEvent, initialLifecycleProjection({ incidentId })),
    verificationEvents,
    recoveryEvents,
    recoveryBudgets,
    candidates,
  };
}

function persistenceMetadata(options: PersistTriageRunOptions): {
  createdAt: string;
  expiresAt: string;
  retentionClass: RetentionClass;
} {
  const now = options.now ?? new Date();
  return {
    createdAt: iso(now),
    expiresAt: iso(new Date(now.getTime() + (options.ttlMs ?? defaultTtlMs))),
    retentionClass: options.retentionClass ?? "read_only_triage",
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

export function recoveryBudgetKey(incidentId: string, failureClass: RecoveryFailureClass): string {
  return `${incidentId}\0${failureClass}`;
}

export function verificationSourceKey(incidentId: string, sourceEventKey: string): string {
  return `${incidentId}\0${sourceEventKey}`;
}

export function recoverySourceKey(
  incidentId: string,
  failureClass: RecoveryFailureClass,
  sourceEventKey: string,
): string {
  return `${incidentId}\0${failureClass}\0${sourceEventKey}`;
}

export function outcomeCandidateKey(input: Pick<OutcomeReviewCandidateInput, "incidentId" | "category" | "sourceEventId">): string {
  return `${input.incidentId}\0${input.category}\0${input.sourceEventId}`;
}

export function iso(date: Date): string {
  return date.toISOString();
}
