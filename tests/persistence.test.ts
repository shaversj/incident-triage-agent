import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { InMemoryTriageRunPersistenceStore, buildReplayKey } from "../src/persistence";
import { TriageWorkflow } from "../src/workflow";

test("in-memory persistence records completed read-only run envelope and evidence snapshot", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const run = await runScenario("bad-deploy-latency", {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.9,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: ["Check checkout latency."],
  });

  const record = await store.recordTriageRun(run, {
    correlationId: "trace-123",
    retentionClass: "read_only_triage",
    now: new Date("2026-08-01T12:00:00.000Z"),
  });
  const snapshot = store.evidenceSnapshots.get(run.runId);

  expect(record).toMatchObject({
    runId: "triage-run:bad-deploy-latency",
    incidentId: "INC-2026-015",
    service: "checkout-api",
    runStatus: "completed",
    validationStatus: "valid",
    safetyStatus: "approval_required",
    mitigationStatus: "approval_required",
    retentionClass: "read_only_triage",
    correlationId: "trace-123",
  });
  expect(record.evidenceIds).toEqual(expect.arrayContaining(["deploy:0", "log:0", "runbook:bad-deploy"]));
  expect(record.scorecard).toBeDefined();
  expect(record.reviewEnvelope?.decision).toMatchObject({
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
  });
  expect(record.reviewEnvelope?.mitigationControl).toMatchObject({
    status: "approval_required",
  });
  expect(snapshot?.evidence).toHaveLength(run.evidencePackage?.evidence.length ?? 0);
  expect(snapshot?.missingContext).toEqual(run.evidencePackage?.missingContext);
});

test("in-memory persistence returns read-only review envelope with evidence snapshot", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const run = await runScenario("bad-deploy-latency", {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.9,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: ["Check checkout latency."],
  });
  await store.recordTriageRun(run, { correlationId: "trace-123" });

  const review = await store.getTriageRunReview(run.runId);

  expect(review?.run.reviewEnvelope?.decision).toMatchObject({
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
  });
  expect(review?.evidenceSnapshot?.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ evidenceId: "deploy:0" }),
  ]));
  expect(review?.run.reviewEnvelope?.mitigationControl).not.toHaveProperty("stagedAction");
  expect(review?.run.reviewEnvelope?.mitigationControl).not.toHaveProperty("approvalRequest");
});

test("in-memory persistence records recoverable invalid decision without approval artifacts", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const run = await runScenario("checkout-payment-timeout", "{not json");

  const record = await store.recordTriageRun(run, {
    now: new Date("2026-08-01T12:00:00.000Z"),
  });

  expect(record.runStatus).toBe("recoverable_failure");
  expect(record.validationStatus).toBe("invalid");
  expect(record.safetyStatus).toBeUndefined();
  expect(record.mitigationStatus).toBeUndefined();
  expect(store.evidenceSnapshots.get(run.runId)?.evidence).toHaveLength(run.evidencePackage?.evidence.length ?? 0);
});

test("replay key claims are atomic until TTL expiry", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const input = {
    sender: "grafana",
    signature: "sig",
    timestamp: "2026-08-01T12:00:00.000Z",
    bodyDigest: "digest",
    receivedAt: new Date("2026-08-01T12:00:00.000Z"),
    ttlMs: 60_000,
  };

  const first = await store.claimReplayKey(input);
  const duplicate = await store.claimReplayKey(input);
  const afterExpiry = await store.claimReplayKey({
    ...input,
    receivedAt: new Date("2026-08-01T12:02:00.000Z"),
  });

  expect(first).toMatchObject({ accepted: true, replayKey: buildReplayKey(input) });
  expect(duplicate).toMatchObject({ accepted: false, replayKey: first.replayKey });
  expect(afterExpiry).toMatchObject({ accepted: true, replayKey: first.replayKey });
});

test("retention cleanup removes expired runs evidence snapshots and replay keys", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const run = await runScenario("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.84,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Monitor timeout rate."],
  });

  await store.recordTriageRun(run, {
    now: new Date("2026-08-01T12:00:00.000Z"),
    ttlMs: 1_000,
  });
  await store.claimReplayKey({
    sender: "grafana",
    signature: "sig",
    timestamp: "2026-08-01T12:00:00.000Z",
    bodyDigest: "digest",
    receivedAt: new Date("2026-08-01T12:00:00.000Z"),
    ttlMs: 1_000,
  });

  const cleanup = await store.cleanupExpired(new Date("2026-08-01T12:00:02.000Z"));

  expect(cleanup).toEqual({ incidentRunsDeleted: 1, evidenceSnapshotsDeleted: 1, replayKeysDeleted: 1 });
  expect(store.runs.has(run.runId)).toBe(false);
  expect(store.evidenceSnapshots.has(run.runId)).toBe(false);
  expect(store.replayKeys.size).toBe(0);
});

test("phase 1 migration owns only run evidence and replay tables", () => {
  const sql = readFileSync("src/persistence/migrations/001_phase1_read_only.sql", "utf8");

  expect(sql).toContain("CREATE TABLE IF NOT EXISTS incident_runs");
  expect(sql).toContain("review_envelope JSONB");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS evidence_snapshots");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS replay_keys");
  expect(sql).not.toContain("approval_requests");
  expect(sql).not.toContain("executor_attempts");
});

test("persistence store tracks applied migration files with checksums", () => {
  const source = readFileSync("src/persistence/index.ts", "utf8");

  expect(source).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
  expect(source).toContain("pg_advisory_xact_lock");
  expect(source).toContain("Migration checksum changed after application");
  expect(source).toContain("INSERT INTO schema_migrations");
  expect(source).toContain("statement_timeout");
  expect(source).toContain("query_timeout");
});

async function runScenario(scenarioName: string, response: object | string) {
  const scenario = loadScenario("fixtures", scenarioName);
  const llmResponse = typeof response === "string" ? response : JSON.stringify(response);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({ [scenarioName]: llmResponse }),
    undefined,
    { mode: "read_only" },
  );
  return workflow.run(scenario);
}
