import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

import {
  applyLifecycleEvent,
  initialLifecycleProjection,
  type IncidentLifecycleEvent,
  type IncidentLifecycleProjection,
  type OutcomeCandidateCategory,
  type RecoveryFailureClass,
  type RecoveryResetReason,
  type VerificationOutcomeInput,
} from "../incident-lifecycle";
import type { ProvenanceSummary } from "../evidence";
import type { ExplanationValidation, TriageDecision, TriageExplanation } from "../llm";
import type { MitigationControlResult } from "../mitigation-control";
import type { SafetyResult } from "../policy";
import type { EvidenceDelta, MaterialityBasis, MaterialityDecision, MaterialityOutcome } from "../reentry";
import type { InvestigationTrace, TriageRun } from "../workflow";
import { decodeTriageRunReviewEnvelope } from "./postgres-row-mapping";

export type RetentionClass = "ephemeral" | "read_only_triage";

export interface PersistTriageRunOptions {
  correlationId?: string;
  retentionClass?: RetentionClass;
  now?: Date;
  ttlMs?: number;
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

export interface TriageRunReviewEnvelope {
  investigation?: InvestigationTrace;
  validation?: { valid: boolean; errors: string[] };
  explanation?: TriageExplanation;
  explanationValidation?: ExplanationValidation;
  decision?: TriageDecision;
  safety?: SafetyResult;
  mitigationControl?: MitigationControlResult;
  provenance?: ProvenanceSummary;
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

const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;

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
    const lifecycleEvents = [
      ...verificationEvents.map(verificationLifecycleEvent),
      ...recoveryEvents.map(recoveryLifecycleEvent),
    ].sort(compareLifecycleEvents);
    const projection = lifecycleEvents.reduce(
      applyLifecycleEvent,
      initialLifecycleProjection({ incidentId }),
    );
    return {
      incidentId,
      projection,
      verificationEvents,
      recoveryEvents,
      recoveryBudgets: filterIncidentRecords(this.recoveryBudgets, incidentId),
      candidates: filterIncidentRecords(this.outcomeCandidates, incidentId),
    };
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

export class PostgresTriageRunPersistenceStore implements TriageRunPersistenceStore {
  private readonly pool: Pool;

  constructor(config: { connectionString: string; queryTimeoutMs?: number; lockTimeoutMs?: number }) {
    const queryTimeoutMs = config.queryTimeoutMs ?? 10_000;
    this.pool = new Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      max: 5,
      allowExitOnIdle: true,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      lock_timeout: config.lockTimeoutMs ?? 5_000,
    });
  }

  async migrate(): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["incident-triage-agent:migrations"]);
      await ensureMigrationLedger(client);
      for (const migration of readMigrations()) {
        const applied = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE migration_name = $1",
          [migration.name],
        );
        if (applied.rows[0]?.checksum === migration.checksum) {
          continue;
        }
        if (applied.rows[0]) {
          throw new Error(`Migration checksum changed after application: ${migration.name}`);
        }
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (migration_name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
      }
    });
  }

  async recordTriageRun(run: TriageRun, options: PersistTriageRunOptions = {}): Promise<TriageRunRecord> {
    const record = buildRunRecord(run, options);
    const snapshot = buildEvidenceSnapshot(run, record, options);
    await this.withTransaction(async (client) => {
      await upsertRunRecord(client, record);
      await upsertEvidenceSnapshot(client, snapshot);
    });
    return record;
  }

  async getTriageRunReview(runId: string): Promise<TriageRunReviewRecord | undefined> {
    const result = await this.pool.query<RunRecordRow & {
      parent_run_retained: boolean;
      snapshot_evidence: unknown[] | null;
      snapshot_missing_context: string[] | null;
      snapshot_retention_class: RetentionClass | null;
      snapshot_created_at: Date | string | null;
      snapshot_expires_at: Date | string | null;
    }>(
      `SELECT
        runs.run_id, runs.incident_id, runs.scenario_name, runs.service, runs.run_status,
        runs.incident_title, runs.severity, runs.incident_status, runs.started_at,
        runs.validation_status, runs.safety_status, runs.mitigation_status, runs.evidence_ids,
        runs.scorecard, runs.review_envelope, runs.retention_class, runs.correlation_id,
        runs.parent_run_id, runs.gate_decision_id,
        EXISTS (
          SELECT 1 FROM incident_runs parent WHERE parent.run_id = runs.parent_run_id
        ) AS parent_run_retained,
        runs.created_at, runs.expires_at,
        snapshots.evidence AS snapshot_evidence,
        snapshots.missing_context AS snapshot_missing_context,
        snapshots.retention_class AS snapshot_retention_class,
        snapshots.created_at AS snapshot_created_at,
        snapshots.expires_at AS snapshot_expires_at
       FROM incident_runs runs
       LEFT JOIN evidence_snapshots snapshots ON snapshots.run_id = runs.run_id
       WHERE runs.run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const run = runRecordFromRow(row);
    const decisions = await this.listGateDecisions(run.incidentId);
    const gateDecision = run.gateDecisionId
      ? decisions.find((decision) => decision.decisionId === run.gateDecisionId)
      : undefined;
    if (!row.snapshot_evidence) {
      return {
        run,
        ...(gateDecision ? { gateDecision } : {}),
        parentRunRetained: row.parent_run_retained,
        recentGateDecisions: decisions,
      };
    }
    return {
      run,
      evidenceSnapshot: {
        runId: row.run_id,
        incidentId: row.incident_id,
        evidence: row.snapshot_evidence,
        missingContext: row.snapshot_missing_context ?? [],
        retentionClass: row.snapshot_retention_class ?? row.retention_class,
        createdAt: row.snapshot_created_at ? isoValue(row.snapshot_created_at) : run.createdAt,
        expiresAt: row.snapshot_expires_at ? isoValue(row.snapshot_expires_at) : run.expiresAt,
      },
      ...(gateDecision ? { gateDecision } : {}),
      parentRunRetained: row.parent_run_retained,
      recentGateDecisions: decisions,
    };
  }

  async getLatestIncidentBaseline(
    incidentId: string,
    options: IncidentBaselineLookupOptions = {},
  ): Promise<IncidentBaseline | undefined> {
    const cutoff = (options.now ?? new Date()).toISOString();
    const result = await this.pool.query<RunRecordRow & {
      snapshot_evidence: unknown[];
      snapshot_missing_context: string[];
      snapshot_retention_class: RetentionClass;
      snapshot_created_at: Date | string;
      snapshot_expires_at: Date | string;
    }>(
      `SELECT
        runs.run_id, runs.incident_id, runs.scenario_name, runs.service, runs.run_status,
        runs.incident_title, runs.severity, runs.incident_status, runs.started_at,
        runs.validation_status, runs.safety_status, runs.mitigation_status, runs.evidence_ids,
        runs.scorecard, runs.review_envelope, runs.retention_class, runs.correlation_id,
        runs.parent_run_id, runs.gate_decision_id, runs.created_at, runs.expires_at,
        snapshots.evidence AS snapshot_evidence,
        snapshots.missing_context AS snapshot_missing_context,
        snapshots.retention_class AS snapshot_retention_class,
        snapshots.created_at AS snapshot_created_at,
        snapshots.expires_at AS snapshot_expires_at
       FROM incident_runs runs
       INNER JOIN evidence_snapshots snapshots ON snapshots.run_id = runs.run_id
       WHERE runs.incident_id = $1
         AND runs.expires_at > $2
         AND snapshots.expires_at > $2
       ORDER BY runs.created_at DESC
       LIMIT 1`,
      [incidentId, cutoff],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const run = runRecordFromRow(row);
    return {
      run,
      evidenceSnapshot: {
        runId: row.run_id,
        incidentId: row.incident_id,
        evidence: row.snapshot_evidence,
        missingContext: row.snapshot_missing_context,
        retentionClass: row.snapshot_retention_class,
        createdAt: isoValue(row.snapshot_created_at),
        expiresAt: isoValue(row.snapshot_expires_at),
      },
    };
  }

  async recordEvidenceGateDecision(
    candidate: EvidenceGateCandidate,
    options: PersistTriageRunOptions = {},
  ): Promise<EvidenceGateDecisionWriteResult> {
    const record = buildGateDecisionRecord(candidate, options);
    const inserted = await this.pool.query<EvidenceGateDecisionRow>(
      `${insertGateDecisionSql()} ON CONFLICT (incident_id, baseline_key, candidate_digest) DO NOTHING
       RETURNING *`,
      gateDecisionValues(record),
    );
    if (inserted.rows[0]) {
      return { decision: gateDecisionFromRow(inserted.rows[0]), created: true };
    }
    return { decision: await this.requiredGateDecision(candidate), created: false };
  }

  async recordGatedTriageRun(
    run: TriageRun,
    candidate: EvidenceGateCandidate,
    options: PersistTriageRunOptions = {},
  ): Promise<GatedTriageRunWriteResult> {
    return this.withTransaction(async (client) => {
      const decision = buildGateDecisionRecord(candidate, options, run.runId);
      const inserted = await client.query<EvidenceGateDecisionRow>(
        `${insertGateDecisionSql()} ON CONFLICT (incident_id, baseline_key, candidate_digest) DO NOTHING
         RETURNING *`,
        gateDecisionValues(decision),
      );
      if (!inserted.rows[0]) {
        const existing = await selectGateDecision(client, candidate);
        if (!existing.childRunId) {
          throw new Error(`Gate decision ${existing.decisionId} has no persisted child run.`);
        }
        const existingRun = await selectRunRecord(client, existing.childRunId);
        if (!existingRun) {
          throw new Error(`Gate decision ${existing.decisionId} references a missing child run.`);
        }
        return { run: existingRun, decision: existing, created: false };
      }

      const persistedDecision = gateDecisionFromRow(inserted.rows[0]);
      const record = buildRunRecord(run, options, {
        ...(candidate.priorRunId ? { parentRunId: candidate.priorRunId } : {}),
        gateDecisionId: persistedDecision.decisionId,
      });
      const snapshot = buildEvidenceSnapshot(run, record, options);
      await upsertRunRecord(client, record);
      await upsertEvidenceSnapshot(client, snapshot);
      return { run: record, decision: persistedDecision, created: true };
    });
  }

  async listTriageRuns(options: { limit?: number } = {}): Promise<TriageRunRecord[]> {
    const result = await this.pool.query<RunRecordRow>(
      `SELECT
        run_id, incident_id, incident_title, severity, incident_status, started_at,
        scenario_name, service, run_status, validation_status, safety_status,
        mitigation_status, evidence_ids, scorecard, retention_class,
        correlation_id, parent_run_id, gate_decision_id, created_at, expires_at
       FROM incident_runs
       ORDER BY created_at DESC
       LIMIT $1`,
      [boundedLimit(options.limit)],
    );
    return result.rows.map(runRecordFromRow);
  }

  async recordVerificationOutcome(
    input: VerificationOutcomeWriteInput,
    options: PersistTriageRunOptions = {},
  ): Promise<VerificationOutcomeWriteResult> {
    return this.withTransaction(async (client) => {
      const record = buildVerificationRecord(input, options);
      const inserted = await insertVerificationRecord(client, record);
      if (!inserted) {
        return {
          record: await selectVerificationBySourceKey(client, input.incidentId, input.sourceEventKey),
          created: false,
        };
      }
      if (record.verification.outcome === "unresolved") {
        await insertOutcomeCandidate(client, buildOutcomeCandidate(candidateFromVerification(record), options));
      }
      return { record, created: true };
    });
  }

  async getIncidentLifecycle(incidentId: string): Promise<IncidentLifecycleReviewRecord> {
    const [verification, recovery, budgets, candidates] = await Promise.all([
      this.pool.query<VerificationOutcomeRow>(
        "SELECT * FROM incident_verification_events WHERE incident_id = $1 ORDER BY created_at",
        [incidentId],
      ),
      this.pool.query<RecoveryEventRow>(
        "SELECT * FROM incident_recovery_events WHERE incident_id = $1 ORDER BY created_at, event_id",
        [incidentId],
      ),
      this.pool.query<RecoveryBudgetRow>(
        "SELECT * FROM incident_recovery_budgets WHERE incident_id = $1 ORDER BY failure_class",
        [incidentId],
      ),
      this.pool.query<OutcomeReviewCandidateRow>(
        "SELECT * FROM outcome_review_candidates WHERE incident_id = $1 ORDER BY created_at",
        [incidentId],
      ),
    ]);
    const verificationEvents = verification.rows.map(verificationFromRow);
    const recoveryEvents = recovery.rows.map(recoveryEventFromRow);
    const lifecycleEvents = [
      ...verificationEvents.map(verificationLifecycleEvent),
      ...recoveryEvents.map(recoveryLifecycleEvent),
    ].sort(compareLifecycleEvents);
    return {
      incidentId,
      projection: lifecycleEvents.reduce(applyLifecycleEvent, initialLifecycleProjection({ incidentId })),
      verificationEvents,
      recoveryEvents,
      recoveryBudgets: budgets.rows.map(recoveryBudgetFromRow),
      candidates: candidates.rows.map(outcomeCandidateFromRow),
    };
  }

  async recordRecoveryFailure(
    input: RecoveryFailureWriteInput,
    options: PersistTriageRunOptions = {},
  ): Promise<RecoveryWriteResult> {
    return this.withTransaction(async (client) => {
      await lockRecoveryBudget(client, input.incidentId, input.failureClass);
      const existing = await findRecoveryBySourceKey(
        client,
        input.incidentId,
        input.failureClass,
        input.sourceEventKey,
      );
      if (existing) {
        return {
          event: existing,
          budget: await requiredRecoveryBudget(client, input.incidentId, input.failureClass),
          created: false,
        };
      }
      const prior = await findRecoveryBudget(client, input.incidentId, input.failureClass)
        ?? initialRecoveryBudget(input, options);
      if (prior.exhausted) {
        return { budget: prior, created: false };
      }
      const attempt = prior.attempts + 1;
      const event = buildRecoveryEvent(input, "attempt", prior.generation, options, { attempt });
      const budget: RecoveryBudgetRecord = {
        ...prior,
        attempts: attempt,
        exhausted: attempt >= prior.limit,
        updatedAt: event.createdAt,
        expiresAt: event.expiresAt,
      };
      await insertRecoveryEvent(client, event);
      await upsertRecoveryBudget(client, budget);
      if (budget.exhausted) {
        const exhausted = buildRecoveryEvent(
          { ...input, sourceEventKey: `${input.sourceEventKey}:exhausted` },
          "exhausted",
          prior.generation,
          options,
          { attempt },
        );
        await insertRecoveryEvent(client, exhausted);
        await insertOutcomeCandidate(
          client,
          buildOutcomeCandidate(candidateFromRecoveryExhaustion(exhausted), options),
        );
      }
      return { event, budget, created: true };
    });
  }

  async resetRecoveryBudget(
    input: RecoveryResetWriteInput,
    options: PersistTriageRunOptions = {},
  ): Promise<RecoveryWriteResult> {
    return this.withTransaction(async (client) => {
      await lockRecoveryBudget(client, input.incidentId, input.failureClass);
      const existing = await findRecoveryBySourceKey(
        client,
        input.incidentId,
        input.failureClass,
        input.sourceEventKey,
      );
      if (existing) {
        return {
          event: existing,
          budget: await requiredRecoveryBudget(client, input.incidentId, input.failureClass),
          created: false,
        };
      }
      const prior = await findRecoveryBudget(client, input.incidentId, input.failureClass)
        ?? initialRecoveryBudget(input, options);
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
      await insertRecoveryEvent(client, event);
      await upsertRecoveryBudget(client, budget);
      return { event, budget, created: true };
    });
  }

  async recordOutcomeReviewCandidate(
    input: OutcomeReviewCandidateInput,
    options: PersistTriageRunOptions = {},
  ): Promise<OutcomeReviewCandidateWriteResult> {
    const candidate = buildOutcomeCandidate(input, options);
    const inserted = await this.withTransaction((client) => insertOutcomeCandidate(client, candidate));
    if (inserted) {
      return { candidate, created: true };
    }
    return { candidate: await this.requiredOutcomeCandidate(input), created: false };
  }

  async listOutcomeReviewCandidates(options: {
    incidentId?: string;
    status?: OutcomeReviewCandidateStatus;
    limit?: number;
  } = {}): Promise<OutcomeReviewCandidateRecord[]> {
    const result = await this.pool.query<OutcomeReviewCandidateRow>(
      `SELECT * FROM outcome_review_candidates
       WHERE ($1::text IS NULL OR incident_id = $1)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [options.incidentId ?? null, options.status ?? null, boundedLimit(options.limit)],
    );
    return result.rows.map(outcomeCandidateFromRow);
  }

  async markOutcomeReviewCandidateImported(
    candidateId: string,
    options: { now?: Date } = {},
  ): Promise<OutcomeReviewCandidateRecord> {
    const result = await this.pool.query<OutcomeReviewCandidateRow>(
      `UPDATE outcome_review_candidates
       SET status = 'imported', imported_at = COALESCE(imported_at, $2)
       WHERE candidate_id = $1
       RETURNING *`,
      [candidateId, iso(options.now ?? new Date())],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Missing outcome candidate: ${candidateId}`);
    }
    return outcomeCandidateFromRow(row);
  }

  async claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim> {
    const replayKey = buildReplayKey(input);
    const receivedAt = input.receivedAt ?? new Date();
    const expiresAt = iso(new Date(receivedAt.getTime() + input.ttlMs));
    const result = await this.pool.query(
      `INSERT INTO replay_keys (replay_key, sender, signature, timestamp, body_digest, received_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (replay_key) DO UPDATE SET
         sender = EXCLUDED.sender,
         signature = EXCLUDED.signature,
         timestamp = EXCLUDED.timestamp,
         body_digest = EXCLUDED.body_digest,
         received_at = EXCLUDED.received_at,
         expires_at = EXCLUDED.expires_at
       WHERE replay_keys.expires_at <= EXCLUDED.received_at
       RETURNING replay_key`,
      [replayKey, input.sender, input.signature, input.timestamp, input.bodyDigest, receivedAt.toISOString(), expiresAt],
    );
    return { accepted: result.rowCount === 1, replayKey, expiresAt };
  }

  async releaseReplayKey(replayKey: string): Promise<void> {
    await this.pool.query("DELETE FROM replay_keys WHERE replay_key = $1", [replayKey]);
  }

  async cleanupExpired(now = new Date()): Promise<CleanupResult> {
    const cutoff = now.toISOString();
    return this.withTransaction(async (client) => {
      const candidates = await client.query("DELETE FROM outcome_review_candidates WHERE expires_at <= $1", [cutoff]);
      const recoveryEvents = await client.query("DELETE FROM incident_recovery_events WHERE expires_at <= $1", [cutoff]);
      const verificationEvents = await client.query("DELETE FROM incident_verification_events WHERE expires_at <= $1", [cutoff]);
      const recoveryBudgets = await client.query("DELETE FROM incident_recovery_budgets WHERE expires_at <= $1", [cutoff]);
      const evidence = await client.query("DELETE FROM evidence_snapshots WHERE expires_at <= $1", [cutoff]);
      const runs = await client.query("DELETE FROM incident_runs WHERE expires_at <= $1", [cutoff]);
      const decisions = await client.query("DELETE FROM evidence_gate_decisions WHERE expires_at <= $1", [cutoff]);
      const replay = await client.query("DELETE FROM replay_keys WHERE expires_at <= $1", [cutoff]);
      return {
        incidentRunsDeleted: runs.rowCount ?? 0,
        evidenceSnapshotsDeleted: evidence.rowCount ?? 0,
        evidenceGateDecisionsDeleted: decisions.rowCount ?? 0,
        replayKeysDeleted: replay.rowCount ?? 0,
        verificationEventsDeleted: verificationEvents.rowCount ?? 0,
        recoveryEventsDeleted: recoveryEvents.rowCount ?? 0,
        recoveryBudgetsDeleted: recoveryBudgets.rowCount ?? 0,
        outcomeCandidatesDeleted: candidates.rowCount ?? 0,
      };
    });
  }

  private async listGateDecisions(incidentId: string): Promise<EvidenceGateDecisionRecord[]> {
    const result = await this.pool.query<EvidenceGateDecisionRow>(
      `SELECT * FROM evidence_gate_decisions
       WHERE incident_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [incidentId],
    );
    return result.rows.map(gateDecisionFromRow);
  }

  private async requiredGateDecision(candidate: EvidenceGateCandidate): Promise<EvidenceGateDecisionRecord> {
    const result = await this.pool.query<EvidenceGateDecisionRow>(
      `SELECT * FROM evidence_gate_decisions
       WHERE incident_id = $1 AND baseline_key = $2 AND candidate_digest = $3`,
      [candidate.incidentId, baselineKey(candidate), candidate.candidateDigest],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Gate decision conflict could not be read after insert.");
    }
    return gateDecisionFromRow(row);
  }

  private async requiredOutcomeCandidate(input: OutcomeReviewCandidateInput): Promise<OutcomeReviewCandidateRecord> {
    const result = await this.pool.query<OutcomeReviewCandidateRow>(
      `SELECT * FROM outcome_review_candidates
       WHERE incident_id = $1 AND category = $2 AND source_event_id = $3`,
      [input.incidentId, input.category, input.sourceEventId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Outcome candidate conflict could not be read after insert.");
    }
    return outcomeCandidateFromRow(row);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface RunRecordRow {
  run_id: string;
  incident_id: string;
  incident_title: string | null;
  severity: string | null;
  incident_status: string | null;
  started_at: Date | string | null;
  scenario_name: string;
  service: string;
  run_status: string;
  validation_status: "valid" | "invalid" | "not_available";
  safety_status: string | null;
  mitigation_status: string | null;
  evidence_ids: unknown;
  scorecard: unknown;
  review_envelope: unknown;
  retention_class: RetentionClass;
  correlation_id: string;
  parent_run_id: string | null;
  gate_decision_id: string | null;
  created_at: Date | string;
  expires_at: Date | string;
}

interface EvidenceGateDecisionRow {
  decision_id: string;
  incident_id: string;
  canonicalization_version: string;
  candidate_digest: string;
  baseline_key: string;
  prior_run_id: string | null;
  child_run_id: string | null;
  outcome: MaterialityOutcome;
  basis: MaterialityBasis;
  delta: EvidenceDelta;
  rationale: string;
  cited_delta_refs: unknown;
  retention_class: RetentionClass;
  created_at: Date | string;
  expires_at: Date | string;
}

interface VerificationOutcomeRow {
  event_id: string;
  incident_id: string;
  source_event_key: string;
  run_id: string;
  outcome: VerificationOutcomeInput["outcome"];
  source: VerificationOutcomeInput["source"];
  source_reference: string;
  evidence_ids: unknown;
  rationale: string;
  retention_class: RetentionClass;
  created_at: Date | string;
  expires_at: Date | string;
}

interface RecoveryBudgetRow {
  incident_id: string;
  failure_class: RecoveryFailureClass;
  attempts: number;
  attempt_limit: number;
  exhausted: boolean;
  generation: number;
  updated_at: Date | string;
  expires_at: Date | string;
}

interface RecoveryEventRow {
  event_id: string;
  incident_id: string;
  source_event_key: string;
  event_type: RecoveryEventType;
  failure_class: RecoveryFailureClass;
  run_id: string | null;
  attempt: number | null;
  reason: RecoveryResetReason | null;
  actor: string | null;
  rationale: string;
  generation: number;
  retention_class: RetentionClass;
  created_at: Date | string;
  expires_at: Date | string;
}

interface OutcomeReviewCandidateRow {
  candidate_id: string;
  incident_id: string;
  run_id: string | null;
  source_event_id: string;
  category: OutcomeCandidateCategory;
  rationale: string;
  evidence_ids: unknown;
  snapshot: Record<string, unknown>;
  status: OutcomeReviewCandidateStatus;
  retention_class: RetentionClass;
  created_at: Date | string;
  expires_at: Date | string;
  imported_at: Date | string | null;
}

function runRecordFromRow(row: RunRecordRow): TriageRunRecord {
  const record: TriageRunRecord = {
    runId: row.run_id,
    incidentId: row.incident_id,
    incidentTitle: row.incident_title ?? row.incident_id,
    severity: row.severity ?? "unknown",
    incidentStatus: row.incident_status ?? "unknown",
    startedAt: row.started_at ? isoValue(row.started_at) : isoValue(row.created_at),
    scenarioName: row.scenario_name,
    service: row.service,
    runStatus: row.run_status,
    validationStatus: row.validation_status,
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
    retentionClass: row.retention_class,
    correlationId: row.correlation_id,
    createdAt: isoValue(row.created_at),
    expiresAt: isoValue(row.expires_at),
  };
  if (row.parent_run_id) {
    record.parentRunId = row.parent_run_id;
  }
  if (row.gate_decision_id) {
    record.gateDecisionId = row.gate_decision_id;
  }
  if (row.safety_status) {
    record.safetyStatus = row.safety_status;
  }
  if (row.mitigation_status) {
    record.mitigationStatus = row.mitigation_status;
  }
  if (row.scorecard !== null) {
    record.scorecard = row.scorecard;
  }
  const reviewEnvelope = decodeTriageRunReviewEnvelope(row.review_envelope);
  if (reviewEnvelope) {
    record.reviewEnvelope = reviewEnvelope;
  }
  return record;
}

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

function buildRunRecord(
  run: TriageRun,
  options: PersistTriageRunOptions,
  lineage: { parentRunId?: string; gateDecisionId?: string } = {},
): TriageRunRecord {
  const now = options.now ?? new Date();
  const retentionClass = options.retentionClass ?? "read_only_triage";
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? defaultTtlMs));
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
    createdAt: iso(now),
    expiresAt: iso(expiresAt),
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

function buildEvidenceSnapshot(
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

function boundedLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

async function upsertRunRecord(client: PoolClient, record: TriageRunRecord): Promise<void> {
  await client.query(
    `INSERT INTO incident_runs (
      run_id, incident_id, incident_title, severity, incident_status, started_at, scenario_name, service,
      run_status, validation_status, safety_status, mitigation_status, evidence_ids, scorecard,
      review_envelope, retention_class, correlation_id, parent_run_id, gate_decision_id, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21)
    ON CONFLICT (run_id) DO UPDATE SET
      incident_title = EXCLUDED.incident_title,
      severity = EXCLUDED.severity,
      incident_status = EXCLUDED.incident_status,
      started_at = EXCLUDED.started_at,
      run_status = EXCLUDED.run_status,
      validation_status = EXCLUDED.validation_status,
      safety_status = EXCLUDED.safety_status,
      mitigation_status = EXCLUDED.mitigation_status,
      evidence_ids = EXCLUDED.evidence_ids,
      scorecard = EXCLUDED.scorecard,
      review_envelope = EXCLUDED.review_envelope,
      retention_class = EXCLUDED.retention_class,
      correlation_id = EXCLUDED.correlation_id,
      parent_run_id = EXCLUDED.parent_run_id,
      gate_decision_id = EXCLUDED.gate_decision_id,
      expires_at = EXCLUDED.expires_at`,
    [
      record.runId,
      record.incidentId,
      record.incidentTitle,
      record.severity,
      record.incidentStatus,
      record.startedAt,
      record.scenarioName,
      record.service,
      record.runStatus,
      record.validationStatus,
      record.safetyStatus ?? null,
      record.mitigationStatus ?? null,
      JSON.stringify(record.evidenceIds),
      record.scorecard ? JSON.stringify(record.scorecard) : null,
      record.reviewEnvelope ? JSON.stringify(record.reviewEnvelope) : null,
      record.retentionClass,
      record.correlationId,
      record.parentRunId ?? null,
      record.gateDecisionId ?? null,
      record.createdAt,
      record.expiresAt,
    ],
  );
}

async function upsertEvidenceSnapshot(client: PoolClient, snapshot: EvidenceSnapshotRecord): Promise<void> {
  await client.query(
    `INSERT INTO evidence_snapshots (
      run_id, incident_id, evidence, missing_context, retention_class, created_at, expires_at
    ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
    ON CONFLICT (run_id) DO UPDATE SET
      evidence = EXCLUDED.evidence,
      missing_context = EXCLUDED.missing_context,
      retention_class = EXCLUDED.retention_class,
      expires_at = EXCLUDED.expires_at`,
    [
      snapshot.runId,
      snapshot.incidentId,
      JSON.stringify(snapshot.evidence),
      JSON.stringify(snapshot.missingContext),
      snapshot.retentionClass,
      snapshot.createdAt,
      snapshot.expiresAt,
    ],
  );
}

function buildGateDecisionRecord(
  candidate: EvidenceGateCandidate,
  options: PersistTriageRunOptions,
  childRunId?: string,
): EvidenceGateDecisionRecord {
  const now = options.now ?? new Date();
  const retentionClass = options.retentionClass ?? "read_only_triage";
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? defaultTtlMs));
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
    createdAt: iso(now),
    expiresAt: iso(expiresAt),
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
  return `gate:${createHash("sha256")
    .update(candidate.incidentId)
    .update("\0")
    .update(baselineKey(candidate))
    .update("\0")
    .update(candidate.candidateDigest)
    .digest("hex")
    .slice(0, 24)}`;
}

function baselineKey(candidate: EvidenceGateCandidate): string {
  return candidate.priorRunId ?? "none";
}

function gateDecisionKey(candidate: EvidenceGateCandidate): string {
  return `${candidate.incidentId}\0${baselineKey(candidate)}\0${candidate.candidateDigest}`;
}

function gateDecisionRecordKey(record: EvidenceGateDecisionRecord): string {
  return `${record.incidentId}\0${record.baselineKey}\0${record.candidateDigest}`;
}

function insertGateDecisionSql(): string {
  return `INSERT INTO evidence_gate_decisions (
    decision_id, incident_id, canonicalization_version, candidate_digest, baseline_key,
    prior_run_id, child_run_id, outcome, basis, delta, rationale, cited_delta_refs,
    retention_class, created_at, expires_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15)`;
}

function gateDecisionValues(record: EvidenceGateDecisionRecord): unknown[] {
  return [
    record.decisionId,
    record.incidentId,
    record.canonicalizationVersion,
    record.candidateDigest,
    record.baselineKey,
    record.priorRunId ?? null,
    record.childRunId ?? null,
    record.outcome,
    record.basis,
    JSON.stringify(record.delta),
    record.rationale,
    JSON.stringify(record.citedDeltaRefs),
    record.retentionClass,
    record.createdAt,
    record.expiresAt,
  ];
}

function gateDecisionFromRow(row: EvidenceGateDecisionRow): EvidenceGateDecisionRecord {
  const record: EvidenceGateDecisionRecord = {
    decisionId: row.decision_id,
    incidentId: row.incident_id,
    canonicalizationVersion: row.canonicalization_version,
    candidateDigest: row.candidate_digest,
    baselineKey: row.baseline_key,
    outcome: row.outcome,
    basis: row.basis,
    delta: row.delta,
    rationale: row.rationale,
    citedDeltaRefs: Array.isArray(row.cited_delta_refs) ? row.cited_delta_refs.map(String) : [],
    retentionClass: row.retention_class,
    createdAt: isoValue(row.created_at),
    expiresAt: isoValue(row.expires_at),
  };
  if (row.prior_run_id) {
    record.priorRunId = row.prior_run_id;
  }
  if (row.child_run_id) {
    record.childRunId = row.child_run_id;
  }
  return record;
}

const recoveryAttemptLimit = 3;

function buildVerificationRecord(
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

function initialRecoveryBudget(
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

function buildRecoveryEvent(
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

function buildOutcomeCandidate(
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

function candidateFromVerification(record: VerificationOutcomeRecord): OutcomeReviewCandidateInput {
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

function candidateFromRecoveryExhaustion(record: RecoveryEventRecord): OutcomeReviewCandidateInput {
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

function verificationLifecycleEvent(record: VerificationOutcomeRecord): IncidentLifecycleEvent {
  return {
    type: "verification_recorded",
    eventId: record.eventId,
    incidentId: record.incidentId,
    createdAt: record.createdAt,
    verification: record.verification,
  };
}

function recoveryLifecycleEvent(record: RecoveryEventRecord): IncidentLifecycleEvent {
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

function compareLifecycleEvents(left: IncidentLifecycleEvent, right: IncidentLifecycleEvent): number {
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

function recoveryBudgetKey(incidentId: string, failureClass: RecoveryFailureClass): string {
  return `${incidentId}\0${failureClass}`;
}

function verificationSourceKey(incidentId: string, sourceEventKey: string): string {
  return `${incidentId}\0${sourceEventKey}`;
}

function recoverySourceKey(
  incidentId: string,
  failureClass: RecoveryFailureClass,
  sourceEventKey: string,
): string {
  return `${incidentId}\0${failureClass}\0${sourceEventKey}`;
}

function outcomeCandidateKey(input: Pick<OutcomeReviewCandidateInput, "incidentId" | "category" | "sourceEventId">): string {
  return `${input.incidentId}\0${input.category}\0${input.sourceEventId}`;
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

async function insertVerificationRecord(
  client: PoolClient,
  record: VerificationOutcomeRecord,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO incident_verification_events (
      event_id, incident_id, source_event_key, run_id, outcome, source, source_reference,
      evidence_ids, rationale, retention_class, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
    ON CONFLICT (incident_id, source_event_key) DO NOTHING
    RETURNING event_id`,
    [
      record.eventId,
      record.incidentId,
      record.sourceEventKey,
      record.verification.runId,
      record.verification.outcome,
      record.verification.source,
      record.verification.sourceReference,
      JSON.stringify(record.verification.evidenceIds),
      record.verification.rationale,
      record.retentionClass,
      record.createdAt,
      record.expiresAt,
    ],
  );
  return result.rowCount === 1;
}

async function selectVerificationBySourceKey(
  client: PoolClient,
  incidentId: string,
  sourceEventKey: string,
): Promise<VerificationOutcomeRecord> {
  const result = await client.query<VerificationOutcomeRow>(
    "SELECT * FROM incident_verification_events WHERE incident_id = $1 AND source_event_key = $2",
    [incidentId, sourceEventKey],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Verification event conflict could not be read after insert.");
  }
  return verificationFromRow(row);
}

function verificationFromRow(row: VerificationOutcomeRow): VerificationOutcomeRecord {
  return {
    eventId: row.event_id,
    incidentId: row.incident_id,
    sourceEventKey: row.source_event_key,
    verification: {
      runId: row.run_id,
      outcome: row.outcome,
      source: row.source,
      sourceReference: row.source_reference,
      evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
      rationale: row.rationale,
    },
    retentionClass: row.retention_class,
    createdAt: isoValue(row.created_at),
    expiresAt: isoValue(row.expires_at),
  };
}

async function lockRecoveryBudget(
  client: PoolClient,
  incidentId: string,
  failureClass: RecoveryFailureClass,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `incident-recovery:${incidentId}:${failureClass}`,
  ]);
}

async function findRecoveryBudget(
  client: PoolClient,
  incidentId: string,
  failureClass: RecoveryFailureClass,
): Promise<RecoveryBudgetRecord | undefined> {
  const result = await client.query<RecoveryBudgetRow>(
    "SELECT * FROM incident_recovery_budgets WHERE incident_id = $1 AND failure_class = $2",
    [incidentId, failureClass],
  );
  return result.rows[0] ? recoveryBudgetFromRow(result.rows[0]) : undefined;
}

async function requiredRecoveryBudget(
  client: PoolClient,
  incidentId: string,
  failureClass: RecoveryFailureClass,
): Promise<RecoveryBudgetRecord> {
  const budget = await findRecoveryBudget(client, incidentId, failureClass);
  if (!budget) {
    throw new Error(`Missing recovery budget: ${incidentId}/${failureClass}`);
  }
  return budget;
}

function recoveryBudgetFromRow(row: RecoveryBudgetRow): RecoveryBudgetRecord {
  return {
    incidentId: row.incident_id,
    failureClass: row.failure_class,
    attempts: row.attempts,
    limit: row.attempt_limit,
    exhausted: row.exhausted,
    generation: row.generation,
    updatedAt: isoValue(row.updated_at),
    expiresAt: isoValue(row.expires_at),
  };
}

async function upsertRecoveryBudget(client: PoolClient, budget: RecoveryBudgetRecord): Promise<void> {
  await client.query(
    `INSERT INTO incident_recovery_budgets (
      incident_id, failure_class, attempts, attempt_limit, exhausted, generation, updated_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (incident_id, failure_class) DO UPDATE SET
      attempts = EXCLUDED.attempts,
      attempt_limit = EXCLUDED.attempt_limit,
      exhausted = EXCLUDED.exhausted,
      generation = EXCLUDED.generation,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at`,
    [
      budget.incidentId,
      budget.failureClass,
      budget.attempts,
      budget.limit,
      budget.exhausted,
      budget.generation,
      budget.updatedAt,
      budget.expiresAt,
    ],
  );
}

async function insertRecoveryEvent(client: PoolClient, record: RecoveryEventRecord): Promise<void> {
  await client.query(
    `INSERT INTO incident_recovery_events (
      event_id, incident_id, source_event_key, event_type, failure_class, run_id, attempt,
      reason, actor, rationale, generation, retention_class, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      record.eventId,
      record.incidentId,
      record.sourceEventKey,
      record.eventType,
      record.failureClass,
      record.runId ?? null,
      record.attempt ?? null,
      record.reason ?? null,
      record.actor ?? null,
      record.rationale,
      record.generation,
      record.retentionClass,
      record.createdAt,
      record.expiresAt,
    ],
  );
}

async function findRecoveryBySourceKey(
  client: PoolClient,
  incidentId: string,
  failureClass: RecoveryFailureClass,
  sourceEventKey: string,
): Promise<RecoveryEventRecord | undefined> {
  const result = await client.query<RecoveryEventRow>(
    `SELECT * FROM incident_recovery_events
     WHERE incident_id = $1 AND failure_class = $2 AND source_event_key = $3`,
    [incidentId, failureClass, sourceEventKey],
  );
  return result.rows[0] ? recoveryEventFromRow(result.rows[0]) : undefined;
}

function recoveryEventFromRow(row: RecoveryEventRow): RecoveryEventRecord {
  return {
    eventId: row.event_id,
    incidentId: row.incident_id,
    sourceEventKey: row.source_event_key,
    eventType: row.event_type,
    failureClass: row.failure_class,
    rationale: row.rationale,
    generation: row.generation,
    retentionClass: row.retention_class,
    createdAt: isoValue(row.created_at),
    expiresAt: isoValue(row.expires_at),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.attempt !== null ? { attempt: row.attempt } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
  };
}

async function insertOutcomeCandidate(
  client: PoolClient,
  candidate: OutcomeReviewCandidateRecord,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO outcome_review_candidates (
      candidate_id, incident_id, run_id, source_event_id, category, rationale, evidence_ids,
      snapshot, status, retention_class, created_at, expires_at, imported_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
    ON CONFLICT (incident_id, category, source_event_id) DO NOTHING
    RETURNING candidate_id`,
    [
      candidate.candidateId,
      candidate.incidentId,
      candidate.runId ?? null,
      candidate.sourceEventId,
      candidate.category,
      candidate.rationale,
      JSON.stringify(candidate.evidenceIds),
      JSON.stringify(candidate.snapshot),
      candidate.status,
      candidate.retentionClass,
      candidate.createdAt,
      candidate.expiresAt,
      candidate.importedAt ?? null,
    ],
  );
  return result.rowCount === 1;
}

function outcomeCandidateFromRow(row: OutcomeReviewCandidateRow): OutcomeReviewCandidateRecord {
  return {
    candidateId: row.candidate_id,
    incidentId: row.incident_id,
    sourceEventId: row.source_event_id,
    category: row.category,
    rationale: row.rationale,
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
    snapshot: row.snapshot,
    status: row.status,
    retentionClass: row.retention_class,
    createdAt: isoValue(row.created_at),
    expiresAt: isoValue(row.expires_at),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.imported_at ? { importedAt: isoValue(row.imported_at) } : {}),
  };
}

async function selectGateDecision(
  client: PoolClient,
  candidate: EvidenceGateCandidate,
): Promise<EvidenceGateDecisionRecord> {
  const result = await client.query<EvidenceGateDecisionRow>(
    `SELECT * FROM evidence_gate_decisions
     WHERE incident_id = $1 AND baseline_key = $2 AND candidate_digest = $3`,
    [candidate.incidentId, baselineKey(candidate), candidate.candidateDigest],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Gate decision conflict could not be read after insert.");
  }
  return gateDecisionFromRow(row);
}

async function selectRunRecord(client: PoolClient, runId: string): Promise<TriageRunRecord | undefined> {
  const result = await client.query<RunRecordRow>(
    `SELECT
      run_id, incident_id, incident_title, severity, incident_status, started_at,
      scenario_name, service, run_status, validation_status, safety_status,
      mitigation_status, evidence_ids, scorecard, review_envelope, retention_class,
      correlation_id, parent_run_id, gate_decision_id, created_at, expires_at
     FROM incident_runs
     WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0] ? runRecordFromRow(result.rows[0]) : undefined;
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function readMigrations(): MigrationFile[] {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

async function ensureMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function iso(date: Date): string {
  return date.toISOString();
}

function isoValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
