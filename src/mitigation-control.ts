import type { IncidentClass, NextAction } from "./domain";
import type { EvidencePackage } from "./evidence";
import type { TriageDecision } from "./llm";

export const mitigationControlStatuses = [
  "recommendation_only",
  "approval_required",
  "blocked",
] as const;

export type MitigationControlStatus = (typeof mitigationControlStatuses)[number];

export const mitigationVerificationStatuses = [
  "not_applicable",
  "recovered",
  "still_unhealthy",
] as const;

export type MitigationVerificationStatus = (typeof mitigationVerificationStatuses)[number];

export interface MitigationCatalogEntry {
  catalogId: string;
  incidentClass: IncidentClass;
  nextAction: NextAction;
  actionIntent: string;
  requiredEvidenceSources: string[];
  approvalRequired: boolean;
  dryRunRequired: boolean;
  verificationRequired: boolean;
}

export interface MitigationCatalogMatch {
  catalogId: string;
  actionIntent: string;
}

export interface MitigationEvidenceCheck {
  source: string;
  passed: boolean;
}

export interface MitigationDryRun {
  status: "simulated";
  summary: string;
  executed: false;
}

export interface MitigationStagedAction {
  incidentId: string;
  service: string;
  catalogId: string;
  actionIntent: string;
  nextAction: NextAction;
  incidentClass: IncidentClass;
  confidence: number;
  evidenceIds: string[];
  verificationPlan: string[];
  executed: false;
}

export interface MitigationAuditEvent {
  event: "mitigation_control_decision";
  incidentId: string;
  status: MitigationControlStatus;
  nextAction: NextAction;
  catalogId?: string;
  executed: false;
}

export interface MitigationVerification {
  status: MitigationVerificationStatus;
  signals: string[];
  reason: string;
}

export interface MitigationControlResult {
  status: MitigationControlStatus;
  approvalRequired: boolean;
  reason: string;
  evidenceChecks: MitigationEvidenceCheck[];
  catalogMatch?: MitigationCatalogMatch;
  dryRun?: MitigationDryRun;
  stagedAction?: MitigationStagedAction;
  auditEvent?: MitigationAuditEvent;
  verification?: MitigationVerification;
}

export const mitigationCatalog = [
  {
    catalogId: "rollback-approval",
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
    actionIntent: "Request human approval for rollback of the suspected deploy.",
    requiredEvidenceSources: ["deploy", "runbook", "verification"],
    approvalRequired: true,
    dryRunRequired: true,
    verificationRequired: true,
  },
  {
    catalogId: "capacity-runbook-approval",
    incidentClass: "capacity_saturation",
    nextAction: "apply_runbook_step_with_approval",
    actionIntent: "Request approval to apply the capacity saturation runbook mitigation.",
    requiredEvidenceSources: ["runbook", "verification"],
    approvalRequired: true,
    dryRunRequired: true,
    verificationRequired: true,
  },
] satisfies MitigationCatalogEntry[];

const mutatingOrApprovalSensitiveActions = new Set<NextAction>([
  "request_rollback_approval",
  "apply_runbook_step_with_approval",
]);

export function evaluateMitigationControl(
  decision: TriageDecision,
  evidencePackage: EvidencePackage,
): MitigationControlResult {
  const catalogEntry = matchCatalog(decision);

  if (!mutatingOrApprovalSensitiveActions.has(decision.nextAction)) {
    return {
      status: "recommendation_only",
      approvalRequired: false,
      reason: "Decision is non-mutating; mitigation control records recommendation-only governance.",
      evidenceChecks: [],
      verification: classifyVerification(evidencePackage, false),
    };
  }

  if (!catalogEntry) {
    return {
      status: "blocked",
      approvalRequired: false,
      reason: "Mutating or approval-sensitive action did not match the approved mitigation catalog.",
      evidenceChecks: [],
      auditEvent: auditEvent(decision, evidencePackage, "blocked"),
      verification: classifyVerification(evidencePackage, false),
    };
  }

  const evidenceChecks = catalogEntry.requiredEvidenceSources.map((source) => ({
    source,
    passed: hasEvidenceSource(evidencePackage, source),
  }));
  const missing = evidenceChecks.filter((check) => !check.passed).map((check) => check.source);
  const catalogMatch = {
    catalogId: catalogEntry.catalogId,
    actionIntent: catalogEntry.actionIntent,
  };

  if (missing.length > 0) {
    const reason = missing.includes("runbook")
      ? `Runbook-guided mitigation requires missing evidence: ${missing.join(", ")}.`
      : `Mitigation catalog match requires missing evidence: ${missing.join(", ")}.`;
    return {
      status: "blocked",
      approvalRequired: false,
      reason,
      catalogMatch,
      evidenceChecks,
      auditEvent: auditEvent(decision, evidencePackage, "blocked", catalogEntry),
      verification: classifyVerification(evidencePackage, catalogEntry.verificationRequired),
    };
  }

  const result: MitigationControlResult = {
    status: "approval_required",
    approvalRequired: catalogEntry.approvalRequired,
    reason: "Mitigation matches approved catalog; dry-run and staged action recorded for human approval without execution.",
    catalogMatch,
    evidenceChecks,
    stagedAction: {
      incidentId: evidencePackage.incident.incidentId,
      service: evidencePackage.incident.service,
      catalogId: catalogEntry.catalogId,
      actionIntent: catalogEntry.actionIntent,
      nextAction: decision.nextAction,
      incidentClass: decision.incidentClass,
      confidence: decision.confidence,
      evidenceIds: decision.evidenceIds,
      verificationPlan: decision.verificationPlan,
      executed: false,
    },
    auditEvent: auditEvent(decision, evidencePackage, "approval_required", catalogEntry),
    verification: classifyVerification(evidencePackage, catalogEntry.verificationRequired),
  };
  if (catalogEntry.dryRunRequired) {
    result.dryRun = {
      status: "simulated",
      summary: `Dry-run simulated for ${catalogEntry.actionIntent}`,
      executed: false,
    };
  }
  return result;
}

function matchCatalog(decision: TriageDecision): MitigationCatalogEntry | undefined {
  return mitigationCatalog.find((entry) =>
    entry.incidentClass === decision.incidentClass && entry.nextAction === decision.nextAction
  );
}

function auditEvent(
  decision: TriageDecision,
  evidencePackage: EvidencePackage,
  status: MitigationControlStatus,
  catalogEntry?: MitigationCatalogEntry,
): MitigationAuditEvent {
  const event: MitigationAuditEvent = {
    event: "mitigation_control_decision",
    incidentId: evidencePackage.incident.incidentId,
    status,
    nextAction: decision.nextAction,
    executed: false,
  };
  if (catalogEntry) {
    event.catalogId = catalogEntry.catalogId;
  }
  return event;
}

function classifyVerification(
  evidencePackage: EvidencePackage,
  required: boolean,
): MitigationVerification {
  const signals = evidencePackage.incident.verificationSignals;
  if (!required && signals.length === 0) {
    return {
      status: "not_applicable",
      signals,
      reason: "No verification expectation applies to recommendation-only governance.",
    };
  }

  const text = signals.join(" ").toLowerCase();
  const stillUnhealthy = /\b(remains?\s+(?:elevated|above|unhealthy)|elevated|above|increasing|timeout rate|burn)\b/.test(text);
  const recovered = /\b(back within|below|normal|healthy|recovered|stable|baseline)\b/.test(text);

  if (stillUnhealthy) {
    return {
      status: "still_unhealthy",
      signals,
      reason: "Recorded verification signals still show unhealthy service conditions.",
    };
  }
  if (recovered) {
    return {
      status: "recovered",
      signals,
      reason: "Recorded verification signals show recovery or stable health.",
    };
  }
  return {
    status: required ? "still_unhealthy" : "not_applicable",
    signals,
    reason: required
      ? "Verification was required, but recorded signals did not prove recovery."
      : "No verification expectation applies to this branch.",
  };
}

function hasEvidenceSource(evidencePackage: EvidencePackage, source: string): boolean {
  return evidencePackage.evidence.some((item) => item.source === source);
}
