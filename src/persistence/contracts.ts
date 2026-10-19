import type {
  IncidentLifecycleProjection,
  OutcomeCandidateCategory,
  RecoveryFailureClass,
  RecoveryResetReason,
  VerificationOutcomeInput,
} from "../incident-lifecycle";
import type { InvestigationTrace, TriageRun } from "../workflow";
import type { EvidenceDelta, MaterialityBasis, MaterialityDecision, MaterialityOutcome } from "../reentry";
import type { ExplanationValidation, TriageDecision, TriageExplanation } from "../llm";
import type { MitigationControlResult } from "../mitigation-control";
import type { SafetyResult } from "../policy";
import type { ProvenanceSummary } from "../evidence";

export type RetentionClass = "ephemeral" | "read_only_triage";

export interface PersistTriageRunOptions {
  correlationId?: string;
  retentionClass?: RetentionClass;
  now?: Date;
  ttlMs?: number;
}

export interface PersistedValidationSummary {
  valid: boolean;
  errors: string[];
}

export interface TriageRunReviewEnvelope {
  investigation?: InvestigationTrace;
  validation?: PersistedValidationSummary;
  explanation?: TriageExplanation;
  explanationValidation?: ExplanationValidation;
  decision?: TriageDecision;
  safety?: SafetyResult;
  mitigationControl?: MitigationControlResult;
  provenance?: ProvenanceSummary;
}

export interface TriageRunRecord {
  runId: string;
  incidentId: string;
  incidentTitle: string;
  severity: string;
  incidentStatus: string;
  startedAt: string;
  scenarioName: string;
  service: string;
  runStatus: string;
  validationStatus: "valid" | "invalid" | "not_available";
  safetyStatus?: string;
  mitigationStatus?: string;
  evidenceIds: string[];
  scorecard?: unknown;
  reviewEnvelope?: TriageRunReviewEnvelope;
  retentionClass: RetentionClass;
  correlationId: string;
  parentRunId?: string;
  gateDecisionId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface EvidenceSnapshotRecord {
  runId: string;
  incidentId: string;
  evidence: unknown[];
  missingContext: string[];
  retentionClass: RetentionClass;
  createdAt: string;
  expiresAt: string;
}

export interface TriageRunReviewRecord {
  run: TriageRunRecord;
  evidenceSnapshot?: EvidenceSnapshotRecord;
  gateDecision?: EvidenceGateDecisionRecord;
  parentRunRetained: boolean;
  recentGateDecisions: EvidenceGateDecisionRecord[];
}

export interface EvidenceGateCandidate {
  incidentId: string;
  canonicalizationVersion: string;
  candidateDigest: string;
  priorRunId?: string;
  delta: EvidenceDelta;
  decision: MaterialityDecision;
}

export interface EvidenceGateDecisionRecord {
  decisionId: string;
  incidentId: string;
  canonicalizationVersion: string;
  candidateDigest: string;
  baselineKey: string;
  priorRunId?: string;
  childRunId?: string;
  outcome: MaterialityOutcome;
  basis: MaterialityBasis;
  delta: EvidenceDelta;
  rationale: string;
  citedDeltaRefs: string[];
  retentionClass: RetentionClass;
  createdAt: string;
  expiresAt: string;
}

export interface EvidenceGateDecisionWriteResult {
  decision: EvidenceGateDecisionRecord;
  created: boolean;
}

export interface GatedTriageRunWriteResult extends EvidenceGateDecisionWriteResult {
  run: TriageRunRecord;
}

export interface IncidentBaseline {
  run: TriageRunRecord;
  evidenceSnapshot: EvidenceSnapshotRecord;
}

export interface IncidentBaselineLookupOptions {
  now?: Date;
}

export interface CleanupResult {
  incidentRunsDeleted: number;
  evidenceSnapshotsDeleted: number;
  evidenceGateDecisionsDeleted: number;
  replayKeysDeleted: number;
  verificationEventsDeleted: number;
  recoveryEventsDeleted: number;
  recoveryBudgetsDeleted: number;
  outcomeCandidatesDeleted: number;
}

export interface VerificationOutcomeRecord {
  eventId: string;
  incidentId: string;
  sourceEventKey: string;
  verification: VerificationOutcomeInput;
  retentionClass: RetentionClass;
  createdAt: string;
  expiresAt: string;
}

export interface VerificationOutcomeWriteInput {
  incidentId: string;
  sourceEventKey: string;
  verification: VerificationOutcomeInput;
}

export interface VerificationOutcomeWriteResult {
  record: VerificationOutcomeRecord;
  created: boolean;
}

export type RecoveryEventType = "attempt" | "exhausted" | "reset";

export interface RecoveryBudgetRecord {
  incidentId: string;
  failureClass: RecoveryFailureClass;
  attempts: number;
  limit: number;
  exhausted: boolean;
  generation: number;
  updatedAt: string;
  expiresAt: string;
}

export interface RecoveryEventRecord {
  eventId: string;
  incidentId: string;
  sourceEventKey: string;
  eventType: RecoveryEventType;
  failureClass: RecoveryFailureClass;
  runId?: string;
  attempt?: number;
  reason?: RecoveryResetReason;
  actor?: string;
  rationale: string;
  generation: number;
  retentionClass: RetentionClass;
  createdAt: string;
  expiresAt: string;
}

export interface RecoveryFailureWriteInput {
  incidentId: string;
  runId?: string;
  sourceEventKey: string;
  failureClass: RecoveryFailureClass;
  rationale: string;
}

export interface RecoveryResetWriteInput extends RecoveryFailureWriteInput {
  reason: RecoveryResetReason;
  actor: string;
}

export interface RecoveryWriteResult {
  event?: RecoveryEventRecord;
  budget: RecoveryBudgetRecord;
  created: boolean;
}

export type OutcomeReviewCandidateStatus = "pending" | "imported";

export interface OutcomeReviewCandidateInput {
  incidentId: string;
  runId?: string;
  sourceEventId: string;
  category: OutcomeCandidateCategory;
  rationale: string;
  evidenceIds: string[];
  snapshot: Record<string, unknown>;
}

export interface OutcomeReviewCandidateRecord extends OutcomeReviewCandidateInput {
  candidateId: string;
  status: OutcomeReviewCandidateStatus;
  retentionClass: RetentionClass;
  createdAt: string;
  expiresAt: string;
  importedAt?: string;
}

export interface OutcomeReviewCandidateWriteResult {
  candidate: OutcomeReviewCandidateRecord;
  created: boolean;
}

export interface IncidentLifecycleReviewRecord {
  incidentId: string;
  projection: IncidentLifecycleProjection;
  verificationEvents: VerificationOutcomeRecord[];
  recoveryEvents: RecoveryEventRecord[];
  recoveryBudgets: RecoveryBudgetRecord[];
  candidates: OutcomeReviewCandidateRecord[];
}

export interface ReplayKeyInput {
  sender: string;
  signature: string;
  timestamp: string;
  bodyDigest: string;
  receivedAt?: Date;
  ttlMs: number;
}

export interface ReplayKeyClaim {
  accepted: boolean;
  replayKey: string;
  expiresAt: string;
}

export interface TriageRunPersistenceStore {
  migrate?(): Promise<void>;
  recordTriageRun(run: TriageRun, options?: PersistTriageRunOptions): Promise<TriageRunRecord>;
  listTriageRuns(options?: { limit?: number }): Promise<TriageRunRecord[]>;
  getTriageRunReview(runId: string): Promise<TriageRunReviewRecord | undefined>;
  getLatestIncidentBaseline(
    incidentId: string,
    options?: IncidentBaselineLookupOptions,
  ): Promise<IncidentBaseline | undefined>;
  recordEvidenceGateDecision(
    candidate: EvidenceGateCandidate,
    options?: PersistTriageRunOptions,
  ): Promise<EvidenceGateDecisionWriteResult>;
  recordGatedTriageRun(
    run: TriageRun,
    candidate: EvidenceGateCandidate,
    options?: PersistTriageRunOptions,
  ): Promise<GatedTriageRunWriteResult>;
  recordVerificationOutcome(
    input: VerificationOutcomeWriteInput,
    options?: PersistTriageRunOptions,
  ): Promise<VerificationOutcomeWriteResult>;
  getIncidentLifecycle(incidentId: string): Promise<IncidentLifecycleReviewRecord>;
  recordRecoveryFailure(
    input: RecoveryFailureWriteInput,
    options?: PersistTriageRunOptions,
  ): Promise<RecoveryWriteResult>;
  resetRecoveryBudget(
    input: RecoveryResetWriteInput,
    options?: PersistTriageRunOptions,
  ): Promise<RecoveryWriteResult>;
  recordOutcomeReviewCandidate(
    input: OutcomeReviewCandidateInput,
    options?: PersistTriageRunOptions,
  ): Promise<OutcomeReviewCandidateWriteResult>;
  listOutcomeReviewCandidates(options?: {
    incidentId?: string;
    status?: OutcomeReviewCandidateStatus;
    limit?: number;
  }): Promise<OutcomeReviewCandidateRecord[]>;
  markOutcomeReviewCandidateImported(
    candidateId: string,
    options?: { now?: Date },
  ): Promise<OutcomeReviewCandidateRecord>;
  claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim>;
  releaseReplayKey(replayKey: string): Promise<void>;
  cleanupExpired(now?: Date): Promise<CleanupResult>;
  close?(): Promise<void>;
}
