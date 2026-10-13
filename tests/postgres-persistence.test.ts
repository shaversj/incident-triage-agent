import { expect, test } from "vitest";

import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { PostgresTriageRunPersistenceStore } from "../src/persistence";
import type { EvidenceDelta, MaterialityDecision } from "../src/reentry";
import { TriageWorkflow } from "../src/workflow";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test.runIf(Boolean(databaseUrl))("Postgres persistence migrates records review envelopes replay keys and cleanup", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  try {
    await store.migrate();
    const run = await runScenario();
    const recorded = await store.recordGatedTriageRun(run, gateCandidate({
      candidateDigest: `candidate:first:${Date.now()}`,
      decision: materialityDecision("first_observation", "no_baseline"),
    }), {
      correlationId: "postgres-integration",
      now: new Date("2026-08-01T12:00:00.000Z"),
      ttlMs: 1_000,
    });
    const childRun = { ...run, runId: `${run.runId}:child:${Date.now()}` };
    const child = await store.recordGatedTriageRun(childRun, gateCandidate({
      priorRunId: recorded.run.runId,
      candidateDigest: `candidate:material:${Date.now()}`,
      decision: materialityDecision("material", "deterministic_policy"),
    }), {
      correlationId: "postgres-integration-child",
      now: new Date("2026-08-01T12:00:00.500Z"),
      ttlMs: 1_000,
    });
    const duplicateCandidate = gateCandidate({
      priorRunId: child.run.runId,
      candidateDigest: `candidate:equivalent:${Date.now()}`,
      decision: materialityDecision("not_material", "equivalent"),
    });
    const firstGateDecision = await store.recordEvidenceGateDecision(duplicateCandidate, {
      now: new Date("2026-08-01T12:00:00.750Z"),
      ttlMs: 1_000,
    });
    const duplicateGateDecision = await store.recordEvidenceGateDecision(duplicateCandidate, {
      now: new Date("2026-08-01T12:00:00.900Z"),
      ttlMs: 1_000,
    });
    const review = await store.getTriageRunReview(child.run.runId);
    const listed = await store.listTriageRuns({ limit: 5 });
    const baseline = await store.getLatestIncidentBaseline(run.scenario.incident.incidentId, {
      now: new Date("2026-08-01T12:00:00.900Z"),
    });
    const expiredBaseline = await store.getLatestIncidentBaseline(run.scenario.incident.incidentId, {
      now: new Date("2026-08-01T12:00:02.000Z"),
    });
    const replayInput = {
      sender: "grafana",
      signature: "sig",
      timestamp: "2026-08-01T12:00:00.000Z",
      bodyDigest: `digest-${Date.now()}`,
      receivedAt: new Date("2026-08-01T12:00:00.000Z"),
      ttlMs: 1_000,
    };
    const firstClaim = await store.claimReplayKey(replayInput);
    const duplicateClaim = await store.claimReplayKey(replayInput);
    const cleanup = await store.cleanupExpired(new Date("2026-08-01T12:00:02.000Z"));

    expect(review?.run.reviewEnvelope?.decision).toMatchObject({
      incidentClass: "bad_deploy",
      nextAction: "request_rollback_approval",
    });
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: recorded.run.runId,
        incidentTitle: "Checkout API latency after retry rollout",
        severity: "SEV2",
      }),
    ]));
    expect(review?.evidenceSnapshot?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: "deploy:0" }),
    ]));
    expect(child.run.parentRunId).toBe(recorded.run.runId);
    expect(review?.gateDecision?.decisionId).toBe(child.decision.decisionId);
    expect(review?.recentGateDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "not_material", priorRunId: child.run.runId }),
    ]));
    expect(baseline?.run.runId).toBe(child.run.runId);
    expect(expiredBaseline).toBeUndefined();
    expect(firstGateDecision.created).toBe(true);
    expect(duplicateGateDecision).toMatchObject({
      created: false,
      decision: { decisionId: firstGateDecision.decision.decisionId },
    });
    expect(firstClaim.accepted).toBe(true);
    expect(duplicateClaim.accepted).toBe(false);
    expect(cleanup.incidentRunsDeleted).toBeGreaterThanOrEqual(1);
    expect(cleanup.evidenceSnapshotsDeleted).toBeGreaterThanOrEqual(1);
    expect(cleanup.replayKeysDeleted).toBeGreaterThanOrEqual(1);
    expect(cleanup.evidenceGateDecisionsDeleted).toBeGreaterThanOrEqual(3);
    expect(await store.getTriageRunReview(recorded.run.runId)).toBeUndefined();
  } finally {
    await store.close();
  }
});

async function runScenario() {
  const scenarioName = "bad-deploy-latency";
  const scenario = loadScenario("fixtures", scenarioName);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({
      [scenarioName]: JSON.stringify({
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
  return workflow.run(scenario);
}

function gateCandidate(overrides: {
  candidateDigest: string;
  decision: MaterialityDecision;
  priorRunId?: string;
}) {
  return {
    incidentId: "INC-2026-015",
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
