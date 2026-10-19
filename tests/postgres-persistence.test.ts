import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test } from "vitest";

import { PostgresTriageRunPersistenceStore } from "../src/persistence";
import { registerPersistenceConformanceSuite } from "./support/persistence-conformance";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test.runIf(Boolean(databaseUrl))("Postgres persistence applies migrations repeatably", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  const pool = new Pool({ connectionString: databaseUrl! });
  const migrationName = "001_phase1_read_only.sql";
  let originalChecksum: string | undefined;
  try {
    await store.migrate();
    await store.migrate();
    const result = await pool.query<{ migration_name: string; checksum: string }>(
      "SELECT migration_name, checksum FROM schema_migrations ORDER BY migration_name",
    );

    expect(result.rows.map((row) => row.migration_name)).toEqual(expect.arrayContaining([
      migrationName,
      "002_run_review_metadata.sql",
      "003_material_evidence_reentry.sql",
      "004_incident_lifecycle.sql",
      "005_scope_lifecycle_idempotency.sql",
    ]));
    originalChecksum = result.rows.find((row) => row.migration_name === migrationName)?.checksum;
    expect(originalChecksum).toBeDefined();
    await pool.query(
      "UPDATE schema_migrations SET checksum = $1 WHERE migration_name = $2",
      ["incompatible-checksum", migrationName],
    );
    await expect(store.migrate()).rejects.toThrow(`Migration checksum changed after application: ${migrationName}`);
  } finally {
    if (originalChecksum) {
      await pool.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE migration_name = $2",
        [originalChecksum, migrationName],
      );
    }
    await pool.end();
    await store.close();
  }
});

registerPersistenceConformanceSuite("Postgres", {
  enabled: Boolean(databaseUrl),
  createStore: async () => {
    const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
    await store.migrate();
    return store;
  },
  teardownStore: async (store) => {
    await store.close?.();
  },
});

test.runIf(Boolean(databaseUrl))("Postgres persistence isolates malformed retained envelopes from run summaries", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  const pool = new Pool({ connectionString: databaseUrl! });
  const runId = `malformed-envelope:${randomUUID()}`;
  try {
    await store.migrate();
    await pool.query(
      `INSERT INTO incident_runs (
        run_id, incident_id, scenario_name, service, run_status, validation_status,
        evidence_ids, review_envelope, retention_class, correlation_id, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)`,
      [
        runId,
        `INC-MALFORMED:${randomUUID()}`,
        "retained-envelope-compatibility",
        "checkout-api",
        "completed",
        "valid",
        "[]",
        JSON.stringify({ validation: { valid: "yes", errors: [] } }),
        "read_only_triage",
        `postgres-malformed-envelope:${randomUUID()}`,
        new Date("2100-08-01T12:00:00.000Z"),
        new Date("2100-08-02T12:00:00.000Z"),
      ],
    );

    await expect(store.listTriageRuns({ limit: 100 })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId }),
    ]));
    await expect(store.getTriageRunReview(runId)).rejects.toThrow("review_envelope.validation.valid");
  } finally {
    await pool.query("DELETE FROM incident_runs WHERE run_id = $1", [runId]);
    await pool.end();
    await store.close();
  }
});
