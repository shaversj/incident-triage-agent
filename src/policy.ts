import type { NextAction } from "./domain";
import type { EvidencePackage } from "./evidence";
import type { TriageDecision } from "./llm";

export const safetyStatuses = [
  "safe_recommendation",
  "approval_required",
  "needs_human_input",
] as const;

export type SafetyStatus = (typeof safetyStatuses)[number];

export interface StagedPayload {
  incidentId: string;
  service: string;
  nextAction: NextAction;
  incidentClass: TriageDecision["incidentClass"];
  confidence: number;
  evidenceIds: string[];
  verificationPlan: string[];
  executed: false;
}

export interface AuditEvent {
  event: "simulated_action_staged";
  incidentId: string;
  nextAction: NextAction;
  executed: false;
}

export interface SafetyResult {
  status: SafetyStatus;
  approvalRequired: boolean;
  reason: string;
  stagedPayload?: StagedPayload;
  auditEvent?: AuditEvent;
}

export const approvalRequiredActions = new Set<NextAction>([
  "request_rollback_approval",
  "apply_runbook_step_with_approval",
]);

export function evaluateSafety(decision: TriageDecision, evidencePackage: EvidencePackage): SafetyResult {
  if (
    decision.nextAction === "apply_runbook_step_with_approval" &&
    !hasEvidenceSource(evidencePackage, "runbook")
  ) {
    return {
      status: "needs_human_input",
      approvalRequired: false,
      reason: "Runbook-guided action requires runbook context before it can be staged.",
    };
  }

  if (approvalRequiredActions.has(decision.nextAction) && !hasEvidenceSource(evidencePackage, "verification")) {
    return {
      status: "needs_human_input",
      approvalRequired: false,
      reason: "Approval-sensitive action requires verification signals before it can be staged.",
    };
  }

  if (approvalRequiredActions.has(decision.nextAction)) {
    const stagedPayload = buildStagedPayload(decision, evidencePackage);
    return {
      status: "approval_required",
      approvalRequired: true,
      reason: "Action requires human approval; simulated payload staged and not executed.",
      stagedPayload,
      auditEvent: {
        event: "simulated_action_staged",
        incidentId: evidencePackage.incident.incidentId,
        nextAction: decision.nextAction,
        executed: false,
      },
    };
  }

  if (decision.nextAction === "ask_human") {
    return {
      status: "needs_human_input",
      approvalRequired: false,
      reason: "Decision selected human input as the safest next step.",
    };
  }

  return {
    status: "safe_recommendation",
    approvalRequired: false,
    reason: "Recommendation is non-mutating and can be presented with caveats.",
  };
}

function buildStagedPayload(decision: TriageDecision, evidencePackage: EvidencePackage): StagedPayload {
  return {
    incidentId: evidencePackage.incident.incidentId,
    service: evidencePackage.incident.service,
    nextAction: decision.nextAction,
    incidentClass: decision.incidentClass,
    confidence: decision.confidence,
    evidenceIds: decision.evidenceIds,
    verificationPlan: decision.verificationPlan,
    executed: false,
  };
}

function hasEvidenceSource(evidencePackage: EvidencePackage, source: string): boolean {
  return evidencePackage.evidence.some((item) => item.source === source);
}
