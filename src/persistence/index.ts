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
  retentionClass: RetentionClass;
  correlationId: string;
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
  claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim>;
  cleanupExpired(now?: Date): Promise<{ evidenceSnapshotsDeleted: number; replayKeysDeleted: number }>;
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

  async claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim> {
    const replayKey = buildReplayKey(input);
    const receivedAt = input.receivedAt ?? new Date();
    const expiresAt = iso(new Date(receivedAt.getTime() + input.ttlMs));
    await this.cleanupExpired(receivedAt);
    if (this.replayKeys.has(replayKey)) {
      return { accepted: false, replayKey, expiresAt };
    }
    this.replayKeys.set(replayKey, { input, expiresAt });
    return { accepted: true, replayKey, expiresAt };
  }

  async cleanupExpired(now = new Date()): Promise<{ evidenceSnapshotsDeleted: number; replayKeysDeleted: number }> {
    const cutoff = now.toISOString();
    let evidenceSnapshotsDeleted = 0;
    let replayKeysDeleted = 0;
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
    return { evidenceSnapshotsDeleted, replayKeysDeleted };
  }
}

export class PostgresTriageRunPersistenceStore implements TriageRunPersistenceStore {
  private readonly pool: Pool;

  constructor(config: { connectionString: string }) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      max: 5,
      allowExitOnIdle: true,
    });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const sql of readMigrationSql()) {
        await client.query(sql);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordTriageRun(run: TriageRun, options: PersistTriageRunOptions = {}): Promise<TriageRunRecord> {
    const record = buildRunRecord(run, options);
    const snapshot = buildEvidenceSnapshot(run, record, options);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await upsertRunRecord(client, record);
      await upsertEvidenceSnapshot(client, snapshot);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimReplayKey(input: ReplayKeyInput): Promise<ReplayKeyClaim> {
    const replayKey = buildReplayKey(input);
    const receivedAt = input.receivedAt ?? new Date();
    const expiresAt = iso(new Date(receivedAt.getTime() + input.ttlMs));
    await this.cleanupExpired(receivedAt);
    const result = await this.pool.query(
      `INSERT INTO replay_keys (replay_key, sender, signature, timestamp, body_digest, received_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (replay_key) DO NOTHING`,
      [replayKey, input.sender, input.signature, input.timestamp, input.bodyDigest, receivedAt.toISOString(), expiresAt],
    );
    return { accepted: result.rowCount === 1, replayKey, expiresAt };
  }

  async cleanupExpired(now = new Date()): Promise<{ evidenceSnapshotsDeleted: number; replayKeysDeleted: number }> {
    const cutoff = now.toISOString();
    const evidence = await this.pool.query("DELETE FROM evidence_snapshots WHERE expires_at <= $1", [cutoff]);
    const replay = await this.pool.query("DELETE FROM replay_keys WHERE expires_at <= $1", [cutoff]);
    return {
      evidenceSnapshotsDeleted: evidence.rowCount ?? 0,
      replayKeysDeleted: replay.rowCount ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
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
  return record;
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
      mitigation_status, evidence_ids, scorecard, retention_class, correlation_id, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
    ON CONFLICT (run_id) DO UPDATE SET
      run_status = EXCLUDED.run_status,
      validation_status = EXCLUDED.validation_status,
      safety_status = EXCLUDED.safety_status,
      mitigation_status = EXCLUDED.mitigation_status,
      evidence_ids = EXCLUDED.evidence_ids,
      scorecard = EXCLUDED.scorecard,
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

function readMigrationSql(): string[] {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name), "utf8"));
}

function iso(date: Date): string {
  return date.toISOString();
}
