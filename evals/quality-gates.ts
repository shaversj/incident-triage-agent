import { incidentClasses, nextActions } from "../src/domain";

export const recordedTriageQualityGateNames = [
  "schema_contract",
  "evidence_grounding",
  "provenance_support",
  "safety_contract",
  "recorded_triage_readability",
] as const;

export type RecordedTriageQualityGateName = typeof recordedTriageQualityGateNames[number];

export interface RecordedTriageQualityGate {
  name: RecordedTriageQualityGateName;
  status: "pass" | "fail";
  reasons: string[];
}

export interface RecordedTriageQualityReport {
  gates: Record<RecordedTriageQualityGateName, RecordedTriageQualityGate>;
  failures: RecordedTriageQualityGate[];
}

export function evaluateRecordedTriageQuality(response: Record<string, unknown>): RecordedTriageQualityReport {
  const gates: Record<RecordedTriageQualityGateName, RecordedTriageQualityGate> = {
    schema_contract: gate("schema_contract", schemaContractReasons(response)),
    evidence_grounding: gate("evidence_grounding", evidenceGroundingReasons(response)),
    provenance_support: gate("provenance_support", provenanceSupportReasons(response)),
    safety_contract: gate("safety_contract", safetyContractReasons(response)),
    recorded_triage_readability: gate("recorded_triage_readability", readabilityReasons(response)),
  };

  return {
    gates,
    failures: recordedTriageQualityGateNames.map((name) => gates[name]).filter((result) => result.status === "fail"),
  };
}

export function assertRecordedTriageQuality(response: Record<string, unknown>): void {
  const report = evaluateRecordedTriageQuality(response);
  if (report.failures.length > 0) {
    throw new Error(formatRecordedTriageQualityReport(report, response));
  }
}

export function formatRecordedTriageQualityReport(
  report: RecordedTriageQualityReport,
  response?: Record<string, unknown>,
): string {
  const lines = ["Recorded triage quality gates failed:"];
  for (const gateResult of recordedTriageQualityGateNames.map((name) => report.gates[name])) {
    lines.push(`- ${gateResult.name}: ${gateResult.status}`);
    for (const reason of gateResult.reasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (response) {
    lines.push("Response context:");
    lines.push(JSON.stringify(responseContext(response), null, 2));
  }
  return lines.join("\n");
}

function gate(name: RecordedTriageQualityGateName, reasons: string[]): RecordedTriageQualityGate {
  return {
    name,
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
  };
}

function schemaContractReasons(response: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const validation = objectValue(response.validation);
  const decision = objectValue(response.decision);

  if (response.status !== "ok" && !isSuccessStatusCode(response.status_code)) {
    reasons.push("response.status must be ok or status_code must be 2xx");
  }
  if (response.run_status !== "completed") {
    reasons.push("response.run_status must be completed");
  }
  if (validation?.valid !== true) {
    reasons.push("validation.valid must be true");
  }
  if (!decision) {
    reasons.push("decision object is required");
    return reasons;
  }
  if (!incidentClasses.includes(decision.incident_class as never)) {
    reasons.push("decision.incident_class must be in the bounded taxonomy");
  }
  if (!nextActions.includes(decision.next_action as never)) {
    reasons.push("decision.next_action must be in the bounded taxonomy");
  }
  if (typeof decision.confidence !== "number") {
    reasons.push("decision.confidence must be a number");
  }
  if (stringArray(decision.evidence_ids).length === 0) {
    reasons.push("decision.evidence_ids must be non-empty");
  }
  if (!Array.isArray(decision.caveats)) {
    reasons.push("decision.caveats must be an array");
  }
  if (!Array.isArray(decision.verification_plan)) {
    reasons.push("decision.verification_plan must be an array");
  }

  return reasons;
}

function evidenceGroundingReasons(response: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const knownEvidenceIds = knownEvidenceIdSet(response);
  const decision = objectValue(response.decision);
  const decisionEvidenceIds = stringArray(decision?.evidence_ids);
  const recommendation = objectValue(response.recommendation);
  const recommendationEvidenceIds = stringArray(recommendation?.evidence_ids);
  const hypotheses = arrayValue(objectValue(response.analysis)?.hypotheses).map(objectValue).filter(isObject);

  if (decisionEvidenceIds.length === 0) {
    reasons.push("decision.evidence_ids must cite at least one evidence ID");
  }
  if (knownEvidenceIds.size === 0) {
    reasons.push("known evidence IDs are required from response.evidence or provenance.cited_evidence_ids");
  }
  for (const evidenceId of decisionEvidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      reasons.push(`decision.evidence_ids contains unknown evidence ID: ${evidenceId}`);
    }
  }
  for (const evidenceId of recommendationEvidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      reasons.push(`recommendation.evidence_ids contains unknown evidence ID: ${evidenceId}`);
    }
    if (!decisionEvidenceIds.includes(evidenceId)) {
      reasons.push(`recommendation.evidence_ids must be supported by decision.evidence_ids: ${evidenceId}`);
    }
  }
  for (const hypothesis of hypotheses) {
    for (const evidenceId of [
      ...stringArray(hypothesis.supporting_evidence_ids),
      ...stringArray(hypothesis.contradicting_evidence_ids),
    ]) {
      if (!knownEvidenceIds.has(evidenceId)) {
        reasons.push(`analysis.hypotheses cites unknown evidence ID: ${evidenceId}`);
      }
    }
  }

  return reasons;
}

function provenanceSupportReasons(response: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const provenance = objectValue(response.provenance);
  if (!provenance) {
    return ["provenance object is required"];
  }

  const citedEvidenceIds = stringArray(provenance.cited_evidence_ids);
  const citedTiers = stringArray(provenance.cited_tiers);
  const citedSources = stringArray(provenance.cited_sources);
  const support = stringValue(provenance.support);

  if (citedEvidenceIds.length === 0) {
    reasons.push("provenance.cited_evidence_ids must be non-empty");
  }
  if (citedTiers.length === 0) {
    reasons.push("provenance.cited_tiers must be non-empty");
  }
  if (citedSources.length === 0) {
    reasons.push("provenance.cited_sources must be non-empty");
  }
  if (!support || support === "none") {
    reasons.push("provenance.support must show current, operational, guidance, or historical support");
  }
  for (const evidenceId of stringArray(objectValue(response.decision)?.evidence_ids)) {
    if (!citedEvidenceIds.includes(evidenceId)) {
      reasons.push(`provenance.cited_evidence_ids must include decision evidence ID: ${evidenceId}`);
    }
  }

  return reasons;
}

function safetyContractReasons(response: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const safety = objectValue(response.safety);
  if (!safety) {
    return ["safety object is required"];
  }
  if (!stringValue(safety.status)) {
    reasons.push("safety.status is required");
  }
  if (typeof safety.approval_required !== "boolean") {
    reasons.push("safety.approval_required must be boolean");
  }
  if (objectValue(safety.audit_event)?.executed === true) {
    reasons.push("safety.audit_event.executed must not be true");
  }

  return reasons;
}

function readabilityReasons(response: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const decision = objectValue(response.decision);
  const recommendation = objectValue(response.recommendation);
  const verificationPlan = stringArray(decision?.verification_plan).filter((step) => step.trim().length > 0);

  if (!stringValue(response.finding_summary)) {
    reasons.push("finding_summary is required for recorded triage readability");
  }
  if (!stringValue(recommendation?.rationale)) {
    reasons.push("recommendation.rationale is required for recorded triage readability");
  }
  if (verificationPlan.length === 0) {
    reasons.push("decision.verification_plan must include at least one step for recorded triage readability");
  }

  return reasons;
}

function knownEvidenceIdSet(response: Record<string, unknown>): Set<string> {
  const fromEvidence = arrayValue(response.evidence)
    .map(objectValue)
    .filter(isObject)
    .map((item) => stringValue(item.evidence_id))
    .filter(isString);
  if (fromEvidence.length > 0) {
    return new Set(fromEvidence);
  }
  return new Set(stringArray(objectValue(response.provenance)?.cited_evidence_ids));
}

function responseContext(response: Record<string, unknown>): Record<string, unknown> {
  const decision = objectValue(response.decision);
  const recommendation = objectValue(response.recommendation);
  const provenance = objectValue(response.provenance);
  const safety = objectValue(response.safety);

  return {
    scenario: response.scenario,
    run_status: response.run_status,
    validation: response.validation,
    finding_summary: response.finding_summary,
    recommendation: recommendation ? {
      rationale: recommendation.rationale,
      evidence_ids: recommendation.evidence_ids,
    } : undefined,
    decision: decision ? {
      incident_class: decision.incident_class,
      next_action: decision.next_action,
      evidence_ids: decision.evidence_ids,
      verification_plan: decision.verification_plan,
    } : undefined,
    provenance: provenance ? {
      cited_tiers: provenance.cited_tiers,
      cited_sources: provenance.cited_sources,
      cited_evidence_ids: provenance.cited_evidence_ids,
      support: provenance.support,
    } : undefined,
    safety: safety ? {
      status: safety.status,
      approval_required: safety.approval_required,
    } : undefined,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSuccessStatusCode(value: unknown): boolean {
  return typeof value === "number" && value >= 200 && value < 300;
}

function isObject(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined;
}
