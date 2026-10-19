import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { expect, test } from "vitest";

import { auditRetainedEnvelopes } from "../scripts/check-retained-envelopes";
import { loadScenario } from "../src/domain";
import { EvidencePackage, loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import {
  PostgresTriageRunPersistenceStore,
  type EvidenceGateCandidate,
} from "../src/persistence";
import { TriageWorkflow, type TriageRun } from "../src/workflow";
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

test.runIf(Boolean(databaseUrl))("Postgres persistence serializes concurrent recovery attempts", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  const namespace = randomUUID();
  const incidentId = `INC-CONCURRENT:${namespace}`;
  try {
    await store.migrate();
    const results = await Promise.all([1, 2, 3].map((attempt) => store.recordRecoveryFailure({
      incidentId,
      runId: `run:${namespace}`,
      sourceEventKey: `source:${namespace}:${attempt}`,
      failureClass: "provider_unavailable",
      rationale: `Concurrent provider failure ${attempt}.`,
    }, { now: new Date(`2100-09-01T12:0${attempt}:00.000Z`) })));
    const lifecycle = await store.getIncidentLifecycle(incidentId);

    expect(results.map((result) => result.budget.attempts).sort()).toEqual([1, 2, 3]);
    expect(lifecycle.recoveryBudgets).toEqual([
      expect.objectContaining({ attempts: 3, exhausted: true }),
    ]);
    expect(lifecycle.recoveryEvents.filter((event) => event.eventType === "attempt")).toHaveLength(3);
    expect(lifecycle.recoveryEvents.filter((event) => event.eventType === "exhausted")).toHaveLength(1);
    expect(lifecycle.candidates.filter((candidate) => candidate.category === "recovery_exhausted")).toHaveLength(1);
  } finally {
    await deleteIncidentRows(incidentId);
    await store.close();
  }
});

test.runIf(Boolean(databaseUrl))("Postgres persistence fails closed for malformed newest baselines", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  const pool = new Pool({ connectionString: databaseUrl! });
  const namespace = randomUUID();
  const incidentId = `INC-MALFORMED-BASELINE:${namespace}`;
  const runId = `malformed-baseline:${namespace}`;
  try {
    await store.migrate();
    await insertMalformedRun(pool, { incidentId, runId });
    await pool.query(
      `INSERT INTO evidence_snapshots (
        run_id, incident_id, evidence, missing_context, retention_class, created_at, expires_at
      ) VALUES ($1, $2, '[]'::jsonb, '[]'::jsonb, 'read_only_triage', $3, $4)`,
      [runId, incidentId, new Date("2100-08-01T12:00:00.000Z"), new Date("2101-08-01T12:00:00.000Z")],
    );

    await expect(store.getLatestIncidentBaseline(incidentId, {
      now: new Date("2100-08-02T12:00:00.000Z"),
    })).rejects.toThrow("review_envelope.validation.valid");
  } finally {
    await pool.query("DELETE FROM incident_runs WHERE incident_id = $1", [incidentId]);
    await pool.end();
    await store.close();
  }
});

test.runIf(Boolean(databaseUrl))("Postgres persistence fails closed for malformed gated conflicts", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  const pool = new Pool({ connectionString: databaseUrl! });
  const namespace = randomUUID();
  const incidentId = `INC-MALFORMED-GATE:${namespace}`;
  const runId = `malformed-gate:${namespace}`;
  const candidate = gateCandidate(incidentId, `digest:${namespace}`);
  try {
    await store.migrate();
    await insertMalformedRun(pool, { incidentId, runId });
    await pool.query(
      `INSERT INTO evidence_gate_decisions (
        decision_id, incident_id, canonicalization_version, candidate_digest, baseline_key,
        prior_run_id, child_run_id, outcome, basis, delta, rationale, cited_delta_refs,
        retention_class, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, 'none', NULL, $5, 'material', 'deterministic_policy',
        $6::jsonb, 'Existing decision.', '[]'::jsonb, 'read_only_triage', $7, $8)`,
      [
        `gate:${namespace}`,
        incidentId,
        candidate.canonicalizationVersion,
        candidate.candidateDigest,
        runId,
        JSON.stringify(candidate.delta),
        new Date("2100-08-01T12:00:00.000Z"),
        new Date("2101-08-01T12:00:00.000Z"),
      ],
    );

    await expect(store.recordGatedTriageRun({} as TriageRun, candidate)).rejects.toThrow(
      "review_envelope.validation.valid",
    );
  } finally {
    await pool.query("DELETE FROM evidence_gate_decisions WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM incident_runs WHERE incident_id = $1", [incidentId]);
    await pool.end();
    await store.close();
  }
});

test.runIf(Boolean(databaseUrl))("retained-envelope audit reads one stable Postgres snapshot", async () => {
  const readerPool = new Pool({ connectionString: databaseUrl! });
  const writerPool = new Pool({ connectionString: databaseUrl! });
  const client = await readerPool.connect();
  const namespace = randomUUID();
  const runId = `!audit-concurrent:${namespace}`;
  let inserted = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const initial = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM incident_runs WHERE review_envelope IS NOT NULL",
    );
    const auditClient = {
      async query(sql: string, values?: unknown[]) {
        const page = await client.query(sql, values);
        if (!inserted) {
          inserted = true;
          await insertMalformedRun(writerPool, {
            incidentId: `INC-AUDIT-CONCURRENT:${namespace}`,
            runId,
          });
        }
        return { rows: page.rows };
      },
    };

    const result = await auditRetainedEnvelopes(auditClient, 1);

    expect(result.scanned).toBe(Number(initial.rows[0]?.count ?? 0));
    expect(result.incompatibleRunIds).not.toContain(runId);
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await writerPool.query("DELETE FROM incident_runs WHERE run_id = $1", [runId]);
    await writerPool.end();
    await readerPool.end();
  }
});

test.runIf(Boolean(databaseUrl))("Postgres multi-write operations roll back partial state", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  const pool = new Pool({ connectionString: databaseUrl! });
  const namespace = randomUUID();
  const incidentIds: string[] = [];
  try {
    await store.migrate();

    const run = await completedRun(namespace);
    incidentIds.push(run.scenario.incident.incidentId);
    await expect(failStoreQueryOnce(store, "INSERT INTO evidence_snapshots", () =>
      store.recordTriageRun(run)
    )).rejects.toThrow("injected query failure");
    expect(await countRows(pool, "incident_runs", "run_id", run.runId)).toBe(0);

    const gatedRun = await completedRun(`${namespace}:gated`);
    const gatedIncidentId = gatedRun.scenario.incident.incidentId;
    incidentIds.push(gatedIncidentId);
    const candidate = gateCandidate(gatedIncidentId, `digest:${namespace}:rollback`);
    await expect(failStoreQueryOnce(store, "INSERT INTO incident_runs", () =>
      store.recordGatedTriageRun(gatedRun, candidate)
    )).rejects.toThrow("injected query failure");
    expect(await countRows(pool, "evidence_gate_decisions", "incident_id", gatedIncidentId)).toBe(0);

    const verificationIncidentId = `INC-ROLLBACK-VERIFICATION:${namespace}`;
    incidentIds.push(verificationIncidentId);
    await expect(failStoreQueryOnce(store, "INSERT INTO outcome_review_candidates", () =>
      store.recordVerificationOutcome({
        incidentId: verificationIncidentId,
        sourceEventKey: `verify:${namespace}`,
        verification: {
          outcome: "unresolved",
          source: "operator",
          sourceReference: "operator:rollback-test",
          runId: `run:${namespace}`,
          evidenceIds: [`evidence:${namespace}`],
          rationale: "Still unresolved.",
        },
      })
    )).rejects.toThrow("injected query failure");
    expect(await countRows(pool, "incident_verification_events", "incident_id", verificationIncidentId)).toBe(0);

    const recoveryIncidentId = `INC-ROLLBACK-RECOVERY:${namespace}`;
    incidentIds.push(recoveryIncidentId);
    for (const attempt of [1, 2]) {
      await store.recordRecoveryFailure(recoveryInput(recoveryIncidentId, namespace, attempt));
    }
    await expect(failStoreQueryOnce(store, "INSERT INTO outcome_review_candidates", () =>
      store.recordRecoveryFailure(recoveryInput(recoveryIncidentId, namespace, 3))
    )).rejects.toThrow("injected query failure");
    const recoveryLifecycle = await store.getIncidentLifecycle(recoveryIncidentId);
    expect(recoveryLifecycle.recoveryBudgets).toEqual([
      expect.objectContaining({ attempts: 2, exhausted: false }),
    ]);
    expect(recoveryLifecycle.recoveryEvents).toHaveLength(2);
    expect(recoveryLifecycle.candidates).toHaveLength(0);

    const resetIncidentId = `INC-ROLLBACK-RESET:${namespace}`;
    incidentIds.push(resetIncidentId);
    await store.recordRecoveryFailure(recoveryInput(resetIncidentId, namespace, 1));
    await expect(failStoreQueryOnce(store, "INSERT INTO incident_recovery_budgets", () =>
      store.resetRecoveryBudget({
        incidentId: resetIncidentId,
        runId: `run:${namespace}`,
        sourceEventKey: `reset:${namespace}`,
        failureClass: "provider_unavailable",
        reason: "operator_reset",
        actor: "operator:rollback-test",
        rationale: "Reset should roll back.",
      })
    )).rejects.toThrow("injected query failure");
    const resetLifecycle = await store.getIncidentLifecycle(resetIncidentId);
    expect(resetLifecycle.recoveryBudgets).toEqual([
      expect.objectContaining({ attempts: 1, generation: 0 }),
    ]);
    expect(resetLifecycle.recoveryEvents.map((event) => event.eventType)).toEqual(["attempt"]);

    const cleanupIncidentId = `INC-ROLLBACK-CLEANUP:${namespace}`;
    incidentIds.push(cleanupIncidentId);
    await store.recordOutcomeReviewCandidate({
      incidentId: cleanupIncidentId,
      sourceEventId: `cleanup:${namespace}`,
      category: "unresolved_mitigation",
      rationale: "Expired candidate.",
      evidenceIds: [],
      snapshot: {},
    }, { now: new Date("2000-01-01T00:00:00.000Z"), ttlMs: 1_000 });
    await expect(failStoreQueryOnce(store, "DELETE FROM incident_recovery_events", () =>
      store.cleanupExpired(new Date("2000-01-02T00:00:00.000Z"))
    )).rejects.toThrow("injected query failure");
    expect(await store.listOutcomeReviewCandidates({ incidentId: cleanupIncidentId })).toHaveLength(1);
  } finally {
    for (const incidentId of incidentIds) {
      await deleteIncidentRows(incidentId, pool);
    }
    await pool.end();
    await store.close();
  }
}, 20_000);

async function insertMalformedRun(
  pool: Pool,
  input: { incidentId: string; runId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO incident_runs (
      run_id, incident_id, scenario_name, service, run_status, validation_status,
      evidence_ids, review_envelope, retention_class, correlation_id, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::jsonb, $8, $9, $10, $11)`,
    [
      input.runId,
      input.incidentId,
      "retained-envelope-compatibility",
      "checkout-api",
      "completed",
      "valid",
      JSON.stringify({ validation: { valid: "yes", errors: [] } }),
      "read_only_triage",
      `postgres-malformed-envelope:${randomUUID()}`,
      new Date("2100-08-01T12:00:00.000Z"),
      new Date("2101-08-01T12:00:00.000Z"),
    ],
  );
}

function gateCandidate(incidentId: string, candidateDigest: string): EvidenceGateCandidate {
  return {
    incidentId,
    canonicalizationVersion: "v1",
    candidateDigest,
    delta: {
      added: [],
      removed: [],
      incidentChanges: [],
      addedMissingContext: [],
      resolvedMissingContext: [],
    },
    decision: {
      outcome: "material",
      basis: "deterministic_policy",
      rationale: "Material evidence changed.",
      citedDeltaRefs: [],
    },
  };
}

async function completedRun(identity: string): Promise<TriageRun> {
  const scenario = loadScenario("fixtures", "bad-deploy-latency");
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({
      "bad-deploy-latency": JSON.stringify({
        incident_class: "bad_deploy",
        next_action: "request_rollback_approval",
        confidence: 0.9,
        evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
        caveats: [],
        verification_plan: ["Check checkout latency."],
      }),
    }),
    undefined,
    { mode: "read_only" },
  );
  const template = await workflow.run(scenario);
  const incident = { ...template.scenario.incident, incidentId: `INC-ROLLBACK-RUN:${identity}` };
  const identifiedScenario = { ...template.scenario, name: `${template.scenario.name}:${identity}`, incident };
  return {
    ...template,
    runId: `triage-run:rollback:${identity}`,
    scenario: identifiedScenario,
    states: [...template.states],
    ...(template.evidencePackage ? {
      evidencePackage: new EvidencePackage(
        identifiedScenario.name,
        incident,
        template.evidencePackage.evidence,
        template.evidencePackage.missingContext,
        template.evidencePackage.investigationSteps,
      ),
    } : {}),
  };
}

function recoveryInput(incidentId: string, namespace: string, attempt: number) {
  return {
    incidentId,
    runId: `run:${namespace}`,
    sourceEventKey: `recovery:${namespace}:${attempt}`,
    failureClass: "provider_unavailable" as const,
    rationale: `Recovery failure ${attempt}.`,
  };
}

async function failStoreQueryOnce<T>(
  store: PostgresTriageRunPersistenceStore,
  sqlFragment: string,
  work: () => Promise<T>,
): Promise<T> {
  const pool = (store as unknown as { pool: Pool }).pool;
  const mutablePool = pool as unknown as { connect: () => Promise<PoolClient> };
  const originalConnect = mutablePool.connect.bind(pool);
  let injected = false;
  mutablePool.connect = async () => {
    const client = await originalConnect();
    const mutableClient = client as unknown as {
      query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
    };
    const originalQuery = mutableClient.query.bind(client);
    const originalRelease = client.release.bind(client);
    mutableClient.query = async (sql, values) => {
      if (!injected && sql.includes(sqlFragment)) {
        injected = true;
        throw new Error(`injected query failure: ${sqlFragment}`);
      }
      return originalQuery(sql, values);
    };
    client.release = (error) => {
      mutableClient.query = originalQuery;
      client.release = originalRelease;
      originalRelease(error);
    };
    return client;
  };
  try {
    return await work();
  } finally {
    mutablePool.connect = originalConnect;
  }
}

async function countRows(pool: Pool, table: string, column: string, value: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [value],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function deleteIncidentRows(incidentId: string, providedPool?: Pool): Promise<void> {
  const pool = providedPool ?? new Pool({ connectionString: databaseUrl! });
  try {
    await pool.query("DELETE FROM outcome_review_candidates WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM incident_recovery_events WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM incident_verification_events WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM incident_recovery_budgets WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM evidence_snapshots WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM evidence_gate_decisions WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM incident_runs WHERE incident_id = $1", [incidentId]);
  } finally {
    if (!providedPool) {
      await pool.end();
    }
  }
}
