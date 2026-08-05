import { expect, test } from "vitest";

import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { PostgresTriageRunPersistenceStore } from "../src/persistence";
import { TriageWorkflow } from "../src/workflow";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test.runIf(Boolean(databaseUrl))("Postgres persistence migrates records review envelopes replay keys and cleanup", async () => {
  const store = new PostgresTriageRunPersistenceStore({ connectionString: databaseUrl! });
  try {
    await store.migrate();
    const run = await runScenario();
    const recorded = await store.recordTriageRun(run, {
      correlationId: "postgres-integration",
      now: new Date("2026-08-01T12:00:00.000Z"),
      ttlMs: 1_000,
    });
    const review = await store.getTriageRunReview(recorded.runId);
    const listed = await store.listTriageRuns({ limit: 5 });
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
        runId: recorded.runId,
        incidentTitle: "Checkout API latency after retry rollout",
        severity: "SEV2",
      }),
    ]));
    expect(review?.evidenceSnapshot?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: "deploy:0" }),
    ]));
    expect(firstClaim.accepted).toBe(true);
    expect(duplicateClaim.accepted).toBe(false);
    expect(cleanup.incidentRunsDeleted).toBeGreaterThanOrEqual(1);
    expect(cleanup.evidenceSnapshotsDeleted).toBeGreaterThanOrEqual(1);
    expect(cleanup.replayKeysDeleted).toBeGreaterThanOrEqual(1);
    expect(await store.getTriageRunReview(recorded.runId)).toBeUndefined();
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
