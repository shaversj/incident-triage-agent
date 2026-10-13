import {
  classifyRecoveryFailure,
  type RecoveryFailureKind,
} from "./incident-lifecycle";

export type RecoveryPolicyDecision =
  | { action: "reserve_attempt"; failureClass: NonNullable<ReturnType<typeof classifyRecoveryFailure>> }
  | { action: "needs_human"; reason: "missing_evidence" | "policy_block" };

export function decideRecoveryPolicy(kind: RecoveryFailureKind): RecoveryPolicyDecision {
  const failureClass = classifyRecoveryFailure(kind);
  if (failureClass) {
    return { action: "reserve_attempt", failureClass };
  }
  return { action: "needs_human", reason: kind === "missing_evidence" ? "missing_evidence" : "policy_block" };
}
