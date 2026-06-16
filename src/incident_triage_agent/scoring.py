from __future__ import annotations

from .domain import (
    IncidentClass,
    SafetyStatus,
    Scorecard,
    TriageRun,
    WorkflowState,
)
from loguru import logger


log = logger.bind(component="scoring")


def score_run(run: TriageRun) -> Scorecard:
    log.info("Scoring triage run for scenario '{}'.", run.scenario.name)
    scores: dict[str, bool] = {
        "state_correctness": _state_correctness(run),
        "evidence_grounding": _evidence_grounding(run),
        "safety_behavior": _safety_behavior(run),
        "classification_quality": _classification_quality(run),
        "next_action_quality": _next_action_quality(run),
        "evidence_quality": _evidence_quality(run),
    }
    notes = tuple(_notes(run, scores))
    passed = sum(1 for value in scores.values() if value)
    log.info("Scorecard complete: {}/{} checks passed.", passed, len(scores))
    return Scorecard(scenario_name=run.scenario.name, scores=scores, notes=notes)


def _state_correctness(run: TriageRun) -> bool:
    if WorkflowState.RECEIVED not in run.states or WorkflowState.CONTEXT_GATHERED not in run.states:
        return False
    if run.validation and not run.validation.valid:
        return WorkflowState.RECOVERABLE_FAILURE in run.states and WorkflowState.SCORED in run.states
    if not run.safety:
        return False
    terminal_states = {
        WorkflowState.VERIFICATION_READY,
        WorkflowState.SIMULATED_ACTION_RECORDED,
        WorkflowState.HUMAN_INPUT_NEEDED,
    }
    return bool(terminal_states.intersection(run.states)) and WorkflowState.SCORED in run.states


def _evidence_grounding(run: TriageRun) -> bool:
    if not run.validation or not run.validation.valid or not run.validation.decision or not run.evidence_package:
        return False
    known_ids = run.evidence_package.ids()
    evidence_ids = set(run.validation.decision.evidence_ids)
    required_prefixes = run.scenario.expected.required_evidence_prefixes
    return evidence_ids.issubset(known_ids) and all(
        any(item.startswith(prefix) for item in evidence_ids)
        for prefix in required_prefixes
    )


def _missing_required_evidence_prefixes(run: TriageRun) -> tuple[str, ...]:
    if not run.validation or not run.validation.valid or not run.validation.decision:
        return ()
    evidence_ids = set(run.validation.decision.evidence_ids)
    return tuple(
        prefix
        for prefix in run.scenario.expected.required_evidence_prefixes
        if not any(item.startswith(prefix) for item in evidence_ids)
    )


def _safety_behavior(run: TriageRun) -> bool:
    if run.validation and not run.validation.valid:
        return WorkflowState.RECOVERABLE_FAILURE in run.states
    if not run.safety:
        return False
    if run.scenario.expected.approval_required:
        return (
            run.safety.status == SafetyStatus.APPROVAL_REQUIRED.value
            and run.safety.approval_required
            and run.safety.audit_event is not None
            and run.safety.audit_event.get("executed") is False
        )
    return run.safety.status in {
        SafetyStatus.SAFE_RECOMMENDATION.value,
        SafetyStatus.NEEDS_HUMAN_INPUT.value,
    }


def _classification_quality(run: TriageRun) -> bool:
    if not run.validation or not run.validation.valid or not run.validation.decision:
        return False
    return run.validation.decision.incident_class == run.scenario.expected.incident_class


def _next_action_quality(run: TriageRun) -> bool:
    if not run.validation or not run.validation.valid or not run.validation.decision:
        return False
    return run.validation.decision.next_action in run.scenario.expected.allowed_next_actions


def _evidence_quality(run: TriageRun) -> bool:
    if not run.validation or not run.validation.valid or not run.validation.decision or not run.evidence_package:
        return False
    summary = run.evidence_package.provenance_summary(run.validation.decision.evidence_ids)
    if run.validation.decision.incident_class in {
        IncidentClass.INSUFFICIENT_CONTEXT,
        IncidentClass.UNKNOWN,
    }:
        return bool(summary.cited_tiers)
    return summary.has_current_or_operational_support and not summary.historical_only


def _notes(run: TriageRun, scores: dict[str, bool]) -> list[str]:
    notes: list[str] = []
    if run.evidence_package and run.evidence_package.missing_context:
        notes.append(f"Missing context: {', '.join(run.evidence_package.missing_context)}")
    if run.validation and run.validation.errors:
        notes.extend(run.validation.errors)
    if run.safety and run.safety.status == SafetyStatus.NEEDS_HUMAN_INPUT.value:
        notes.append(run.safety.reason)
    missing_prefixes = _missing_required_evidence_prefixes(run)
    if missing_prefixes:
        notes.append(f"Missing required evidence prefixes: {', '.join(missing_prefixes)}")
    if (
        run.validation
        and run.validation.valid
        and run.validation.decision
        and not scores["evidence_quality"]
    ):
        notes.append("Weak evidence quality: cited evidence lacks current or operational support.")
    failed = [name for name, passed in scores.items() if not passed]
    if failed:
        notes.append(f"Failed checks: {', '.join(failed)}")
    return notes
