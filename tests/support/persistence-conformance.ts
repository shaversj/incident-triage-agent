import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loadScenario } from "../../src/domain";
import { EvidencePackage, loadTools } from "../../src/evidence";
import { StaticDecisionClient } from "../../src/llm";
import {
  buildReplayKey,
  type EvidenceGateCandidate,
  type OutcomeReviewCandidateInput,
  type TriageRunPersistenceStore,
} from "../../src/persistence";
import type { EvidenceDelta, MaterialityDecision } from "../../src/reentry";
import { TriageWorkflow, type TriageRun } from "../../src/workflow";

export interface PersistenceConformanceHarness {
  createStore: () => Promise<TriageRunPersistenceStore> | TriageRunPersistenceStore;
  teardownStore?: (store: TriageRunPersistenceStore) => Promise<void> | void;
  enabled?: boolean;
}

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

export function registerPersistenceConformanceSuite(
  backendName: string,
  harness: PersistenceConformanceHarness,
): void {
  const suite = harness.enabled === false ? describe.skip : describe.sequential;

  suite(`${backendName} persistence conformance`, () => {
    const namespace = randomUUID();
    let store: TriageRunPersistenceStore;
    let completedTemplate: TriageRun;
    let recoverableTemplate: TriageRun;
    let epochMs: number;

    beforeAll(async () => {
      store = await harness.createStore();
      [completedTemplate, recoverableTemplate] = await Promise.all([
        runScenario("bad-deploy-latency", {
          incident_class: "bad_deploy",
          next_action: "request_rollback_approval",
          confidence: 0.9,
          evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
          caveats: [],
          verification_plan: ["Check checkout latency."],
        }),
        runScenario("checkout-payment-timeout", "{not json"),
      ]);
      const [latest] = await store.listTriageRuns({ limit: 1 });
      const latestMs = latest ? Date.parse(latest.createdAt) : Number.NaN;
      epochMs = Math.max(
        Date.parse("2036-01-01T00:00:00.000Z"),
        Number.isFinite(latestMs) ? latestMs + dayMs : 0,
      );
    });

    afterAll(async () => {
      if (store) {
        await harness.teardownStore?.(store);
      }
    });

    function key(caseName: string, value: string): string {
      return `${namespace}:${caseName}:${value}`;
    }

    function clock(offsetMinutes: number): Date {
      return new Date(epochMs + offsetMinutes * minuteMs);
    }

    function completedRun(caseName: string, value: string, incidentId?: string): TriageRun {
      return identifyRun(completedTemplate, key(caseName, value), incidentId);
    }

    function recoverableRun(caseName: string, value: string): TriageRun {
      return identifyRun(recoverableTemplate, key(caseName, value));
    }

    test("retains separate completed and recoverable review envelopes and evidence snapshots", async () => {
      const caseName = "review-records";
      const completed = completedRun(caseName, "completed");
      const recoverable = recoverableRun(caseName, "recoverable");

      await store.recordTriageRun(completed, {
        correlationId: key(caseName, "completed-correlation"),
        now: clock(10),
      });
      await store.recordTriageRun(recoverable, {
        correlationId: key(caseName, "recoverable-correlation"),
        now: clock(11),
      });

      const completedReview = await store.getTriageRunReview(completed.runId);
      const recoverableReview = await store.getTriageRunReview(recoverable.runId);

      expect(completedReview?.run.reviewEnvelope?.decision).toMatchObject({
        incidentClass: "bad_deploy",
        nextAction: "request_rollback_approval",
      });
      expect(completedReview?.run.reviewEnvelope?.validation).toEqual({ valid: true, errors: [] });
      expect(completedReview?.evidenceSnapshot?.runId).toBe(completed.runId);
      expect(completedReview?.evidenceSnapshot?.evidence).toHaveLength(
        completed.evidencePackage?.evidence.length ?? 0,
      );
      expect(recoverableReview?.run).toMatchObject({
        runId: recoverable.runId,
        runStatus: "recoverable_failure",
        validationStatus: "invalid",
      });
      expect(recoverableReview?.run.reviewEnvelope?.decision).toBeUndefined();
      expect(recoverableReview?.run.reviewEnvelope?.safety).toBeUndefined();
      expect(recoverableReview?.evidenceSnapshot?.runId).toBe(recoverable.runId);
      expect(recoverableReview?.evidenceSnapshot?.evidence).toHaveLength(
        recoverable.evidencePackage?.evidence.length ?? 0,
      );
    });

    test("lists newest runs first and applies bounded limits", async () => {
      const caseName = "run-list";
      const first = completedRun(caseName, "first");
      const second = completedRun(caseName, "second");
      const third = completedRun(caseName, "third");

      await store.recordTriageRun(first, { now: clock(20) });
      await store.recordTriageRun(second, { now: clock(21) });
      await store.recordTriageRun(third, { now: clock(22) });

      expect((await store.listTriageRuns({ limit: 2 })).map((run) => run.runId)).toEqual([
        third.runId,
        second.runId,
      ]);
      expect((await store.listTriageRuns({ limit: 0 })).map((run) => run.runId)).toEqual([
        third.runId,
      ]);
    });

    test("requires unexpired run and snapshot records for baseline lookup", async () => {
      const caseName = "baseline-expiry";
      const current = completedRun(caseName, "current");
      const expired = completedRun(caseName, "expired");

      await store.recordTriageRun(current, { now: clock(30), ttlMs: 2 * minuteMs });
      await store.recordTriageRun(expired, { now: clock(31), ttlMs: 1_000 });

      const baseline = await store.getLatestIncidentBaseline(current.scenario.incident.incidentId, {
        now: clock(31),
      });
      const expiredBaseline = await store.getLatestIncidentBaseline(expired.scenario.incident.incidentId, {
        now: clock(32),
      });

      expect(baseline).toMatchObject({
        run: { runId: current.runId },
        evidenceSnapshot: { runId: current.runId },
      });
      expect(expiredBaseline).toBeUndefined();
    });

    test("scopes gate idempotency to the baseline and preserves child lineage", async () => {
      const caseName = "gate-lineage";
      const parent = completedRun(caseName, "parent");
      const firstChild = completedRun(caseName, "first-child");
      const suppressedChild = completedRun(caseName, "suppressed-child");
      const nextChild = completedRun(caseName, "next-child");
      const digest = key(caseName, "digest");
      await store.recordTriageRun(parent, { now: clock(40) });

      const first = await store.recordGatedTriageRun(
        firstChild,
        gateCandidate(parent.scenario.incident.incidentId, {
          priorRunId: parent.runId,
          candidateDigest: digest,
          decision: materialityDecision("material", "deterministic_policy", "first child"),
        }),
        { now: clock(41) },
      );
      const duplicate = await store.recordGatedTriageRun(
        suppressedChild,
        gateCandidate(parent.scenario.incident.incidentId, {
          priorRunId: parent.runId,
          candidateDigest: digest,
          decision: materialityDecision("material", "deterministic_policy", "duplicate child"),
        }),
        { now: clock(42) },
      );
      const nextBaseline = await store.recordGatedTriageRun(
        nextChild,
        gateCandidate(parent.scenario.incident.incidentId, {
          priorRunId: firstChild.runId,
          candidateDigest: digest,
          decision: materialityDecision("material", "deterministic_policy", "next baseline"),
        }),
        { now: clock(43) },
      );

      expect(first).toMatchObject({
        created: true,
        run: { runId: firstChild.runId, parentRunId: parent.runId },
        decision: { childRunId: firstChild.runId, priorRunId: parent.runId },
      });
      expect(duplicate).toMatchObject({
        created: false,
        run: { runId: firstChild.runId },
        decision: { decisionId: first.decision.decisionId },
      });
      expect(await store.getTriageRunReview(suppressedChild.runId)).toBeUndefined();
      expect(nextBaseline).toMatchObject({
        created: true,
        run: { runId: nextChild.runId, parentRunId: firstChild.runId },
      });
      expect(nextBaseline.decision.decisionId).not.toBe(first.decision.decisionId);
    });

    test("writes verification idempotently and creates one unresolved review candidate", async () => {
      const caseName = "verification";
      const incidentId = key(caseName, "incident");
      const sourceEventKey = key(caseName, "source");
      const input = verificationInput(incidentId, sourceEventKey, key(caseName, "run"), "unresolved");

      const first = await store.recordVerificationOutcome(input, { now: clock(50) });
      const duplicate = await store.recordVerificationOutcome(input, { now: clock(51) });
      const lifecycle = await store.getIncidentLifecycle(incidentId);

      expect(first.created).toBe(true);
      expect(duplicate).toMatchObject({ created: false, record: { eventId: first.record.eventId } });
      expect(lifecycle.verificationEvents).toHaveLength(1);
      expect(lifecycle.projection).toMatchObject({ state: "recovering", verificationOutcome: "unresolved" });
      expect(lifecycle.candidates).toEqual([
        expect.objectContaining({ category: "unresolved_mitigation", status: "pending" }),
      ]);
    });

    test("isolates recovery budgets by failure class, exhausts at three, and resets with audit", async () => {
      const caseName = "recovery-budget";
      const incidentId = key(caseName, "incident");
      const runId = key(caseName, "run");

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await store.recordRecoveryFailure({
          incidentId,
          runId,
          sourceEventKey: key(caseName, `provider-${attempt}`),
          failureClass: "provider_unavailable",
          rationale: `Provider request ${attempt} failed.`,
        }, { now: clock(60 + attempt) });
        expect(result).toMatchObject({ created: true, budget: { attempts: attempt } });
      }

      const blocked = await store.recordRecoveryFailure({
        incidentId,
        runId,
        sourceEventKey: key(caseName, "provider-4"),
        failureClass: "provider_unavailable",
        rationale: "Provider request failed after exhaustion.",
      }, { now: clock(64) });
      const connector = await store.recordRecoveryFailure({
        incidentId,
        runId,
        sourceEventKey: key(caseName, "connector-1"),
        failureClass: "connector_failure",
        rationale: "Loki timed out.",
      }, { now: clock(65) });
      const reset = await store.resetRecoveryBudget({
        incidentId,
        runId,
        sourceEventKey: key(caseName, "reset-1"),
        failureClass: "provider_unavailable",
        reason: "operator_reset",
        actor: "operator:conformance",
        rationale: "Provider health is restored.",
      }, { now: clock(66) });
      const lifecycle = await store.getIncidentLifecycle(incidentId);

      expect(blocked).toMatchObject({ created: false, budget: { attempts: 3, exhausted: true } });
      expect(connector).toMatchObject({ created: true, budget: { attempts: 1, exhausted: false } });
      expect(reset).toMatchObject({
        created: true,
        budget: { attempts: 0, exhausted: false, generation: 1 },
        event: { eventType: "reset", actor: "operator:conformance", generation: 1 },
      });
      expect(lifecycle.recoveryEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "exhausted", failureClass: "provider_unavailable" }),
        expect.objectContaining({ eventType: "reset", failureClass: "provider_unavailable" }),
      ]));
      expect(lifecycle.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: "recovery_exhausted", status: "pending" }),
      ]));
    });

    test("filters outcome candidates, creates them idempotently, and records import transitions", async () => {
      const caseName = "outcome-candidates";
      const incidentId = key(caseName, "incident");
      const otherIncidentId = key(caseName, "other-incident");
      const input = outcomeCandidateInput(
        incidentId,
        key(caseName, "source"),
        key(caseName, "run"),
      );
      const other = outcomeCandidateInput(
        otherIncidentId,
        key(caseName, "other-source"),
        key(caseName, "other-run"),
      );

      const first = await store.recordOutcomeReviewCandidate(input, { now: clock(70) });
      const duplicate = await store.recordOutcomeReviewCandidate(input, { now: clock(71) });
      await store.recordOutcomeReviewCandidate(other, { now: clock(72) });
      const imported = await store.markOutcomeReviewCandidateImported(first.candidate.candidateId, {
        now: clock(73),
      });

      expect(first.created).toBe(true);
      expect(duplicate).toMatchObject({
        created: false,
        candidate: { candidateId: first.candidate.candidateId },
      });
      expect(imported).toMatchObject({ status: "imported", importedAt: clock(73).toISOString() });
      expect(await store.listOutcomeReviewCandidates({ incidentId, status: "pending" })).toHaveLength(0);
      expect(await store.listOutcomeReviewCandidates({ incidentId, status: "imported" })).toEqual([
        expect.objectContaining({ candidateId: first.candidate.candidateId }),
      ]);
      expect(await store.listOutcomeReviewCandidates({ incidentId: otherIncidentId, limit: 1 })).toEqual([
        expect.objectContaining({ incidentId: otherIncidentId }),
      ]);
    });

    test("rejects duplicate replay keys until release or expiry", async () => {
      const caseName = "replay";
      const releasedInput = replayInput(caseName, "released", clock(80), key(caseName, "released-digest"));
      const expiringInput = replayInput(caseName, "expiring", clock(81), key(caseName, "expiring-digest"));

      const first = await store.claimReplayKey(releasedInput);
      expect(first.replayKey).toBe(buildReplayKey(releasedInput));
      expect((await store.claimReplayKey(releasedInput)).accepted).toBe(false);
      await store.releaseReplayKey(first.replayKey);
      expect((await store.claimReplayKey(releasedInput)).accepted).toBe(true);

      const expiring = await store.claimReplayKey(expiringInput);
      expect((await store.claimReplayKey(expiringInput)).accepted).toBe(false);
      const afterExpiry = await store.claimReplayKey({ ...expiringInput, receivedAt: clock(83) });
      expect(expiring.accepted).toBe(true);
      expect(afterExpiry).toMatchObject({ accepted: true, replayKey: expiring.replayKey });
    });

    test("removes expired public records and reports exact cleanup counts", async () => {
      const caseName = "cleanup";
      const now = new Date("1900-01-01T00:00:00.000Z");
      const cutoff = new Date("1900-01-01T00:00:02.000Z");
      await store.cleanupExpired(cutoff);
      const run = completedRun(caseName, "run");
      const incidentId = run.scenario.incident.incidentId;

      await store.recordTriageRun(run, { now, ttlMs: 1_000 });
      await store.recordEvidenceGateDecision(gateCandidate(incidentId, {
        candidateDigest: key(caseName, "gate-digest"),
        decision: materialityDecision("not_material", "equivalent", "cleanup gate"),
      }), { now, ttlMs: 1_000 });
      await store.recordVerificationOutcome(
        verificationInput(incidentId, key(caseName, "verification"), run.runId, "resolved"),
        { now, ttlMs: 1_000 },
      );
      await store.recordRecoveryFailure({
        incidentId,
        runId: run.runId,
        sourceEventKey: key(caseName, "recovery"),
        failureClass: "connector_failure",
        rationale: "Connector failed.",
      }, { now, ttlMs: 1_000 });
      await store.recordOutcomeReviewCandidate(
        outcomeCandidateInput(incidentId, key(caseName, "candidate"), run.runId),
        { now, ttlMs: 1_000 },
      );
      await store.claimReplayKey(replayInput(caseName, "cleanup", now, key(caseName, "replay-digest"), 1_000));

      expect(await store.cleanupExpired(cutoff)).toEqual({
        incidentRunsDeleted: 1,
        evidenceSnapshotsDeleted: 1,
        evidenceGateDecisionsDeleted: 1,
        replayKeysDeleted: 1,
        verificationEventsDeleted: 1,
        recoveryEventsDeleted: 1,
        recoveryBudgetsDeleted: 1,
        outcomeCandidatesDeleted: 1,
      });
      expect(await store.getTriageRunReview(run.runId)).toBeUndefined();
      expect(await store.getIncidentLifecycle(incidentId)).toMatchObject({
        verificationEvents: [],
        recoveryEvents: [],
        recoveryBudgets: [],
        candidates: [],
      });
    });

    test("returns the first idempotent result when later content reuses a key", async () => {
      const caseName = "idempotency-content";
      const incidentId = key(caseName, "incident");
      const parent = completedRun(caseName, "parent", incidentId);
      const firstChild = completedRun(caseName, "first-child", incidentId);
      const secondChild = completedRun(caseName, "second-child", incidentId);
      await store.recordTriageRun(parent, { now: clock(100) });
      const digest = key(caseName, "gate-digest");

      const firstGate = await store.recordGatedTriageRun(firstChild, gateCandidate(incidentId, {
        priorRunId: parent.runId,
        candidateDigest: digest,
        decision: materialityDecision("material", "deterministic_policy", "original gate"),
      }), { now: clock(101) });
      const reusedGate = await store.recordGatedTriageRun(secondChild, gateCandidate(incidentId, {
        priorRunId: parent.runId,
        candidateDigest: digest,
        decision: materialityDecision("not_material", "equivalent", "changed gate"),
      }), { now: clock(102) });

      const verificationKey = key(caseName, "verification-key");
      const firstVerification = await store.recordVerificationOutcome(
        verificationInput(incidentId, verificationKey, firstChild.runId, "unresolved"),
        { now: clock(103) },
      );
      const reusedVerification = await store.recordVerificationOutcome(
        verificationInput(incidentId, verificationKey, secondChild.runId, "resolved"),
        { now: clock(104) },
      );

      const recoveryKey = key(caseName, "recovery-key");
      const firstRecovery = await store.recordRecoveryFailure({
        incidentId,
        runId: firstChild.runId,
        sourceEventKey: recoveryKey,
        failureClass: "provider_unavailable",
        rationale: "Original recovery failure.",
      }, { now: clock(105) });
      const reusedRecovery = await store.recordRecoveryFailure({
        incidentId,
        runId: secondChild.runId,
        sourceEventKey: recoveryKey,
        failureClass: "provider_unavailable",
        rationale: "Changed recovery failure.",
      }, { now: clock(106) });

      const candidateInput = outcomeCandidateInput(
        incidentId,
        key(caseName, "candidate-source"),
        firstChild.runId,
      );
      const firstCandidate = await store.recordOutcomeReviewCandidate(candidateInput, { now: clock(107) });
      const reusedCandidate = await store.recordOutcomeReviewCandidate({
        ...candidateInput,
        runId: secondChild.runId,
        rationale: "Changed candidate rationale.",
        evidenceIds: ["changed:evidence"],
        snapshot: { changed: true },
      }, { now: clock(108) });
      const lifecycle = await store.getIncidentLifecycle(incidentId);

      expect(reusedGate).toMatchObject({
        created: false,
        run: { runId: firstChild.runId },
        decision: { decisionId: firstGate.decision.decisionId, outcome: "material", rationale: "original gate" },
      });
      expect(await store.getTriageRunReview(secondChild.runId)).toBeUndefined();
      expect(reusedVerification).toMatchObject({
        created: false,
        record: { eventId: firstVerification.record.eventId, verification: { outcome: "unresolved" } },
      });
      expect(reusedRecovery).toMatchObject({
        created: false,
        event: { eventId: firstRecovery.event?.eventId, rationale: "Original recovery failure." },
        budget: { attempts: 1 },
      });
      expect(reusedCandidate).toMatchObject({
        created: false,
        candidate: {
          candidateId: firstCandidate.candidate.candidateId,
          rationale: candidateInput.rationale,
          evidenceIds: candidateInput.evidenceIds,
          snapshot: candidateInput.snapshot,
        },
      });
      expect(lifecycle.verificationEvents).toHaveLength(1);
      expect(lifecycle.recoveryEvents.filter((event) => event.eventType === "attempt")).toHaveLength(1);
      expect(lifecycle.recoveryBudgets).toEqual([
        expect.objectContaining({ failureClass: "provider_unavailable", attempts: 1 }),
      ]);
      expect(lifecycle.candidates).toHaveLength(2);
    });

    test("keeps expired records presence-visible until cleanup while excluding them from baselines", async () => {
      const caseName = "presence-before-cleanup";
      const parent = completedRun(caseName, "parent");
      const incidentId = parent.scenario.incident.incidentId;
      const child = completedRun(caseName, "child", incidentId);
      const now = clock(110);
      const afterExpiry = clock(111);
      await store.recordTriageRun(parent, { now, ttlMs: 1_000 });
      await store.recordGatedTriageRun(child, gateCandidate(incidentId, {
        priorRunId: parent.runId,
        candidateDigest: key(caseName, "gate-digest"),
        decision: materialityDecision("material", "deterministic_policy", "expired child"),
      }), { now, ttlMs: 1_000 });
      await store.recordVerificationOutcome(
        verificationInput(incidentId, key(caseName, "verification"), child.runId, "unresolved"),
        { now, ttlMs: 1_000 },
      );

      expect(await store.getLatestIncidentBaseline(incidentId, { now: afterExpiry })).toBeUndefined();
      const listedIds = (await store.listTriageRuns({ limit: 100 })).map((run) => run.runId);
      const review = await store.getTriageRunReview(child.runId);
      const lifecycle = await store.getIncidentLifecycle(incidentId);
      const candidates = await store.listOutcomeReviewCandidates({ incidentId });

      expect(listedIds).toEqual(expect.arrayContaining([parent.runId, child.runId]));
      expect(review).toMatchObject({
        run: { runId: child.runId, parentRunId: parent.runId },
        evidenceSnapshot: { runId: child.runId },
        gateDecision: { childRunId: child.runId },
        parentRunRetained: true,
      });
      expect(lifecycle.verificationEvents).toHaveLength(1);
      expect(lifecycle.candidates).toHaveLength(1);
      expect(candidates).toEqual([
        expect.objectContaining({ category: "unresolved_mitigation", status: "pending" }),
      ]);
    });
  });
}

async function runScenario(scenarioName: string, response: object | string): Promise<TriageRun> {
  const scenario = loadScenario("fixtures", scenarioName);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({
      [scenarioName]: typeof response === "string" ? response : JSON.stringify(response),
    }),
    undefined,
    { mode: "read_only" },
  );
  return workflow.run(scenario);
}

function identifyRun(template: TriageRun, identity: string, incidentId?: string): TriageRun {
  const incident = {
    ...template.scenario.incident,
    incidentId: incidentId ?? `INC-CONFORMANCE:${identity}`,
  };
  const scenario = { ...template.scenario, name: `${template.scenario.name}:${identity}`, incident };
  const evidencePackage = template.evidencePackage
    ? new EvidencePackage(
      scenario.name,
      incident,
      template.evidencePackage.evidence,
      template.evidencePackage.missingContext,
      template.evidencePackage.investigationSteps,
    )
    : undefined;
  return {
    ...template,
    runId: `triage-run:conformance:${identity}`,
    scenario,
    states: [...template.states],
    ...(evidencePackage ? { evidencePackage } : {}),
  };
}

function gateCandidate(
  incidentId: string,
  overrides: {
    candidateDigest: string;
    decision: MaterialityDecision;
    priorRunId?: string;
  },
): EvidenceGateCandidate {
  return {
    incidentId,
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
  rationale: string,
): MaterialityDecision {
  return { outcome, basis, rationale, citedDeltaRefs: [] };
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

function verificationInput(
  incidentId: string,
  sourceEventKey: string,
  runId: string,
  outcome: "resolved" | "unresolved",
) {
  return {
    incidentId,
    sourceEventKey,
    verification: {
      outcome,
      source: "operator" as const,
      sourceReference: "operator:conformance",
      runId,
      evidenceIds: [`verification:${sourceEventKey}`],
      rationale: outcome === "resolved" ? "Recovery is independently verified." : "The incident remains unresolved.",
    },
  };
}

function outcomeCandidateInput(
  incidentId: string,
  sourceEventId: string,
  runId: string,
): OutcomeReviewCandidateInput {
  return {
    incidentId,
    runId,
    sourceEventId,
    category: "corrected_finding",
    rationale: "The original finding needs human review.",
    evidenceIds: [`evidence:${sourceEventId}`],
    snapshot: { incident_class: "bad_deploy", next_action: "request_rollback_approval" },
  };
}

function replayInput(
  caseName: string,
  value: string,
  receivedAt: Date,
  bodyDigest: string,
  ttlMs = minuteMs,
) {
  return {
    sender: `grafana:${caseName}:${value}`,
    signature: `signature:${caseName}:${value}`,
    timestamp: receivedAt.toISOString(),
    bodyDigest,
    receivedAt,
    ttlMs,
  };
}
