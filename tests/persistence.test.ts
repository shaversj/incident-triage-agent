import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { InMemoryTriageRunPersistenceStore, buildReplayKey } from "../src/persistence";
import { decodeTriageRunReviewEnvelope } from "../src/persistence/postgres-row-mapping";
import type { EvidenceDelta, MaterialityDecision } from "../src/reentry";
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
  expect(decodeTriageRunReviewEnvelope(record.reviewEnvelope)).toEqual(record.reviewEnvelope);
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

test("in-memory persistence lists run summaries newest first", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const first = await runScenario("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.87,
    evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });
  const second = await runScenario("bad-deploy-latency", {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.9,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: ["Check checkout latency."],
  });

  await store.recordTriageRun(first, { now: new Date("2026-08-01T12:00:00.000Z") });
  await store.recordTriageRun(second, { now: new Date("2026-08-01T12:01:00.000Z") });

  const runs = await store.listTriageRuns();

  expect(runs.map((run) => run.runId)).toEqual([second.runId, first.runId]);
  expect(runs[0]).toMatchObject({
    incidentTitle: "Checkout API latency after retry rollout",
    severity: "SEV2",
    startedAt: "2026-06-14T16:21:00Z",
    safetyStatus: "approval_required",
  });
});

test("in-memory persistence records a gated run and exposes it as the latest incident baseline", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const run = await runScenario("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.87,
    evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });

  const recorded = await store.recordGatedTriageRun(run, gateCandidate({
    candidateDigest: "candidate:first",
    decision: materialityDecision("first_observation", "no_baseline"),
  }), { now: new Date("2026-08-01T12:00:00.000Z") });
  const baseline = await store.getLatestIncidentBaseline(run.scenario.incident.incidentId, {
    now: new Date("2026-08-01T12:00:00.500Z"),
  });

  expect(recorded.created).toBe(true);
  expect(recorded.run.gateDecisionId).toBe(recorded.decision.decisionId);
  expect(recorded.run).not.toHaveProperty("parentRunId");
  expect(recorded.decision).toMatchObject({
    outcome: "first_observation",
    baselineKey: "none",
    childRunId: run.runId,
  });
  expect(baseline?.run.runId).toBe(run.runId);
  expect(baseline?.evidenceSnapshot?.evidence).toHaveLength(run.evidencePackage?.evidence.length ?? 0);
});

test("in-memory baseline lookup excludes expired runs and runs without retained evidence", async () => {
  const run = await runScenario("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.87,
    evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });
  const expiredStore = new InMemoryTriageRunPersistenceStore();
  await expiredStore.recordTriageRun(run, {
    now: new Date("2026-08-01T12:00:00.000Z"),
    ttlMs: 1_000,
  });

  expect(await expiredStore.getLatestIncidentBaseline(run.scenario.incident.incidentId, {
    now: new Date("2026-08-01T12:00:02.000Z"),
  })).toBeUndefined();
  expect(expiredStore.runs.has(run.runId)).toBe(true);

  const snapshotlessStore = new InMemoryTriageRunPersistenceStore();
  await snapshotlessStore.recordTriageRun(run, { now: new Date("2026-08-01T12:00:00.000Z") });
  snapshotlessStore.evidenceSnapshots.delete(run.runId);

  expect(await snapshotlessStore.getLatestIncidentBaseline(run.scenario.incident.incidentId, {
    now: new Date("2026-08-01T12:00:01.000Z"),
  })).toBeUndefined();
});

test("in-memory persistence stores a non-material decision without creating a run", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const prior = await runScenario("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.87,
    evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });
  await store.recordTriageRun(prior, { now: new Date("2026-08-01T12:00:00.000Z") });

  const first = await store.recordEvidenceGateDecision(gateCandidate({
    priorRunId: prior.runId,
    candidateDigest: "candidate:same",
    decision: materialityDecision("not_material", "equivalent"),
  }), { now: new Date("2026-08-01T12:01:00.000Z") });
  const duplicate = await store.recordEvidenceGateDecision(gateCandidate({
    priorRunId: prior.runId,
    candidateDigest: "candidate:same",
    decision: materialityDecision("not_material", "equivalent"),
  }), { now: new Date("2026-08-01T12:02:00.000Z") });
  const review = await store.getTriageRunReview(prior.runId);

  expect(first.created).toBe(true);
  expect(duplicate.created).toBe(false);
  expect(duplicate.decision.decisionId).toBe(first.decision.decisionId);
  expect(store.runs).toHaveLength(1);
  expect(review?.recentGateDecisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ outcome: "not_material", priorRunId: prior.runId }),
  ]));
});

test("in-memory persistence links a material child to its parent and scopes idempotency to the baseline", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const parent = await runScenario("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.87,
    evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });
  await store.recordTriageRun(parent, { now: new Date("2026-08-01T12:00:00.000Z") });
  const child = { ...parent, runId: "triage-run:checkout-payment-timeout:child" };

  const first = await store.recordGatedTriageRun(child, gateCandidate({
    priorRunId: parent.runId,
    candidateDigest: "candidate:material",
    decision: materialityDecision("material", "deterministic_policy"),
  }), { now: new Date("2026-08-01T12:01:00.000Z") });
  const duplicate = await store.recordGatedTriageRun(
    { ...child, runId: "triage-run:checkout-payment-timeout:duplicate" },
    gateCandidate({
      priorRunId: parent.runId,
      candidateDigest: "candidate:material",
      decision: materialityDecision("material", "deterministic_policy"),
    }),
    { now: new Date("2026-08-01T12:02:00.000Z") },
  );
  const nextBaselineDecision = await store.recordEvidenceGateDecision(gateCandidate({
    priorRunId: child.runId,
    candidateDigest: "candidate:material",
    decision: materialityDecision("not_material", "equivalent"),
  }), { now: new Date("2026-08-01T12:03:00.000Z") });

  expect(first.created).toBe(true);
  expect(first.run.parentRunId).toBe(parent.runId);
  expect(duplicate.created).toBe(false);
  expect(duplicate.run.runId).toBe(child.runId);
  expect(nextBaselineDecision.created).toBe(true);
  expect(store.runs.has("triage-run:checkout-payment-timeout:duplicate")).toBe(false);
});

test("in-memory lifecycle persistence records verification idempotently and creates one unresolved candidate", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const input = {
    incidentId: "INC-2026-015",
    sourceEventKey: "operator:verification:1",
    verification: {
      outcome: "unresolved" as const,
      source: "operator" as const,
      sourceReference: "operator:local-sre",
      runId: "run-1",
      evidenceIds: ["verification:latency"],
      rationale: "Latency remains above the incident threshold.",
    },
  };

  const first = await store.recordVerificationOutcome(input, {
    now: new Date("2026-10-13T12:00:00.000Z"),
  });
  const duplicate = await store.recordVerificationOutcome(input, {
    now: new Date("2026-10-13T12:01:00.000Z"),
  });
  const otherIncident = await store.recordVerificationOutcome({
    ...input,
    incidentId: "INC-2026-016",
  });
  const lifecycle = await store.getIncidentLifecycle(input.incidentId);

  expect(first.created).toBe(true);
  expect(duplicate).toMatchObject({ created: false, record: { eventId: first.record.eventId } });
  expect(otherIncident.created).toBe(true);
  expect(lifecycle.verificationEvents).toHaveLength(1);
  expect(lifecycle.projection).toMatchObject({ state: "recovering", verificationOutcome: "unresolved" });
  expect(lifecycle.candidates).toEqual([
    expect.objectContaining({ category: "unresolved_mitigation", status: "pending" }),
  ]);
});

test("in-memory recovery budgets isolate failure classes, stop at three, and reset with audit", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await store.recordRecoveryFailure({
      incidentId: "INC-2026-015",
      runId: "run-1",
      sourceEventKey: `provider:${attempt}`,
      failureClass: "provider_unavailable",
      rationale: "Provider request failed.",
    }, { now: new Date(`2026-10-13T12:0${attempt}:00.000Z`) });
    expect(result.created).toBe(true);
    expect(result.budget.attempts).toBe(attempt);
  }

  const blocked = await store.recordRecoveryFailure({
    incidentId: "INC-2026-015",
    runId: "run-1",
    sourceEventKey: "provider:4",
    failureClass: "provider_unavailable",
    rationale: "Provider request failed again.",
  });
  const connector = await store.recordRecoveryFailure({
    incidentId: "INC-2026-015",
    runId: "run-1",
    sourceEventKey: "connector:1",
    failureClass: "connector_failure",
    rationale: "Loki timed out.",
  }, { now: new Date("2026-10-13T12:03:30.000Z") });
  const reset = await store.resetRecoveryBudget({
    incidentId: "INC-2026-015",
    runId: "run-1",
    sourceEventKey: "reset:provider:1",
    failureClass: "provider_unavailable",
    reason: "operator_reset",
    actor: "operator:local-sre",
    rationale: "Provider health is restored.",
  }, { now: new Date("2026-10-13T12:04:00.000Z") });
  const lifecycle = await store.getIncidentLifecycle("INC-2026-015");
  await store.recordVerificationOutcome({
    incidentId: "INC-2026-015",
    sourceEventKey: "verification:resolved-after-exhaustion",
    verification: {
      outcome: "resolved",
      source: "operator",
      sourceReference: "operator:local-sre",
      runId: "run-1",
      evidenceIds: ["verification:latency"],
      rationale: "Independent evidence confirms recovery.",
    },
  }, { now: new Date("2026-10-13T12:04:00.000Z") });
  const resolvedLifecycle = await store.getIncidentLifecycle("INC-2026-015");

  expect(blocked.created).toBe(false);
  expect(blocked.budget).toMatchObject({ attempts: 3, exhausted: true });
  expect(connector.budget).toMatchObject({ attempts: 1, exhausted: false });
  expect(reset).toMatchObject({ created: true, budget: { attempts: 0, exhausted: false, generation: 1 } });
  expect(lifecycle.recoveryEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ eventType: "exhausted", failureClass: "provider_unavailable" }),
    expect.objectContaining({ eventType: "reset", actor: "operator:local-sre" }),
  ]));
  expect(lifecycle.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: "recovery_exhausted", status: "pending" }),
  ]));
  expect(resolvedLifecycle.projection.state).toBe("resolved");
});

test("in-memory outcome candidates are reduced, idempotent, and importable", async () => {
  const store = new InMemoryTriageRunPersistenceStore();
  const input = {
    incidentId: "INC-2026-015",
    runId: "run-1",
    sourceEventId: "feedback:1",
    category: "corrected_finding" as const,
    rationale: "The deploy preceded the alert by three days.",
    evidenceIds: ["deploy:0", "alert:0"],
    snapshot: { incident_class: "bad_deploy", next_action: "request_rollback_approval" },
  };

  const first = await store.recordOutcomeReviewCandidate(input);
  const duplicate = await store.recordOutcomeReviewCandidate(input);
  const imported = await store.markOutcomeReviewCandidateImported(first.candidate.candidateId);

  expect(first.created).toBe(true);
  expect(duplicate).toMatchObject({ created: false, candidate: { candidateId: first.candidate.candidateId } });
  expect(imported.status).toBe("imported");
  expect(await store.listOutcomeReviewCandidates({ status: "pending" })).toHaveLength(0);
  expect(await store.listOutcomeReviewCandidates({ status: "imported" })).toHaveLength(1);
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

  expect(cleanup).toEqual({
    incidentRunsDeleted: 1,
    evidenceSnapshotsDeleted: 1,
    evidenceGateDecisionsDeleted: 0,
    replayKeysDeleted: 1,
    verificationEventsDeleted: 0,
    recoveryEventsDeleted: 0,
    recoveryBudgetsDeleted: 0,
    outcomeCandidatesDeleted: 0,
  });
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

function gateCandidate(overrides: {
  candidateDigest: string;
  decision: MaterialityDecision;
  priorRunId?: string;
}) {
  return {
    incidentId: "INC-2026-014",
    candidateDigest: overrides.candidateDigest,
    canonicalizationVersion: "v1",
    delta: emptyDelta(),
    decision: overrides.decision,
    ...(overrides.priorRunId ? { priorRunId: overrides.priorRunId } : {}),
  };
}

function materialityDecision(
  outcome: MaterialityDecision["outcome"],
  basis: MaterialityDecision["basis"],
): MaterialityDecision {
  return { outcome, basis, rationale: `${basis} decision`, citedDeltaRefs: [] };
}

function emptyDelta(): EvidenceDelta {
  return {
    added: [],
    removed: [],
    incidentChanges: [],
    addedMissingContext: [],
    resolvedMissingContext: [],
  };
}
