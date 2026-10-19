import type { ProvenanceSummary } from "../evidence";
import type { TriageDecision, TriageExplanation } from "../llm";
import type { MitigationControlResult } from "../mitigation-control";
import type {
  IncidentLifecycleReviewRecord,
  TriageRunRecord,
  TriageRunReviewEnvelope,
  TriageRunReviewRecord,
} from "../persistence/contracts";
import type { SafetyResult } from "../policy";
import type { EvidenceReentryResult } from "../reentry";
import type { InvestigationTrace, TriageRun } from "../workflow";

interface ResolvedRunReviewContext {
  approval: Record<string, unknown>;
  lifecycle?: IncidentLifecycleReviewRecord;
}

export function runListToResponse(runs: TriageRunRecord[]): Record<string, unknown> {
  const bySafety = new Map<string, number>();
  for (const run of runs) {
    const key = run.safetyStatus ?? "not_available";
    bySafety.set(key, (bySafety.get(key) ?? 0) + 1);
  }
  return {
    status: "ok",
    runs: runs.map(runRecordToResponse),
    summary: {
      total: runs.length,
      by_safety_status: Object.fromEntries(bySafety.entries()),
    },
  };
}

function runRecordToResponse(run: TriageRunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    incident_id: run.incidentId,
    incident_title: run.incidentTitle,
    severity: run.severity,
    incident_status: run.incidentStatus,
    started_at: run.startedAt,
    scenario_name: run.scenarioName,
    service: run.service,
    run_status: run.runStatus,
    validation_status: run.validationStatus,
    safety_status: run.safetyStatus,
    mitigation_status: run.mitigationStatus,
    evidence_ids: run.evidenceIds,
    scorecard: run.scorecard,
    retention_class: run.retentionClass,
    correlation_id: run.correlationId,
    parent_run_id: run.parentRunId,
    gate_decision_id: run.gateDecisionId,
    created_at: run.createdAt,
    expires_at: run.expiresAt,
  };
}

export function runReviewToResponse(
  review: TriageRunReviewRecord,
  resolved: ResolvedRunReviewContext,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: "ok",
    run: runRecordToResponse(review.run),
  };
  const normalizedReview = reviewEnvelopeToResponse(review.run.reviewEnvelope);
  if (normalizedReview) {
    response.review = normalizedReview;
  }
  if (review.evidenceSnapshot) {
    response.evidence_snapshot = {
      run_id: review.evidenceSnapshot.runId,
      incident_id: review.evidenceSnapshot.incidentId,
      evidence: review.evidenceSnapshot.evidence,
      missing_context: review.evidenceSnapshot.missingContext,
      retention_class: review.evidenceSnapshot.retentionClass,
      created_at: review.evidenceSnapshot.createdAt,
      expires_at: review.evidenceSnapshot.expiresAt,
    };
  }
  response.trigger = triggerForGateDecision(review.gateDecision);
  response.parent_run_id = review.run.parentRunId ?? review.gateDecision?.priorRunId;
  response.parent_run_retained = review.parentRunRetained;
  if (review.gateDecision) {
    response.gate_decision = gateDecisionToResponse(review.gateDecision);
  }
  response.recent_gate_decisions = review.recentGateDecisions.map(gateDecisionToResponse);
  response.approval = resolved.approval;
  if (resolved.lifecycle) {
    response.lifecycle = resolved.lifecycle;
  }
  return response;
}

function reviewEnvelopeToResponse(
  envelope: TriageRunReviewEnvelope | undefined,
): Record<string, unknown> | undefined {
  if (!envelope) {
    return undefined;
  }
  const response: Record<string, unknown> = {};
  if (envelope.investigation) {
    response.investigation = investigationToResponse(envelope.investigation);
  }
  if (envelope.validation) {
    response.validation = envelope.validation;
  }
  if (envelope.explanation) {
    response.explanation = explanationToResponse(envelope.explanation);
  }
  if (envelope.explanationValidation) {
    response.explanation_validation = envelope.explanationValidation;
  }
  if (envelope.decision) {
    response.decision = decisionToResponse(envelope.decision);
  }
  if (envelope.safety) {
    response.safety = safetyToResponse(envelope.safety);
  }
  if (envelope.mitigationControl) {
    response.mitigation_control = mitigationControlToResponse(envelope.mitigationControl);
  }
  if (envelope.provenance) {
    response.provenance = provenanceToResponse(envelope.provenance);
  }
  return Object.keys(response).length > 0 ? response : undefined;
}

export function materialityToResponse(evaluation: EvidenceReentryResult): Record<string, unknown> {
  return {
    outcome: evaluation.decision.outcome,
    basis: evaluation.decision.basis,
    rationale: evaluation.decision.rationale,
    cited_delta_refs: evaluation.decision.citedDeltaRefs,
    delta: evaluation.delta,
  };
}

export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function runToResponse(run: TriageRun): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: "ok",
    run_id: run.runId,
    run_status: run.runStatus,
    incident: {
      incident_id: run.scenario.incident.incidentId,
      title: run.scenario.incident.title,
      severity: run.scenario.incident.severity,
      service: run.scenario.incident.service,
      status: run.scenario.incident.status,
      started_at: run.scenario.incident.startedAt,
    },
    scenario: run.scenario.name,
    states: run.states,
  };

  if (run.investigation) {
    response.investigation = investigationToResponse(run.investigation);
  }

  if (run.explanation) {
    const explanation = explanationToResponse(run.explanation);
    if (explanation.hypotheses) {
      response.analysis = { hypotheses: explanation.hypotheses };
    }
    if (explanation.finding_summary) {
      response.finding_summary = explanation.finding_summary;
    }
    if (explanation.recommendation) {
      response.recommendation = explanation.recommendation;
    }
  }

  if (run.explanationValidation) {
    response.explanation_validation = {
      status: run.explanationValidation.status,
      warnings: run.explanationValidation.warnings,
    };
  }

  if (run.validation) {
    response.validation = {
      valid: run.validation.valid,
      errors: run.validation.errors,
    };
    if (run.validation.decision) {
      response.decision = decisionToResponse(run.validation.decision);
    }
  }

  if (run.evidencePackage) {
    const provenance = run.evidencePackage.provenanceSummary(run.validation?.decision?.evidenceIds ?? []);
    response.evidence = run.evidencePackage.evidence.map((item) => ({
      evidence_id: item.evidenceId,
      source: item.source,
      source_tier: item.sourceTier,
      summary: item.summary,
    }));
    response.provenance = provenanceToResponse(provenance);
  }

  if (run.safety) {
    response.safety = {
      ...safetyToResponse(run.safety),
      staged_payload: run.safety.stagedPayload,
      audit_event: run.safety.auditEvent,
    };
  }

  if (run.mitigationControl) {
    response.mitigation_control = mitigationControlToResponse(run.mitigationControl);
  }

  if (run.scorecard) {
    response.scorecard = {
      scenario_name: run.scorecard.scenarioName,
      scores: run.scorecard.scores,
      notes: run.scorecard.notes,
    };
  }

  return response;
}

export function mitigationControlToResponse(mitigation: MitigationControlResult): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: mitigation.status,
    approval_required: mitigation.approvalRequired,
    reason: mitigation.reason,
    evidence_checks: mitigation.evidenceChecks.map((check) => ({
      source: check.source,
      passed: check.passed,
    })),
  };
  if (mitigation.catalogMatch) {
    response.catalog_match = {
      catalog_id: mitigation.catalogMatch.catalogId,
      runbook_id: mitigation.catalogMatch.runbookId,
      action_intent: mitigation.catalogMatch.actionIntent,
    };
  }
  if (mitigation.dryRun) {
    response.dry_run = {
      status: mitigation.dryRun.status,
      summary: mitigation.dryRun.summary,
      executed: mitigation.dryRun.executed,
    };
  }
  if (mitigation.stagedAction) {
    response.staged_action = {
      incident_id: mitigation.stagedAction.incidentId,
      service: mitigation.stagedAction.service,
      catalog_id: mitigation.stagedAction.catalogId,
      runbook_id: mitigation.stagedAction.runbookId,
      action_intent: mitigation.stagedAction.actionIntent,
      next_action: mitigation.stagedAction.nextAction,
      incident_class: mitigation.stagedAction.incidentClass,
      confidence: mitigation.stagedAction.confidence,
      evidence_ids: mitigation.stagedAction.evidenceIds,
      verification_plan: mitigation.stagedAction.verificationPlan,
      executed: mitigation.stagedAction.executed,
    };
  }
  if (mitigation.approvalRequest) {
    response.approval_request = {
      approval_id: mitigation.approvalRequest.approvalId,
      status: mitigation.approvalRequest.status,
      catalog_id: mitigation.approvalRequest.catalogId,
      runbook_id: mitigation.approvalRequest.runbookId,
      incident_id: mitigation.approvalRequest.incidentId,
      service: mitigation.approvalRequest.service,
      summary: mitigation.approvalRequest.summary,
      approve_command: mitigation.approvalRequest.approveCommand,
      reject_command: mitigation.approvalRequest.rejectCommand,
      executed: mitigation.approvalRequest.executed,
    };
  }
  if (mitigation.auditEvent) {
    response.audit_event = {
      event: mitigation.auditEvent.event,
      incident_id: mitigation.auditEvent.incidentId,
      status: mitigation.auditEvent.status,
      next_action: mitigation.auditEvent.nextAction,
      catalog_id: mitigation.auditEvent.catalogId,
      runbook_id: mitigation.auditEvent.runbookId,
      executed: mitigation.auditEvent.executed,
    };
  }
  if (mitigation.verification) {
    response.verification = {
      status: mitigation.verification.status,
      signals: mitigation.verification.signals,
      reason: mitigation.verification.reason,
    };
  }
  return response;
}

function triggerForGateDecision(decision: TriageRunReviewRecord["gateDecision"]): string {
  if (!decision) {
    return "legacy_run";
  }
  if (decision.outcome === "first_observation") {
    return "first_observation";
  }
  return decision.outcome === "material" ? "material_evidence" : "suppressed_update";
}

function gateDecisionToResponse(
  decision: NonNullable<TriageRunReviewRecord["gateDecision"]>,
): Record<string, unknown> {
  return {
    decision_id: decision.decisionId,
    incident_id: decision.incidentId,
    canonicalization_version: decision.canonicalizationVersion,
    candidate_digest: decision.candidateDigest,
    prior_run_id: decision.priorRunId,
    child_run_id: decision.childRunId,
    outcome: decision.outcome,
    basis: decision.basis,
    delta: decision.delta,
    rationale: decision.rationale,
    cited_delta_refs: decision.citedDeltaRefs,
    created_at: decision.createdAt,
    expires_at: decision.expiresAt,
  };
}

function investigationToResponse(investigation: InvestigationTrace): Record<string, unknown> {
  return {
    summary: investigation.summary,
    steps: investigation.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      status: step.status,
      purpose: step.purpose,
      evidence_ids: step.evidenceIds,
    })),
  };
}

function explanationToResponse(explanation: TriageExplanation): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  if (explanation.hypotheses) {
    response.hypotheses = explanation.hypotheses.map((hypothesis) => ({
      label: hypothesis.label,
      status: hypothesis.status,
      supporting_evidence_ids: hypothesis.supportingEvidenceIds,
      contradicting_evidence_ids: hypothesis.contradictingEvidenceIds,
    }));
  }
  if (explanation.findingSummary) {
    response.finding_summary = explanation.findingSummary;
  }
  if (explanation.recommendation) {
    response.recommendation = {
      rationale: explanation.recommendation.rationale,
      evidence_ids: explanation.recommendation.evidenceIds,
    };
  }
  return response;
}

function decisionToResponse(decision: TriageDecision): Record<string, unknown> {
  return {
    incident_class: decision.incidentClass,
    next_action: decision.nextAction,
    confidence: decision.confidence,
    evidence_ids: decision.evidenceIds,
    caveats: decision.caveats,
    verification_plan: decision.verificationPlan,
  };
}

function safetyToResponse(safety: SafetyResult): Record<string, unknown> {
  return {
    status: safety.status,
    approval_required: safety.approvalRequired,
    reason: safety.reason,
  };
}

function provenanceToResponse(provenance: ProvenanceSummary): Record<string, unknown> {
  return {
    available_tiers: provenance.availableTiers,
    cited_tiers: provenance.citedTiers,
    cited_sources: provenance.citedSources,
    cited_evidence_ids: provenance.citedEvidenceIds,
    missing_context: provenance.missingContext,
    support: provenance.historicalOnly
      ? "historical_only"
      : provenance.hasCurrentOrOperationalSupport ? "current_or_operational" : "none",
  };
}
