import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

import type { TriageRun } from "../workflow";

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
  createdAt: string;
  expiresAt: string;
}

export interface TriageRunReviewEnvelope {
  investigation?: unknown;
  validation?: unknown;
  explanation?: unknown;
  explanationValidation?: unknown;
  decision?: unknown;
  safety?: unknown;
  mitigationControl?: unknown;
  provenance?: unknown;
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
  getTriageRunReview?(runId: string): Promise<TriageRunReviewRecord | undefined>;
  claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim>;
  releaseReplayKey?(replayKey: string): Promise<void>;
  cleanupExpired(now?: Date): Promise<{ incidentRunsDeleted: number; evidenceSnapshotsDeleted: number; replayKeysDeleted: number }>;
  close?(): Promise<void>;
}

const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;

export class InMemoryTriageRunPersistenceStore implements TriageRunPersistenceStore {
  readonly runs = new Map<string, TriageRunRecord>();
  readonly evidenceSnapshots = new Map<string, EvidenceSnapshotRecord>();
  readonly replayKeys = new Map<string, { input: ReplayKeyInput; expiresAt: string }>();

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
    return evidenceSnapshot ? { run, evidenceSnapshot } : { run };
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

  async cleanupExpired(now = new Date()): Promise<{ incidentRunsDeleted: number; evidenceSnapshotsDeleted: number; replayKeysDeleted: number }> {
    const cutoff = now.toISOString();
    let incidentRunsDeleted = 0;
    let evidenceSnapshotsDeleted = 0;
    let replayKeysDeleted = 0;
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
    for (const [replayKey, record] of this.replayKeys.entries()) {
      if (record.expiresAt <= cutoff) {
        this.replayKeys.delete(replayKey);
        replayKeysDeleted += 1;
      }
    }
    return { incidentRunsDeleted, evidenceSnapshotsDeleted, replayKeysDeleted };
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
    const result = await this.pool.query<{
      run_id: string;
      incident_id: string;
      scenario_name: string;
      service: string;
      run_status: string;
      validation_status: "valid" | "invalid" | "not_available";
      safety_status: string | null;
      mitigation_status: string | null;
      evidence_ids: unknown;
      scorecard: unknown;
      review_envelope: TriageRunReviewEnvelope | null;
      retention_class: RetentionClass;
      correlation_id: string;
      created_at: Date | string;
      expires_at: Date | string;
      snapshot_evidence: unknown[] | null;
      snapshot_missing_context: string[] | null;
      snapshot_retention_class: RetentionClass | null;
      snapshot_created_at: Date | string | null;
      snapshot_expires_at: Date | string | null;
    }>(
      `SELECT
        runs.run_id, runs.incident_id, runs.scenario_name, runs.service, runs.run_status,
        runs.validation_status, runs.safety_status, runs.mitigation_status, runs.evidence_ids,
        runs.scorecard, runs.review_envelope, runs.retention_class, runs.correlation_id,
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
    const run: TriageRunRecord = {
      runId: row.run_id,
      incidentId: row.incident_id,
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
    if (row.safety_status) {
      run.safetyStatus = row.safety_status;
    }
    if (row.mitigation_status) {
      run.mitigationStatus = row.mitigation_status;
    }
    if (row.scorecard !== null) {
      run.scorecard = row.scorecard;
    }
    if (row.review_envelope) {
      run.reviewEnvelope = row.review_envelope;
    }
    if (!row.snapshot_evidence) {
      return { run };
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
    };
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

  async cleanupExpired(now = new Date()): Promise<{ incidentRunsDeleted: number; evidenceSnapshotsDeleted: number; replayKeysDeleted: number }> {
    const cutoff = now.toISOString();
    return this.withTransaction(async (client) => {
      const evidence = await client.query("DELETE FROM evidence_snapshots WHERE expires_at <= $1", [cutoff]);
      const runs = await client.query("DELETE FROM incident_runs WHERE expires_at <= $1", [cutoff]);
      const replay = await client.query("DELETE FROM replay_keys WHERE expires_at <= $1", [cutoff]);
      return {
        incidentRunsDeleted: runs.rowCount ?? 0,
        evidenceSnapshotsDeleted: evidence.rowCount ?? 0,
        replayKeysDeleted: replay.rowCount ?? 0,
      };
    });
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

function buildRunRecord(run: TriageRun, options: PersistTriageRunOptions): TriageRunRecord {
  const now = options.now ?? new Date();
  const retentionClass = options.retentionClass ?? "read_only_triage";
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? defaultTtlMs));
  const validationStatus = run.validation ? (run.validation.valid ? "valid" : "invalid") : "not_available";
  const evidenceIds = run.evidencePackage?.evidence.map((item) => item.evidenceId) ?? [];
  const record: TriageRunRecord = {
    runId: run.runId,
    incidentId: run.scenario.incident.incidentId,
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

async function upsertRunRecord(client: PoolClient, record: TriageRunRecord): Promise<void> {
  await client.query(
    `INSERT INTO incident_runs (
      run_id, incident_id, scenario_name, service, run_status, validation_status, safety_status,
      mitigation_status, evidence_ids, scorecard, review_envelope, retention_class, correlation_id, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
    ON CONFLICT (run_id) DO UPDATE SET
      run_status = EXCLUDED.run_status,
      validation_status = EXCLUDED.validation_status,
      safety_status = EXCLUDED.safety_status,
      mitigation_status = EXCLUDED.mitigation_status,
      evidence_ids = EXCLUDED.evidence_ids,
      scorecard = EXCLUDED.scorecard,
      review_envelope = EXCLUDED.review_envelope,
      retention_class = EXCLUDED.retention_class,
      correlation_id = EXCLUDED.correlation_id,
      expires_at = EXCLUDED.expires_at`,
    [
      record.runId,
      record.incidentId,
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
