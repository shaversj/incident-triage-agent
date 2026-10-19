import { expect, test } from "vitest";

import { decodeTriageRunReviewEnvelope } from "../src/persistence/postgres-row-mapping";

test("persisted review decoder accepts absent partial and additive envelopes", () => {
  expect(decodeTriageRunReviewEnvelope(null)).toBeUndefined();
  expect(decodeTriageRunReviewEnvelope({})).toEqual({});
  expect(decodeTriageRunReviewEnvelope({
    validation: { valid: false, errors: ["decision was invalid"] },
    unknown_future_field: { retained_by_writer: true },
  })).toEqual({
    validation: { valid: false, errors: ["decision was invalid"] },
  });
});

test("persisted review decoder returns canonical decision data", () => {
  expect(decodeTriageRunReviewEnvelope({
    decision: {
      incidentClass: "bad_deploy",
      nextAction: "request_rollback_approval",
      confidence: 0.91,
      evidenceIds: ["deploy:0"],
      caveats: [],
      verificationPlan: ["Check latency after rollback."],
      ignored_future_field: true,
    },
  })).toEqual({
    decision: {
      incidentClass: "bad_deploy",
      nextAction: "request_rollback_approval",
      confidence: 0.91,
      evidenceIds: ["deploy:0"],
      caveats: [],
      verificationPlan: ["Check latency after rollback."],
    },
  });
});

test("persisted review decoder rejects malformed known fields", () => {
  expect(() => decodeTriageRunReviewEnvelope({
    decision: {
      incidentClass: "invented_class",
      nextAction: "request_rollback_approval",
      confidence: 0.91,
      evidenceIds: ["deploy:0"],
      caveats: [],
      verificationPlan: [],
    },
  })).toThrow(/review_envelope\.decision\.incidentClass/);

  expect(() => decodeTriageRunReviewEnvelope({
    validation: { valid: "yes", errors: [] },
  })).toThrow(/review_envelope\.validation\.valid/);
});

test("persisted review decoder rejects executable artifacts", () => {
  expect(() => decodeTriageRunReviewEnvelope({
    mitigationControl: {
      status: "approval_required",
      approvalRequired: true,
      reason: "Approval is required.",
      evidenceChecks: [],
      dryRun: { status: "simulated", summary: "Rollback simulation.", executed: true },
    },
  })).toThrow(/review_envelope\.mitigationControl\.dryRun\.executed/);
});
