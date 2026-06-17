from __future__ import annotations

from typing import Any
import unittest

from incident_triage_agent.domain import (
    IncidentClass,
    NextAction,
    SafetyStatus,
    SourceTier,
    TriageRun,
    WorkflowState,
)


def assert_valid_run_outcome(
    case: unittest.TestCase,
    run: TriageRun,
    *,
    incident_class: IncidentClass | str | None = None,
    next_action: NextAction | str | None = None,
    evidence_prefixes: tuple[str, ...] = (),
    cited_sources: tuple[str, ...] = (),
    cited_tiers: tuple[SourceTier | str, ...] = (),
    safety_status: SafetyStatus | str | None = None,
    approval_required: bool | None = None,
    scorecard_checks: tuple[str, ...] = (),
) -> None:
    case.assertIsNotNone(run.validation, "expected run to include validation result")
    assert run.validation is not None
    case.assertTrue(run.validation.valid, f"expected valid decision, got errors={run.validation.errors!r}")
    case.assertIsNotNone(run.validation.decision, "expected valid run to include a decision")
    assert run.validation.decision is not None
    case.assertIn(WorkflowState.DECISION_VALIDATED, run.states, "expected decision_validated state")
    case.assertIn(WorkflowState.SCORED, run.states, "expected scored state")

    decision = run.validation.decision
    if incident_class is not None:
        case.assertEqual(
            _value(incident_class),
            decision.incident_class.value,
            f"expected incident_class={_value(incident_class)!r}, got {decision.incident_class.value!r}",
        )
    if next_action is not None:
        case.assertEqual(
            _value(next_action),
            decision.next_action.value,
            f"expected next_action={_value(next_action)!r}, got {decision.next_action.value!r}",
        )

    _assert_cited_prefixes(case, tuple(decision.evidence_ids), evidence_prefixes)

    case.assertIsNotNone(run.evidence_package, "expected run to include evidence package")
    assert run.evidence_package is not None
    provenance = run.evidence_package.provenance_summary(decision.evidence_ids)
    _assert_contains_all(
        case,
        tuple(source.value if hasattr(source, "value") else source for source in provenance.cited_tiers),
        tuple(_value(tier) for tier in cited_tiers),
        "cited_tiers",
    )
    _assert_contains_all(case, provenance.cited_sources, cited_sources, "cited_sources")

    if safety_status is not None or approval_required is not None:
        case.assertIsNotNone(run.safety, "expected run to include safety result")
        assert run.safety is not None
        _assert_safety(case, run.safety.status, run.safety.approval_required, safety_status, approval_required)
        if run.safety.approval_required:
            case.assertIsNotNone(run.safety.staged_payload, "expected approval-required outcome to include staged payload")
            case.assertIsNotNone(run.safety.audit_event, "expected approval-required outcome to include audit event")
            assert run.safety.audit_event is not None
            case.assertFalse(run.safety.audit_event.get("executed"), "expected staged action to remain unexecuted")

    _assert_scorecard_checks(case, run.scorecard.scores if run.scorecard else None, scorecard_checks)


def assert_valid_response_outcome(
    case: unittest.TestCase,
    response: dict[str, Any],
    *,
    incident_class: IncidentClass | str | None = None,
    next_action: NextAction | str | None = None,
    evidence_prefixes: tuple[str, ...] = (),
    cited_sources: tuple[str, ...] = (),
    available_tiers: tuple[SourceTier | str, ...] = (),
    cited_tiers: tuple[SourceTier | str, ...] = (),
    require_safety: bool = False,
    safety_status: SafetyStatus | str | None = None,
    approval_required: bool | None = None,
    scorecard_checks: tuple[str, ...] = (),
) -> None:
    case.assertEqual(response.get("status"), "ok", f"expected ok response, got {response!r}")
    validation = response.get("validation")
    case.assertIsInstance(validation, dict, "expected response validation object")
    assert isinstance(validation, dict)
    case.assertTrue(validation.get("valid"), f"expected valid response, got errors={validation.get('errors')!r}")
    decision = response.get("decision")
    case.assertIsInstance(decision, dict, "expected valid response to include decision")
    assert isinstance(decision, dict)

    if incident_class is not None:
        case.assertEqual(
            _value(incident_class),
            decision.get("incident_class"),
            f"expected incident_class={_value(incident_class)!r}, got {decision.get('incident_class')!r}",
        )
    if next_action is not None:
        case.assertEqual(
            _value(next_action),
            decision.get("next_action"),
            f"expected next_action={_value(next_action)!r}, got {decision.get('next_action')!r}",
        )

    _assert_cited_prefixes(case, tuple(decision.get("evidence_ids", ())), evidence_prefixes)

    provenance = response.get("provenance")
    case.assertIsInstance(provenance, dict, "expected response provenance object")
    assert isinstance(provenance, dict)
    _assert_contains_all(case, tuple(provenance.get("available_tiers", ())), tuple(_value(tier) for tier in available_tiers), "available_tiers")
    _assert_contains_all(case, tuple(provenance.get("cited_tiers", ())), tuple(_value(tier) for tier in cited_tiers), "cited_tiers")
    _assert_contains_all(case, tuple(provenance.get("cited_sources", ())), cited_sources, "cited_sources")

    if require_safety or safety_status is not None or approval_required is not None:
        safety = response.get("safety")
        case.assertIsInstance(safety, dict, "expected response safety object")
        assert isinstance(safety, dict)
        _assert_safety(case, safety.get("status"), safety.get("approval_required"), safety_status, approval_required)
        audit_event = safety.get("audit_event")
        if audit_event is not None:
            case.assertNotEqual(audit_event.get("executed"), True, "expected safety result not to execute actions")
        if safety.get("approval_required"):
            case.assertIsInstance(audit_event, dict, "expected approval-required response to include audit event")

    scorecard = response.get("scorecard")
    _assert_scorecard_checks(
        case,
        scorecard.get("scores") if isinstance(scorecard, dict) else None,
        scorecard_checks,
    )


def assert_recoverable_run(
    case: unittest.TestCase,
    run: TriageRun,
    *,
    error_contains: str | None = None,
) -> None:
    case.assertIn(WorkflowState.RECOVERABLE_FAILURE, run.states, "expected recoverable_failure state")
    case.assertIn(WorkflowState.SCORED, run.states, "expected scored state")
    case.assertIsNotNone(run.validation, "expected validation errors on recoverable run")
    assert run.validation is not None
    case.assertFalse(run.validation.valid, "expected recoverable run validation to be invalid")
    case.assertIsNone(run.validation.decision, "expected recoverable run to omit trusted decision")
    if error_contains is not None:
        case.assertTrue(
            any(error_contains in error for error in run.validation.errors),
            f"expected validation error containing {error_contains!r}, got {run.validation.errors!r}",
        )
    case.assertIsNone(run.safety, "expected recoverable run to skip safety action")
    case.assertIsNotNone(run.scorecard, "expected recoverable run to include scorecard")


def assert_recoverable_response(
    case: unittest.TestCase,
    response: dict[str, Any],
    *,
    error_contains: str | None = None,
) -> None:
    case.assertEqual(response.get("status"), "ok", f"expected ok response, got {response!r}")
    case.assertIn(WorkflowState.RECOVERABLE_FAILURE.value, response.get("states", ()), "expected recoverable_failure state")
    validation = response.get("validation")
    case.assertIsInstance(validation, dict, "expected response validation object")
    assert isinstance(validation, dict)
    case.assertFalse(validation.get("valid"), "expected response validation to be invalid")
    case.assertNotIn("decision", response, "expected recoverable response to omit trusted decision")
    case.assertNotIn("safety", response, "expected recoverable response to skip safety action")
    if error_contains is not None:
        errors = tuple(validation.get("errors", ()))
        case.assertTrue(
            any(error_contains in error for error in errors),
            f"expected validation error containing {error_contains!r}, got {errors!r}",
        )
    case.assertIn("scorecard", response, "expected recoverable response to include scorecard")


def assert_ignored_response(
    case: unittest.TestCase,
    status: int,
    response: dict[str, Any],
    *,
    reason: str,
) -> None:
    case.assertEqual(status, 202)
    case.assertEqual(response.get("status"), "ignored")
    case.assertEqual(response.get("reason"), reason)
    case.assertNotIn("decision", response)
    case.assertNotIn("safety", response)


def _assert_cited_prefixes(
    case: unittest.TestCase,
    evidence_ids: tuple[str, ...],
    evidence_prefixes: tuple[str, ...],
) -> None:
    for prefix in evidence_prefixes:
        case.assertTrue(
            any(evidence_id.startswith(prefix) for evidence_id in evidence_ids),
            f"expected cited evidence prefix {prefix!r}, got {evidence_ids!r}",
        )


def _assert_contains_all(
    case: unittest.TestCase,
    actual: tuple[str, ...],
    expected: tuple[str, ...],
    label: str,
) -> None:
    for item in expected:
        case.assertIn(item, actual, f"expected {label} to include {item!r}, got {actual!r}")


def _assert_safety(
    case: unittest.TestCase,
    actual_status: Any,
    actual_approval_required: Any,
    expected_status: SafetyStatus | str | None,
    expected_approval_required: bool | None,
) -> None:
    if expected_status is not None:
        case.assertEqual(
            _value(expected_status),
            actual_status,
            f"expected safety_status={_value(expected_status)!r}, got {actual_status!r}",
        )
    if expected_approval_required is not None:
        case.assertEqual(
            expected_approval_required,
            actual_approval_required,
            f"expected approval_required={expected_approval_required!r}, got {actual_approval_required!r}",
        )


def _assert_scorecard_checks(
    case: unittest.TestCase,
    scores: dict[str, bool] | None,
    scorecard_checks: tuple[str, ...],
) -> None:
    if not scorecard_checks:
        return
    case.assertIsNotNone(scores, "expected scorecard scores")
    assert scores is not None
    for check in scorecard_checks:
        case.assertIn(check, scores, f"expected scorecard check {check!r}, got {sorted(scores)!r}")
        case.assertTrue(scores[check], f"expected scorecard check {check!r} to pass")


def _value(value: Any) -> str:
    if hasattr(value, "value"):
        return str(value.value)
    return str(value)
