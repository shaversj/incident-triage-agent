import { describe, expect, test } from "vitest";

import {
  applyLifecycleEvent,
  classifyRecoveryFailure,
  initialLifecycleProjection,
  parseVerificationOutcomeInput,
  type IncidentLifecycleProjection,
} from "../src/incident-lifecycle";

const baseProjection: IncidentLifecycleProjection = initialLifecycleProjection({
  incidentId: "INC-2026-015",
  runId: "run-1",
  verificationRequired: true,
  approvalStatus: "human_approved",
});

describe("incident lifecycle", () => {
  test("approval for a verification-required mitigation waits for independent verification", () => {
    expect(baseProjection.state).toBe("awaiting_verification");
    expect(baseProjection.verificationOutcome).toBeUndefined();
  });

  test.each([
    ["resolved", "resolved"],
    ["unresolved", "recovering"],
    ["inconclusive", "awaiting_verification"],
  ] as const)("projects %s verification to %s", (outcome, expectedState) => {
    const verification = parseVerificationOutcomeInput({
      outcome,
      source: "operator",
      sourceReference: "operator:local-sre",
      runId: "run-1",
      evidenceIds: ["verification:latency"],
      rationale: `Operator recorded ${outcome}.`,
    });

    const projected = applyLifecycleEvent(baseProjection, {
      type: "verification_recorded",
      eventId: `verification:${outcome}`,
      incidentId: baseProjection.incidentId,
      createdAt: "2026-10-13T12:00:00.000Z",
      verification,
    });

    expect(projected.state).toBe(expectedState);
    expect(projected.verificationOutcome).toBe(outcome);
  });

  test("rejects a resolved claim without independent evidence", () => {
    expect(() => parseVerificationOutcomeInput({
      outcome: "resolved",
      source: "workflow",
      sourceReference: "llm:decision",
      runId: "run-1",
      evidenceIds: [],
      rationale: "The model says the service recovered.",
    })).toThrow(/source/i);

    expect(() => parseVerificationOutcomeInput({
      outcome: "resolved",
      source: "operator",
      sourceReference: "operator:local-sre",
      runId: "run-1",
      evidenceIds: [],
      rationale: "Looks good.",
    })).toThrow(/evidence/i);
  });

  test("classifies only bounded transient and unresolved failures as retryable", () => {
    expect(classifyRecoveryFailure("provider_unavailable")).toBe("provider_unavailable");
    expect(classifyRecoveryFailure("invalid_model_output")).toBe("invalid_model_output");
    expect(classifyRecoveryFailure("connector_failure")).toBe("connector_failure");
    expect(classifyRecoveryFailure("unresolved_mitigation")).toBe("unresolved_mitigation");
    expect(classifyRecoveryFailure("missing_evidence")).toBeUndefined();
    expect(classifyRecoveryFailure("policy_block")).toBeUndefined();
  });

  test("only material evidence reopens a resolved lifecycle", () => {
    const resolved = applyLifecycleEvent(baseProjection, {
      type: "verification_recorded",
      eventId: "verification:resolved",
      incidentId: baseProjection.incidentId,
      createdAt: "2026-10-13T12:00:00.000Z",
      verification: parseVerificationOutcomeInput({
        outcome: "resolved",
        source: "observability",
        sourceReference: "grafana:webhook:123",
        runId: "run-1",
        evidenceIds: ["verification:latency"],
        rationale: "Latency and error rate returned to baseline.",
      }),
    });

    expect(() => applyLifecycleEvent(resolved, {
      type: "reentry_recorded",
      eventId: "reentry:suppressed",
      incidentId: resolved.incidentId,
      createdAt: "2026-10-13T12:05:00.000Z",
      material: false,
      runId: "run-1",
    })).toThrow(/material/i);

    expect(applyLifecycleEvent(resolved, {
      type: "reentry_recorded",
      eventId: "reentry:material",
      incidentId: resolved.incidentId,
      createdAt: "2026-10-13T12:06:00.000Z",
      material: true,
      runId: "run-2",
    }).state).toBe("open");
  });
});
