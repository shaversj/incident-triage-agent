from __future__ import annotations

from typing import Any

from .domain import EvidencePackage, NextAction, SafetyResult, SafetyStatus, TriageDecision


APPROVAL_REQUIRED_ACTIONS = {
    NextAction.REQUEST_ROLLBACK_APPROVAL,
    NextAction.APPLY_RUNBOOK_STEP_WITH_APPROVAL,
}


def evaluate_safety(decision: TriageDecision, evidence_package: EvidencePackage) -> SafetyResult:
    missing = set(evidence_package.missing_context)

    if decision.next_action == NextAction.APPLY_RUNBOOK_STEP_WITH_APPROVAL and "runbook" in missing:
        return SafetyResult(
            status=SafetyStatus.NEEDS_HUMAN_INPUT.value,
            approval_required=False,
            reason="Runbook-guided action cannot be staged without runbook context.",
        )

    if decision.next_action in APPROVAL_REQUIRED_ACTIONS and "verification" in missing:
        return SafetyResult(
            status=SafetyStatus.NEEDS_HUMAN_INPUT.value,
            approval_required=False,
            reason="Approval-sensitive action cannot be staged without verification signals.",
        )

    if decision.next_action in APPROVAL_REQUIRED_ACTIONS:
        staged_payload = build_staged_payload(decision, evidence_package)
        return SafetyResult(
            status=SafetyStatus.APPROVAL_REQUIRED.value,
            approval_required=True,
            reason=f"{decision.next_action.value} requires human approval.",
            staged_payload=staged_payload,
            audit_event={
                "event": "simulated_action_staged",
                "incident_id": evidence_package.incident.incident_id,
                "next_action": decision.next_action.value,
                "executed": False,
            },
        )

    if decision.next_action == NextAction.ASK_HUMAN:
        return SafetyResult(
            status=SafetyStatus.NEEDS_HUMAN_INPUT.value,
            approval_required=False,
            reason="LLM selected human input as the safest next step.",
        )

    return SafetyResult(
        status=SafetyStatus.SAFE_RECOMMENDATION.value,
        approval_required=False,
        reason="Recommendation is non-mutating and can be presented with caveats.",
    )


def build_staged_payload(decision: TriageDecision, evidence_package: EvidencePackage) -> dict[str, Any]:
    return {
        "incident_id": evidence_package.incident.incident_id,
        "service": evidence_package.incident.service,
        "next_action": decision.next_action.value,
        "incident_class": decision.incident_class.value,
        "confidence": decision.confidence,
        "evidence_ids": list(decision.evidence_ids),
        "verification_plan": list(decision.verification_plan),
        "executed": False,
    }
