import type { RecoveryFailureClass } from "../incident-lifecycle";
import type { TriageRun } from "../workflow";
import type {
  CleanupResult,
  EvidenceGateCandidate,
  EvidenceGateDecisionRecord,
  EvidenceGateDecisionWriteResult,
  EvidenceSnapshotRecord,
  GatedTriageRunWriteResult,
  IncidentBaseline,
  IncidentBaselineLookupOptions,
  IncidentLifecycleReviewRecord,
  OutcomeReviewCandidateInput,
  OutcomeReviewCandidateRecord,
  OutcomeReviewCandidateStatus,
  OutcomeReviewCandidateWriteResult,
  PersistTriageRunOptions,
  RecoveryBudgetRecord,
  RecoveryEventRecord,
  RecoveryFailureWriteInput,
  RecoveryResetWriteInput,
  RecoveryWriteResult,
  ReplayKeyClaim,
  ReplayKeyInput,
  TriageRunPersistenceStore,
  TriageRunRecord,
  TriageRunReviewRecord,
  VerificationOutcomeRecord,
  VerificationOutcomeWriteInput,
  VerificationOutcomeWriteResult,
} from "./contracts";
import {
  boundedLimit,
  buildEvidenceSnapshot,
  buildGateDecisionRecord,
  buildIncidentLifecycleReview,
  buildOutcomeCandidate,
  buildRecoveryEvent,
  buildReplayKey,
  buildRunRecord,
  buildVerificationRecord,
  candidateFromRecoveryExhaustion,
  candidateFromVerification,
  gateDecisionKey,
  gateDecisionRecordKey,
  initialRecoveryBudget,
  iso,
  outcomeCandidateKey,
  recoveryBudgetKey,
  recoverySourceKey,
  verificationSourceKey,
} from "./record-mapping";

export class InMemoryTriageRunPersistenceStore implements TriageRunPersistenceStore {
  readonly runs = new Map<string, TriageRunRecord>();
  readonly evidenceSnapshots = new Map<string, EvidenceSnapshotRecord>();
  readonly evidenceGateDecisions = new Map<string, EvidenceGateDecisionRecord>();
  readonly replayKeys = new Map<string, { input: ReplayKeyInput; expiresAt: string }>();
  readonly verificationEvents = new Map<string, VerificationOutcomeRecord>();
  readonly recoveryEvents = new Map<string, RecoveryEventRecord>();
  readonly recoveryBudgets = new Map<string, RecoveryBudgetRecord>();
  readonly outcomeCandidates = new Map<string, OutcomeReviewCandidateRecord>();
  private readonly evidenceGateDecisionKeys = new Map<string, string>();
  private readonly verificationEventKeys = new Map<string, string>();
  private readonly recoveryEventKeys = new Map<string, string>();
  private readonly outcomeCandidateKeys = new Map<string, string>();

  async recordTriageRun(run: TriageRun, options: PersistTriageRunOptions = {}): Promise<TriageRunRecord> {
    const record = buildRunRecord(run, options);
    const snapshot = buildEvidenceSnapshot(run, record, options);
    this.runs.set(record.runId, record);
    this.evidenceSnapshots.set(record.runId, snapshot);
    return record;
  }

  async getTriageRunReview(runId: string): Promise<TriageRunReviewRecord | undefined> {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    const evidenceSnapshot = this.evidenceSnapshots.get(runId);
    const gateDecision = run.gateDecisionId ? this.evidenceGateDecisions.get(run.gateDecisionId) : undefined;
    const recentGateDecisions = this.recentDecisions(run.incidentId);
    return {
      run,
      ...(evidenceSnapshot ? { evidenceSnapshot } : {}),
      ...(gateDecision ? { gateDecision } : {}),
      parentRunRetained: run.parentRunId ? this.runs.has(run.parentRunId) : false,
      recentGateDecisions,
    };
  }

  async getLatestIncidentBaseline(
    incidentId: string,
    options: IncidentBaselineLookupOptions = {},
  ): Promise<IncidentBaseline | undefined> {
    const cutoff = (options.now ?? new Date()).toISOString();
    const run = [...this.runs.values()]
      .filter((candidate) => {
        const snapshot = this.evidenceSnapshots.get(candidate.runId);
        return candidate.incidentId === incidentId
          && candidate.expiresAt > cutoff
          && snapshot !== undefined
          && snapshot.expiresAt > cutoff;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!run) {
      return undefined;
    }
    return { run, evidenceSnapshot: this.evidenceSnapshots.get(run.runId)! };
  }

  async recordEvidenceGateDecision(
    candidate: EvidenceGateCandidate,
    options: PersistTriageRunOptions = {},
  ): Promise<EvidenceGateDecisionWriteResult> {
    const key = gateDecisionKey(candidate);
    const existingId = this.evidenceGateDecisionKeys.get(key);
    if (existingId) {
      return { decision: this.requiredDecision(existingId), created: false };
    }
    const decision = buildGateDecisionRecord(candidate, options);
    this.evidenceGateDecisions.set(decision.decisionId, decision);
    this.evidenceGateDecisionKeys.set(key, decision.decisionId);
    return { decision, created: true };
  }

  async recordGatedTriageRun(
    run: TriageRun,
    candidate: EvidenceGateCandidate,
    options: PersistTriageRunOptions = {},
  ): Promise<GatedTriageRunWriteResult> {
    const key = gateDecisionKey(candidate);
    const existingId = this.evidenceGateDecisionKeys.get(key);
    if (existingId) {
      const decision = this.requiredDecision(existingId);
      const existingRun = decision.childRunId ? this.runs.get(decision.childRunId) : undefined;
      if (!existingRun) {
        throw new Error(`Gate decision ${decision.decisionId} has no persisted child run.`);
      }
      return { run: existingRun, decision, created: false };
    }

    const decision = buildGateDecisionRecord(candidate, options, run.runId);
    const record = buildRunRecord(run, options, {
      ...(candidate.priorRunId ? { parentRunId: candidate.priorRunId } : {}),
      gateDecisionId: decision.decisionId,
    });
    const snapshot = buildEvidenceSnapshot(run, record, options);
    this.evidenceGateDecisions.set(decision.decisionId, decision);
    this.evidenceGateDecisionKeys.set(key, decision.decisionId);
    this.runs.set(record.runId, record);
    this.evidenceSnapshots.set(record.runId, snapshot);
    return { run: record, decision, created: true };
  }

  async listTriageRuns(options: { limit?: number } = {}): Promise<TriageRunRecord[]> {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit(options.limit));
  }

  async recordVerificationOutcome(
    input: VerificationOutcomeWriteInput,
    options: PersistTriageRunOptions = {},
  ): Promise<VerificationOutcomeWriteResult> {
    const sourceKey = verificationSourceKey(input.incidentId, input.sourceEventKey);
    const existingId = this.verificationEventKeys.get(sourceKey);
    if (existingId) {
      return { record: requiredMapValue(this.verificationEvents, existingId, "verification event"), created: false };
    }
    const record = buildVerificationRecord(input, options);
    this.verificationEvents.set(record.eventId, record);
    this.verificationEventKeys.set(sourceKey, record.eventId);
    if (record.verification.outcome === "unresolved") {
      await this.recordOutcomeReviewCandidate(candidateFromVerification(record), options);
    }
    return { record, created: true };
  }

  async getIncidentLifecycle(incidentId: string): Promise<IncidentLifecycleReviewRecord> {
    const verificationEvents = filterIncidentRecords(this.verificationEvents, incidentId);
    const recoveryEvents = filterIncidentRecords(this.recoveryEvents, incidentId);
    return buildIncidentLifecycleReview(
      incidentId,
      verificationEvents,
      recoveryEvents,
      filterIncidentRecords(this.recoveryBudgets, incidentId),
      filterIncidentRecords(this.outcomeCandidates, incidentId),
    );
  }

  async recordRecoveryFailure(
    input: RecoveryFailureWriteInput,
    options: PersistTriageRunOptions = {},
  ): Promise<RecoveryWriteResult> {
    const sourceKey = recoverySourceKey(input.incidentId, input.failureClass, input.sourceEventKey);
    const existingId = this.recoveryEventKeys.get(sourceKey);
    if (existingId) {
      const event = requiredMapValue(this.recoveryEvents, existingId, "recovery event");
      return { event, budget: this.requiredBudget(input.incidentId, input.failureClass), created: false };
    }
    const key = recoveryBudgetKey(input.incidentId, input.failureClass);
    const budget = this.recoveryBudgets.get(key) ?? initialRecoveryBudget(input, options);
    if (budget.exhausted) {
      return { budget, created: false };
    }
    const attempt = budget.attempts + 1;
    const event = buildRecoveryEvent(input, "attempt", budget.generation, options, { attempt });
    const nextBudget: RecoveryBudgetRecord = {
      ...budget,
      attempts: attempt,
      exhausted: attempt >= budget.limit,
      updatedAt: event.createdAt,
      expiresAt: event.expiresAt,
    };
    this.recoveryEvents.set(event.eventId, event);
    this.recoveryEventKeys.set(sourceKey, event.eventId);
    this.recoveryBudgets.set(key, nextBudget);
    if (nextBudget.exhausted) {
      const exhausted = buildRecoveryEvent(
        { ...input, sourceEventKey: `${input.sourceEventKey}:exhausted` },
        "exhausted",
        budget.generation,
        options,
        { attempt },
      );
      this.recoveryEvents.set(exhausted.eventId, exhausted);
      this.recoveryEventKeys.set(
        recoverySourceKey(exhausted.incidentId, exhausted.failureClass, exhausted.sourceEventKey),
        exhausted.eventId,
      );
      await this.recordOutcomeReviewCandidate(candidateFromRecoveryExhaustion(exhausted), options);
    }
    return { event, budget: nextBudget, created: true };
  }

  async resetRecoveryBudget(
    input: RecoveryResetWriteInput,
    options: PersistTriageRunOptions = {},
  ): Promise<RecoveryWriteResult> {
    const sourceKey = recoverySourceKey(input.incidentId, input.failureClass, input.sourceEventKey);
    const existingId = this.recoveryEventKeys.get(sourceKey);
    if (existingId) {
      const event = requiredMapValue(this.recoveryEvents, existingId, "recovery event");
      return { event, budget: this.requiredBudget(input.incidentId, input.failureClass), created: false };
    }
    const key = recoveryBudgetKey(input.incidentId, input.failureClass);
    const prior = this.recoveryBudgets.get(key) ?? initialRecoveryBudget(input, options);
    const generation = prior.generation + 1;
    const event = buildRecoveryEvent(input, "reset", generation, options, {
      reason: input.reason,
      actor: input.actor,
    });
    const budget: RecoveryBudgetRecord = {
      ...prior,
      attempts: 0,
      exhausted: false,
      generation,
      updatedAt: event.createdAt,
      expiresAt: event.expiresAt,
    };
    this.recoveryEvents.set(event.eventId, event);
    this.recoveryEventKeys.set(sourceKey, event.eventId);
    this.recoveryBudgets.set(key, budget);
    return { event, budget, created: true };
  }

  async recordOutcomeReviewCandidate(
    input: OutcomeReviewCandidateInput,
    options: PersistTriageRunOptions = {},
  ): Promise<OutcomeReviewCandidateWriteResult> {
    const key = outcomeCandidateKey(input);
    const existingId = this.outcomeCandidateKeys.get(key);
    if (existingId) {
      return { candidate: requiredMapValue(this.outcomeCandidates, existingId, "outcome candidate"), created: false };
    }
    const candidate = buildOutcomeCandidate(input, options);
    this.outcomeCandidates.set(candidate.candidateId, candidate);
    this.outcomeCandidateKeys.set(key, candidate.candidateId);
    return { candidate, created: true };
  }

  async listOutcomeReviewCandidates(options: {
    incidentId?: string;
    status?: OutcomeReviewCandidateStatus;
    limit?: number;
  } = {}): Promise<OutcomeReviewCandidateRecord[]> {
    return [...this.outcomeCandidates.values()]
      .filter((candidate) => options.incidentId === undefined || candidate.incidentId === options.incidentId)
      .filter((candidate) => options.status === undefined || candidate.status === options.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit(options.limit));
  }

  async markOutcomeReviewCandidateImported(
    candidateId: string,
    options: { now?: Date } = {},
  ): Promise<OutcomeReviewCandidateRecord> {
    const candidate = requiredMapValue(this.outcomeCandidates, candidateId, "outcome candidate");
    if (candidate.status === "imported") {
      return candidate;
    }
    const imported = { ...candidate, status: "imported" as const, importedAt: iso(options.now ?? new Date()) };
    this.outcomeCandidates.set(candidateId, imported);
    return imported;
  }

  async claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim> {
    const replayKey = buildReplayKey(input);
    const receivedAt = input.receivedAt ?? new Date();
    const expiresAt = iso(new Date(receivedAt.getTime() + input.ttlMs));
    const existing = this.replayKeys.get(replayKey);
    if (existing && existing.expiresAt > receivedAt.toISOString()) {
      return { accepted: false, replayKey, expiresAt };
    }
    this.replayKeys.set(replayKey, { input, expiresAt });
    return { accepted: true, replayKey, expiresAt };
  }

  async releaseReplayKey(replayKey: string): Promise<void> {
    this.replayKeys.delete(replayKey);
  }

  async cleanupExpired(now = new Date()): Promise<CleanupResult> {
    const cutoff = now.toISOString();
    let incidentRunsDeleted = 0;
    let evidenceSnapshotsDeleted = 0;
    let evidenceGateDecisionsDeleted = 0;
    let replayKeysDeleted = 0;
    let verificationEventsDeleted = 0;
    let recoveryEventsDeleted = 0;
    let recoveryBudgetsDeleted = 0;
    let outcomeCandidatesDeleted = 0;
    for (const [runId, run] of this.runs.entries()) {
      if (run.expiresAt <= cutoff) {
        this.runs.delete(runId);
        incidentRunsDeleted += 1;
      }
    }
    for (const [runId, snapshot] of this.evidenceSnapshots.entries()) {
      if (snapshot.expiresAt <= cutoff) {
        this.evidenceSnapshots.delete(runId);
        evidenceSnapshotsDeleted += 1;
      }
    }
    for (const [decisionId, decision] of this.evidenceGateDecisions.entries()) {
      if (decision.expiresAt <= cutoff) {
        this.evidenceGateDecisions.delete(decisionId);
        this.evidenceGateDecisionKeys.delete(gateDecisionRecordKey(decision));
        evidenceGateDecisionsDeleted += 1;
      }
    }
    for (const [replayKey, record] of this.replayKeys.entries()) {
      if (record.expiresAt <= cutoff) {
        this.replayKeys.delete(replayKey);
        replayKeysDeleted += 1;
      }
    }
    for (const [eventId, record] of this.verificationEvents.entries()) {
      if (record.expiresAt <= cutoff) {
        this.verificationEvents.delete(eventId);
        this.verificationEventKeys.delete(verificationSourceKey(record.incidentId, record.sourceEventKey));
        verificationEventsDeleted += 1;
      }
    }
    for (const [eventId, record] of this.recoveryEvents.entries()) {
      if (record.expiresAt <= cutoff) {
        this.recoveryEvents.delete(eventId);
        this.recoveryEventKeys.delete(recoverySourceKey(record.incidentId, record.failureClass, record.sourceEventKey));
        recoveryEventsDeleted += 1;
      }
    }
    for (const [key, record] of this.recoveryBudgets.entries()) {
      if (record.expiresAt <= cutoff) {
        this.recoveryBudgets.delete(key);
        recoveryBudgetsDeleted += 1;
      }
    }
    for (const [candidateId, record] of this.outcomeCandidates.entries()) {
      if (record.expiresAt <= cutoff) {
        this.outcomeCandidates.delete(candidateId);
        this.outcomeCandidateKeys.delete(outcomeCandidateKey(record));
        outcomeCandidatesDeleted += 1;
      }
    }
    return {
      incidentRunsDeleted,
      evidenceSnapshotsDeleted,
      evidenceGateDecisionsDeleted,
      replayKeysDeleted,
      verificationEventsDeleted,
      recoveryEventsDeleted,
      recoveryBudgetsDeleted,
      outcomeCandidatesDeleted,
    };
  }

  private recentDecisions(incidentId: string): EvidenceGateDecisionRecord[] {
    return [...this.evidenceGateDecisions.values()]
      .filter((decision) => decision.incidentId === incidentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20);
  }

  private requiredDecision(decisionId: string): EvidenceGateDecisionRecord {
    const decision = this.evidenceGateDecisions.get(decisionId);
    if (!decision) {
      throw new Error(`Missing gate decision: ${decisionId}`);
    }
    return decision;
  }

  private requiredBudget(incidentId: string, failureClass: RecoveryFailureClass): RecoveryBudgetRecord {
    return requiredMapValue(this.recoveryBudgets, recoveryBudgetKey(incidentId, failureClass), "recovery budget");
  }
}

function filterIncidentRecords<T extends { incidentId: string; createdAt?: string; updatedAt?: string }>(
  records: Map<string, T>,
  incidentId: string,
): T[] {
  return [...records.values()]
    .filter((record) => record.incidentId === incidentId)
    .sort((left, right) => (left.createdAt ?? left.updatedAt ?? "").localeCompare(right.createdAt ?? right.updatedAt ?? ""));
}

function requiredMapValue<T>(records: Map<string, T>, key: string, label: string): T {
  const record = records.get(key);
  if (!record) {
    throw new Error(`Missing ${label}: ${key}`);
  }
  return record;
}
