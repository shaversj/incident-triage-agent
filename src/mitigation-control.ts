import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncidentClass, NextAction } from "./domain";
import { FixtureError, parseIncidentClass, parseNextAction } from "./domain";
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
  runbookId: string;
  incidentClass: IncidentClass;
  nextAction: NextAction;
  actionIntent: string;
  approvalSummary: string;
  approveCommand: string;
  rejectCommand: string;
  requiredEvidenceSources: string[];
  approvalRequired: boolean;
  dryRunRequired: boolean;
  verificationRequired: boolean;
}

export interface MitigationCatalogMatch {
  catalogId: string;
  runbookId: string;
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
  runbookId: string;
  actionIntent: string;
  nextAction: NextAction;
  incidentClass: IncidentClass;
  confidence: number;
  evidenceIds: string[];
  verificationPlan: string[];
  executed: false;
}

export interface HumanApprovalRequest {
  approvalId: string;
  status: "pending_human_approval";
  catalogId: string;
  runbookId: string;
  incidentId: string;
  service: string;
  summary: string;
  approveCommand: string;
  rejectCommand: string;
  executed: false;
}

export interface MitigationAuditEvent {
  event: "mitigation_control_decision";
  incidentId: string;
  status: MitigationControlStatus;
  nextAction: NextAction;
  catalogId?: string;
  runbookId?: string;
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
  approvalRequest?: HumanApprovalRequest;
  auditEvent?: MitigationAuditEvent;
  verification?: MitigationVerification;
}

const defaultMitigationCatalog = [
  {
    catalogId: "rollback-approval",
    runbookId: "bad-deploy",
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
    actionIntent: "Request human approval for rollback of the suspected deploy.",
    approvalSummary: "Rollback approval is required before changing production deploy state.",
    approveCommand: "npm run triage:approval -- approve rollback-approval",
    rejectCommand: "npm run triage:approval -- reject rollback-approval",
    requiredEvidenceSources: ["deploy", "runbook", "verification"],
    approvalRequired: true,
    dryRunRequired: true,
    verificationRequired: true,
  },
  {
    catalogId: "capacity-runbook-approval",
    runbookId: "capacity-saturation",
    incidentClass: "capacity_saturation",
    nextAction: "apply_runbook_step_with_approval",
    actionIntent: "Request approval to apply the capacity saturation runbook mitigation.",
    approvalSummary: "Capacity mitigation approval is required before applying bounded runbook changes.",
    approveCommand: "npm run triage:approval -- approve capacity-runbook-approval",
    rejectCommand: "npm run triage:approval -- reject capacity-runbook-approval",
    requiredEvidenceSources: ["runbook", "verification"],
    approvalRequired: true,
    dryRunRequired: true,
    verificationRequired: true,
  },
] satisfies MitigationCatalogEntry[];

export const mitigationCatalog = loadMitigationCatalog();

export function loadMitigationCatalog(fixturesDir = "fixtures"): MitigationCatalogEntry[] {
  const catalogPath = join(fixturesDir, "mitigations", "catalog.json");
  if (!existsSync(catalogPath)) {
    return defaultMitigationCatalog;
  }
  return parseMitigationCatalog(JSON.parse(readFileSync(catalogPath, "utf8")) as unknown);
}

export function parseMitigationCatalog(payload: unknown): MitigationCatalogEntry[] {
  if (!Array.isArray(payload)) {
    throw new FixtureError("Mitigation catalog must be an array.");
  }

  return payload.map((item, index) => {
    const record = readObject(item, `mitigation catalog entry ${index}`);
    return {
      catalogId: readString(record.catalog_id, "catalog_id"),
      runbookId: readString(record.runbook_id, "runbook_id"),
      incidentClass: parseIncidentClass(record.incident_class),
      nextAction: parseNextAction(record.next_action),
      actionIntent: readString(record.action_intent, "action_intent"),
      approvalSummary: readString(record.approval_summary, "approval_summary"),
      approveCommand: readString(record.approve_command, "approve_command"),
      rejectCommand: readString(record.reject_command, "reject_command"),
      requiredEvidenceSources: readStringArray(record.required_evidence_sources, "required_evidence_sources"),
      approvalRequired: readBoolean(record.approval_required, "approval_required"),
      dryRunRequired: readBoolean(record.dry_run_required, "dry_run_required"),
      verificationRequired: readBoolean(record.verification_required, "verification_required"),
    };
  });
}

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
    runbookId: catalogEntry.runbookId,
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
      runbookId: catalogEntry.runbookId,
      actionIntent: catalogEntry.actionIntent,
      nextAction: decision.nextAction,
      incidentClass: decision.incidentClass,
      confidence: decision.confidence,
      evidenceIds: decision.evidenceIds,
      verificationPlan: decision.verificationPlan,
      executed: false,
    },
    approvalRequest: {
      approvalId: approvalId(evidencePackage.incident.incidentId, catalogEntry.catalogId),
      status: "pending_human_approval",
      catalogId: catalogEntry.catalogId,
      runbookId: catalogEntry.runbookId,
      incidentId: evidencePackage.incident.incidentId,
      service: evidencePackage.incident.service,
      summary: catalogEntry.approvalSummary,
      approveCommand: approvalCommand(catalogEntry.approveCommand, evidencePackage),
      rejectCommand: approvalCommand(catalogEntry.rejectCommand, evidencePackage),
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
    event.runbookId = catalogEntry.runbookId;
  }
  return event;
}

function approvalId(incidentId: string, catalogId: string): string {
  return `approval:${incidentId}:${catalogId}`;
}

function approvalCommand(command: string, evidencePackage: EvidencePackage): string {
  return `${command} --incident-id ${evidencePackage.incident.incidentId} --service ${evidencePackage.incident.service}`;
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

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new FixtureError(`${label} must be an object.`);
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new FixtureError(`${label} must be a non-empty string.`);
}

function readStringArray(value: unknown, label: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    return value;
  }
  throw new FixtureError(`${label} must be an array of non-empty strings.`);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new FixtureError(`${label} must be a boolean.`);
}

function hasEvidenceSource(evidencePackage: EvidencePackage, source: string): boolean {
  return evidencePackage.evidence.some((item) => item.source === source);
}
