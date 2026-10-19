import { incidentClasses, nextActions, sourceTiers } from "../domain";
import { investigationStepKinds, investigationStepStatuses } from "../evidence";
import type { InvestigationStep, ProvenanceSummary } from "../evidence";
import type {
  EvidenceHypothesis,
  ExplanationValidation,
  TriageDecision,
  TriageExplanation,
  TriageRecommendation,
} from "../llm";
import {
  mitigationControlStatuses,
  mitigationVerificationStatuses,
  type HumanApprovalRequest,
  type MitigationAuditEvent,
  type MitigationCatalogMatch,
  type MitigationControlResult,
  type MitigationDryRun,
  type MitigationEvidenceCheck,
  type MitigationStagedAction,
  type MitigationVerification,
} from "../mitigation-control";
import { safetyStatuses, type AuditEvent, type SafetyResult, type StagedPayload } from "../policy";
import type { InvestigationTrace } from "../workflow";
import type { PersistedValidationSummary, TriageRunReviewEnvelope } from "./contracts";

export function decodeTriageRunReviewEnvelope(value: unknown): TriageRunReviewEnvelope | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const source = record(value, "review_envelope");
  const envelope: TriageRunReviewEnvelope = {};
  if (source.investigation !== undefined) {
    envelope.investigation = investigation(source.investigation, "review_envelope.investigation");
  }
  if (source.validation !== undefined) {
    envelope.validation = validation(source.validation, "review_envelope.validation");
  }
  if (source.explanation !== undefined) {
    envelope.explanation = explanation(source.explanation, "review_envelope.explanation");
  }
  if (source.explanationValidation !== undefined) {
    envelope.explanationValidation = explanationValidation(
      source.explanationValidation,
      "review_envelope.explanationValidation",
    );
  }
  if (source.decision !== undefined) {
    envelope.decision = decision(source.decision, "review_envelope.decision");
  }
  if (source.safety !== undefined) {
    envelope.safety = safety(source.safety, "review_envelope.safety");
  }
  if (source.mitigationControl !== undefined) {
    envelope.mitigationControl = mitigationControl(
      source.mitigationControl,
      "review_envelope.mitigationControl",
    );
  }
  if (source.provenance !== undefined) {
    envelope.provenance = provenance(source.provenance, "review_envelope.provenance");
  }
  return envelope;
}

function investigation(value: unknown, path: string): InvestigationTrace {
  const source = record(value, path);
  return {
    summary: string(source.summary, `${path}.summary`),
    steps: array(source.steps, `${path}.steps`).map((step, index) => investigationStep(step, `${path}.steps[${index}]`)),
  };
}

function investigationStep(value: unknown, path: string): InvestigationStep {
  const source = record(value, path);
  return {
    id: string(source.id, `${path}.id`),
    kind: literal(source.kind, investigationStepKinds, `${path}.kind`),
    status: literal(source.status, investigationStepStatuses, `${path}.status`),
    purpose: string(source.purpose, `${path}.purpose`),
    evidenceIds: strings(source.evidenceIds, `${path}.evidenceIds`),
  };
}

function validation(value: unknown, path: string): PersistedValidationSummary {
  const source = record(value, path);
  return {
    valid: boolean(source.valid, `${path}.valid`),
    errors: strings(source.errors, `${path}.errors`),
  };
}

function explanation(value: unknown, path: string): TriageExplanation {
  const source = record(value, path);
  const result: TriageExplanation = {};
  if (source.hypotheses !== undefined) {
    result.hypotheses = array(source.hypotheses, `${path}.hypotheses`)
      .map((item, index) => hypothesis(item, `${path}.hypotheses[${index}]`));
  }
  if (source.findingSummary !== undefined) {
    result.findingSummary = string(source.findingSummary, `${path}.findingSummary`);
  }
  if (source.recommendation !== undefined) {
    result.recommendation = recommendation(source.recommendation, `${path}.recommendation`);
  }
  return result;
}

function hypothesis(value: unknown, path: string): EvidenceHypothesis {
  const source = record(value, path);
  return {
    label: string(source.label, `${path}.label`),
    status: literal(source.status, ["supported", "contradicted", "inconclusive"] as const, `${path}.status`),
    supportingEvidenceIds: strings(source.supportingEvidenceIds, `${path}.supportingEvidenceIds`),
    contradictingEvidenceIds: strings(source.contradictingEvidenceIds, `${path}.contradictingEvidenceIds`),
  };
}

function recommendation(value: unknown, path: string): TriageRecommendation {
  const source = record(value, path);
  return {
    rationale: string(source.rationale, `${path}.rationale`),
    evidenceIds: strings(source.evidenceIds, `${path}.evidenceIds`),
  };
}

function explanationValidation(value: unknown, path: string): ExplanationValidation {
  const source = record(value, path);
  return {
    status: literal(source.status, ["valid", "degraded", "not_available"] as const, `${path}.status`),
    warnings: strings(source.warnings, `${path}.warnings`),
  };
}

function decision(value: unknown, path: string): TriageDecision {
  const source = record(value, path);
  return {
    incidentClass: literal(source.incidentClass, incidentClasses, `${path}.incidentClass`),
    nextAction: literal(source.nextAction, nextActions, `${path}.nextAction`),
    confidence: number(source.confidence, `${path}.confidence`),
    evidenceIds: strings(source.evidenceIds, `${path}.evidenceIds`),
    caveats: strings(source.caveats, `${path}.caveats`),
    verificationPlan: strings(source.verificationPlan, `${path}.verificationPlan`),
  };
}

function safety(value: unknown, path: string): SafetyResult {
  const source = record(value, path);
  const result: SafetyResult = {
    status: literal(source.status, safetyStatuses, `${path}.status`),
    approvalRequired: boolean(source.approvalRequired, `${path}.approvalRequired`),
    reason: string(source.reason, `${path}.reason`),
    mitigationControl: mitigationControl(source.mitigationControl, `${path}.mitigationControl`),
  };
  if (source.stagedPayload !== undefined) {
    result.stagedPayload = stagedPayload(source.stagedPayload, `${path}.stagedPayload`);
  }
  if (source.auditEvent !== undefined) {
    result.auditEvent = safetyAuditEvent(source.auditEvent, `${path}.auditEvent`);
  }
  return result;
}

function stagedPayload(value: unknown, path: string): StagedPayload {
  const source = record(value, path);
  return {
    incidentId: string(source.incidentId, `${path}.incidentId`),
    service: string(source.service, `${path}.service`),
    nextAction: literal(source.nextAction, nextActions, `${path}.nextAction`),
    incidentClass: literal(source.incidentClass, incidentClasses, `${path}.incidentClass`),
    confidence: number(source.confidence, `${path}.confidence`),
    evidenceIds: strings(source.evidenceIds, `${path}.evidenceIds`),
    verificationPlan: strings(source.verificationPlan, `${path}.verificationPlan`),
    executed: executedFalse(source.executed, `${path}.executed`),
  };
}

function safetyAuditEvent(value: unknown, path: string): AuditEvent {
  const source = record(value, path);
  return {
    event: literal(source.event, ["simulated_action_staged"] as const, `${path}.event`),
    incidentId: string(source.incidentId, `${path}.incidentId`),
    nextAction: literal(source.nextAction, nextActions, `${path}.nextAction`),
    executed: executedFalse(source.executed, `${path}.executed`),
  };
}

function mitigationControl(value: unknown, path: string): MitigationControlResult {
  const source = record(value, path);
  const result: MitigationControlResult = {
    status: literal(source.status, mitigationControlStatuses, `${path}.status`),
    approvalRequired: boolean(source.approvalRequired, `${path}.approvalRequired`),
    reason: string(source.reason, `${path}.reason`),
    evidenceChecks: array(source.evidenceChecks, `${path}.evidenceChecks`)
      .map((item, index) => mitigationEvidenceCheck(item, `${path}.evidenceChecks[${index}]`)),
  };
  if (source.catalogMatch !== undefined) {
    result.catalogMatch = mitigationCatalogMatch(source.catalogMatch, `${path}.catalogMatch`);
  }
  if (source.dryRun !== undefined) {
    result.dryRun = mitigationDryRun(source.dryRun, `${path}.dryRun`);
  }
  if (source.stagedAction !== undefined) {
    result.stagedAction = mitigationStagedAction(source.stagedAction, `${path}.stagedAction`);
  }
  if (source.approvalRequest !== undefined) {
    result.approvalRequest = approvalRequest(source.approvalRequest, `${path}.approvalRequest`);
  }
  if (source.auditEvent !== undefined) {
    result.auditEvent = mitigationAuditEvent(source.auditEvent, `${path}.auditEvent`);
  }
  if (source.verification !== undefined) {
    result.verification = mitigationVerification(source.verification, `${path}.verification`);
  }
  return result;
}

function mitigationEvidenceCheck(value: unknown, path: string): MitigationEvidenceCheck {
  const source = record(value, path);
  return {
    source: string(source.source, `${path}.source`),
    passed: boolean(source.passed, `${path}.passed`),
  };
}

function mitigationCatalogMatch(value: unknown, path: string): MitigationCatalogMatch {
  const source = record(value, path);
  return {
    catalogId: string(source.catalogId, `${path}.catalogId`),
    runbookId: string(source.runbookId, `${path}.runbookId`),
    actionIntent: string(source.actionIntent, `${path}.actionIntent`),
  };
}

function mitigationDryRun(value: unknown, path: string): MitigationDryRun {
  const source = record(value, path);
  return {
    status: literal(source.status, ["simulated"] as const, `${path}.status`),
    summary: string(source.summary, `${path}.summary`),
    executed: executedFalse(source.executed, `${path}.executed`),
  };
}

function mitigationStagedAction(value: unknown, path: string): MitigationStagedAction {
  const source = record(value, path);
  return {
    incidentId: string(source.incidentId, `${path}.incidentId`),
    service: string(source.service, `${path}.service`),
    catalogId: string(source.catalogId, `${path}.catalogId`),
    runbookId: string(source.runbookId, `${path}.runbookId`),
    actionIntent: string(source.actionIntent, `${path}.actionIntent`),
    nextAction: literal(source.nextAction, nextActions, `${path}.nextAction`),
    incidentClass: literal(source.incidentClass, incidentClasses, `${path}.incidentClass`),
    confidence: number(source.confidence, `${path}.confidence`),
    evidenceIds: strings(source.evidenceIds, `${path}.evidenceIds`),
    verificationPlan: strings(source.verificationPlan, `${path}.verificationPlan`),
    executed: executedFalse(source.executed, `${path}.executed`),
  };
}

function approvalRequest(value: unknown, path: string): HumanApprovalRequest {
  const source = record(value, path);
  return {
    approvalId: string(source.approvalId, `${path}.approvalId`),
    status: literal(source.status, ["pending_human_approval"] as const, `${path}.status`),
    catalogId: string(source.catalogId, `${path}.catalogId`),
    runbookId: string(source.runbookId, `${path}.runbookId`),
    incidentId: string(source.incidentId, `${path}.incidentId`),
    service: string(source.service, `${path}.service`),
    summary: string(source.summary, `${path}.summary`),
    approveCommand: string(source.approveCommand, `${path}.approveCommand`),
    rejectCommand: string(source.rejectCommand, `${path}.rejectCommand`),
    executed: executedFalse(source.executed, `${path}.executed`),
  };
}

function mitigationAuditEvent(value: unknown, path: string): MitigationAuditEvent {
  const source = record(value, path);
  const result: MitigationAuditEvent = {
    event: literal(source.event, ["mitigation_control_decision"] as const, `${path}.event`),
    incidentId: string(source.incidentId, `${path}.incidentId`),
    status: literal(source.status, mitigationControlStatuses, `${path}.status`),
    nextAction: literal(source.nextAction, nextActions, `${path}.nextAction`),
    executed: executedFalse(source.executed, `${path}.executed`),
  };
  if (source.catalogId !== undefined) {
    result.catalogId = string(source.catalogId, `${path}.catalogId`);
  }
  if (source.runbookId !== undefined) {
    result.runbookId = string(source.runbookId, `${path}.runbookId`);
  }
  return result;
}

function mitigationVerification(value: unknown, path: string): MitigationVerification {
  const source = record(value, path);
  return {
    status: literal(source.status, mitigationVerificationStatuses, `${path}.status`),
    signals: strings(source.signals, `${path}.signals`),
    reason: string(source.reason, `${path}.reason`),
  };
}

function provenance(value: unknown, path: string): ProvenanceSummary {
  const source = record(value, path);
  return {
    availableTiers: literals(source.availableTiers, sourceTiers, `${path}.availableTiers`),
    citedTiers: literals(source.citedTiers, sourceTiers, `${path}.citedTiers`),
    citedSources: strings(source.citedSources, `${path}.citedSources`),
    citedEvidenceIds: strings(source.citedEvidenceIds, `${path}.citedEvidenceIds`),
    missingContext: strings(source.missingContext, `${path}.missingContext`),
    hasCurrentOrOperationalSupport: boolean(
      source.hasCurrentOrOperationalSupport,
      `${path}.hasCurrentOrOperationalSupport`,
    ),
    historicalOnly: boolean(source.historicalOnly, `${path}.historicalOnly`),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, "an object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(path, "an array");
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw invalid(path, "a string");
  }
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(path, "a finite number");
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(path, "a boolean");
  }
  return value;
}

function executedFalse(value: unknown, path: string): false {
  if (value !== false) {
    throw invalid(path, "false");
  }
  return false;
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function literal<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalid(path, `one of ${allowed.join(", ")}`);
  }
  return value;
}

function literals<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number][] {
  return array(value, path).map((item, index) => literal(item, allowed, `${path}[${index}]`));
}

function invalid(path: string, expected: string): Error {
  return new Error(`${path} must be ${expected}.`);
}
