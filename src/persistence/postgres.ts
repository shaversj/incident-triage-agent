import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

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
  baselineKey,
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
  initialRecoveryBudget,
  iso,
} from "./record-mapping";
import {
  gateDecisionFromRow,
  incidentBaselineFromRow,
  outcomeCandidateFromRow,
  recoveryBudgetFromRow,
  recoveryEventFromRow,
  runRecordFromRow,
  triageRunReviewFromRow,
  verificationFromRow,
  type EvidenceGateDecisionRow,
  type IncidentBaselineRow,
  type OutcomeReviewCandidateRow,
  type RecoveryBudgetRow,
  type RecoveryEventRow,
  type RunRecordRow,
  type TriageRunReviewRow,
  type VerificationOutcomeRow,
} from "./postgres-row-mapping";

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
    const result = await this.pool.query<TriageRunReviewRow>(
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
    const decisions = await this.listGateDecisions(row.incident_id);
    return triageRunReviewFromRow(row, decisions);
  }

  async getLatestIncidentBaseline(
    incidentId: string,
    options: IncidentBaselineLookupOptions = {},
  ): Promise<IncidentBaseline | undefined> {
    const cutoff = (options.now ?? new Date()).toISOString();
    const result = await this.pool.query<IncidentBaselineRow>(
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
    return incidentBaselineFromRow(row);
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
    return { decision: await selectGateDecision(this.pool, candidate), created: false };
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
    return buildIncidentLifecycleReview(
      incidentId,
      verificationEvents,
      recoveryEvents,
      budgets.rows.map(recoveryBudgetFromRow),
      candidates.rows.map(outcomeCandidateFromRow),
    );
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


async function selectGateDecision(
  client: Pool | PoolClient,
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
