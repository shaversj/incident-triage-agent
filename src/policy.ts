import type { OperatorMode } from "./config";
import type { NextAction } from "./domain";
import type { EvidencePackage } from "./evidence";
import type { TriageDecision } from "./llm";
import { evaluateMitigationControl, type MitigationControlResult } from "./mitigation-control";

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
  mitigationControl: MitigationControlResult;
}

export interface SafetyEvaluationOptions {
  mode?: OperatorMode;
}

export const approvalRequiredActions = new Set<NextAction>([
  "request_rollback_approval",
  "apply_runbook_step_with_approval",
]);

export function evaluateSafety(
  decision: TriageDecision,
  evidencePackage: EvidencePackage,
  options: SafetyEvaluationOptions = {},
): SafetyResult {
  const mitigationControl = stripReadOnlyApprovalArtifacts(
    evaluateMitigationControl(decision, evidencePackage),
    options.mode,
  );

  if (mitigationControl.status === "blocked") {
    return {
      status: "needs_human_input",
      approvalRequired: false,
      reason: mitigationControl.reason,
      mitigationControl,
    };
  }

  if (mitigationControl.status === "approval_required") {
    if (options.mode === "read_only") {
      return {
        status: "approval_required",
        approvalRequired: true,
        reason: `${mitigationControl.reason} Read-only mode did not stage approval or action artifacts.`,
        mitigationControl,
      };
    }
    const stagedPayload = buildStagedPayload(decision, evidencePackage);
    return {
      status: "approval_required",
      approvalRequired: true,
      reason: mitigationControl.reason,
      stagedPayload,
      auditEvent: {
        event: "simulated_action_staged",
        incidentId: evidencePackage.incident.incidentId,
        nextAction: decision.nextAction,
        executed: false,
      },
      mitigationControl,
    };
  }

  if (decision.nextAction === "ask_human") {
    return {
      status: "needs_human_input",
      approvalRequired: false,
      reason: "Decision selected human input as the safest next step.",
      mitigationControl,
    };
  }

  return {
    status: "safe_recommendation",
    approvalRequired: false,
    reason: mitigationControl.reason,
    mitigationControl,
  };
}

function stripReadOnlyApprovalArtifacts(
  mitigationControl: MitigationControlResult,
  mode: OperatorMode | undefined,
): MitigationControlResult {
  if (mode !== "read_only" || mitigationControl.status !== "approval_required") {
    return mitigationControl;
  }

  const {
    stagedAction: _stagedAction,
    approvalRequest: _approvalRequest,
    ...safeMitigationControl
  } = mitigationControl;
  return {
    ...safeMitigationControl,
    reason: `${mitigationControl.reason} Read-only mode suppressed approval request and staged action output.`,
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
