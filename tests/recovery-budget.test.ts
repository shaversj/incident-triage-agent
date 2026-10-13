import { expect, test } from "vitest";

import { decideRecoveryPolicy } from "../src/recovery-budget";

test("retryable failures reserve their own class budget", () => {
  expect(decideRecoveryPolicy("provider_unavailable")).toEqual({
    action: "reserve_attempt",
    failureClass: "provider_unavailable",
  });
  expect(decideRecoveryPolicy("connector_failure")).toEqual({
    action: "reserve_attempt",
    failureClass: "connector_failure",
  });
});

test("missing evidence and policy blocks stop for a human without consuming budget", () => {
  expect(decideRecoveryPolicy("missing_evidence")).toEqual({
    action: "needs_human",
    reason: "missing_evidence",
  });
  expect(decideRecoveryPolicy("policy_block")).toEqual({
    action: "needs_human",
    reason: "policy_block",
  });
});
