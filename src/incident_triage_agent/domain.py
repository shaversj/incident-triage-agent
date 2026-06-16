from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
import json
from pathlib import Path
from typing import Any


PROHIBITED_INCIDENT_FIELDS = {"suspected_causes", "recommended_actions", "requires_approval"}


class IncidentClass(StrEnum):
    DEPENDENCY_OUTAGE = "dependency_outage"
    BAD_DEPLOY = "bad_deploy"
    CAPACITY_SATURATION = "capacity_saturation"
    NOISY_ALERT = "noisy_alert"
    INSUFFICIENT_CONTEXT = "insufficient_context"
    UNKNOWN = "unknown"


class NextAction(StrEnum):
    ESCALATE_OWNER = "escalate_owner"
    REQUEST_ROLLBACK_APPROVAL = "request_rollback_approval"
    APPLY_RUNBOOK_STEP_WITH_APPROVAL = "apply_runbook_step_with_approval"
    CONTINUE_MONITORING = "continue_monitoring"
    ASK_HUMAN = "ask_human"
    GATHER_MORE_CONTEXT = "gather_more_context"


class WorkflowState(StrEnum):
    RECEIVED = "received"
    CONTEXT_GATHERED = "context_gathered"
    LLM_DECISION_REQUESTED = "llm_decision_requested"
    DECISION_VALIDATED = "decision_validated"
    RECOVERABLE_FAILURE = "recoverable_failure"
    HUMAN_INPUT_NEEDED = "human_input_needed"
    APPROVAL_PENDING = "approval_pending"
    VERIFICATION_READY = "verification_ready"
    SIMULATED_ACTION_RECORDED = "simulated_action_recorded"
    SCORED = "scored"


class SourceTier(StrEnum):
    CURRENT_SIGNAL = "current_signal"
    OPERATIONAL_CONTEXT = "operational_context"
    GUIDANCE = "guidance"
    HISTORICAL_CONTEXT = "historical_context"


class FixtureError(Exception):
    """Raised when fixture data violates the raw-data contract."""


class DecisionValidationError(Exception):
    """Raised when an LLM decision cannot be trusted by the workflow."""


@dataclass(frozen=True)
class RecentChange:
    time: str
    service: str
    change: str


@dataclass(frozen=True)
class Incident:
    incident_id: str
    title: str
    severity: str
    status: str
    started_at: str
    service: str
    symptoms: tuple[str, ...]
    alerts: tuple[str, ...]
    recent_changes: tuple[RecentChange, ...] = ()
    log_signals: tuple[str, ...] = ()
    runbook_refs: tuple[str, ...] = ()
    prior_incident_refs: tuple[str, ...] = ()
    verification_signals: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvalExpectation:
    incident_class: IncidentClass
    allowed_next_actions: tuple[NextAction, ...]
    required_evidence_prefixes: tuple[str, ...] = ()
    approval_required: bool = False


@dataclass(frozen=True)
class Scenario:
    name: str
    incident: Incident
    expected: EvalExpectation | None = None


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    source: str
    source_tier: SourceTier
    summary: str
    detail: str = ""


@dataclass(frozen=True)
class ProvenanceSummary:
    available_tiers: tuple[SourceTier, ...]
    cited_tiers: tuple[SourceTier, ...]
    cited_sources: tuple[str, ...]
    cited_evidence_ids: tuple[str, ...]
    missing_context: tuple[str, ...] = ()

    @property
    def has_current_or_operational_support(self) -> bool:
        return any(
            tier in {SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT}
            for tier in self.cited_tiers
        )

    @property
    def historical_only(self) -> bool:
        return bool(self.cited_tiers) and self.cited_tiers == (SourceTier.HISTORICAL_CONTEXT,)


@dataclass(frozen=True)
class EvidencePackage:
    scenario_name: str
    incident: Incident
    evidence: tuple[Evidence, ...]
    missing_context: tuple[str, ...] = ()

    def ids(self) -> set[str]:
        return {item.evidence_id for item in self.evidence}

    def by_id(self) -> dict[str, Evidence]:
        return {item.evidence_id: item for item in self.evidence}

    def provenance_summary(self, cited_evidence_ids: tuple[str, ...] = ()) -> ProvenanceSummary:
        evidence_by_id = self.by_id()
        cited = tuple(
            evidence_by_id[evidence_id]
            for evidence_id in cited_evidence_ids
            if evidence_id in evidence_by_id
        )
        return ProvenanceSummary(
            available_tiers=_ordered_tiers(item.source_tier for item in self.evidence),
            cited_tiers=_ordered_tiers(item.source_tier for item in cited),
            cited_sources=_ordered_strings(item.source for item in cited),
            cited_evidence_ids=tuple(item.evidence_id for item in cited),
            missing_context=self.missing_context,
        )


@dataclass(frozen=True)
class TriageDecision:
    incident_class: IncidentClass
    next_action: NextAction
    confidence: float
    evidence_ids: tuple[str, ...]
    caveats: tuple[str, ...]
    verification_plan: tuple[str, ...]


@dataclass(frozen=True)
class ValidationResult:
    decision: TriageDecision | None
    valid: bool
    errors: tuple[str, ...] = ()
    raw_text: str = ""


@dataclass(frozen=True)
class SafetyResult:
    status: str
    approval_required: bool
    reason: str
    staged_payload: dict[str, Any] | None = None
    audit_event: dict[str, Any] | None = None


@dataclass(frozen=True)
class Scorecard:
    scenario_name: str
    scores: dict[str, bool]
    notes: tuple[str, ...] = ()


class SafetyStatus(StrEnum):
    SAFE_RECOMMENDATION = "safe_recommendation"
    APPROVAL_REQUIRED = "approval_required"
    NEEDS_HUMAN_INPUT = "needs_human_input"
    UNSUPPORTED = "unsupported"


@dataclass
class TriageRun:
    scenario: Scenario
    states: list[WorkflowState] = field(default_factory=list)
    evidence_package: EvidencePackage | None = None
    validation: ValidationResult | None = None
    safety: SafetyResult | None = None
    scorecard: Scorecard | None = None

    def transition(self, state: WorkflowState) -> None:
        self.states.append(state)


def validate_raw_incident_payload(payload: dict[str, Any]) -> None:
    present = sorted(PROHIBITED_INCIDENT_FIELDS.intersection(payload))
    if present:
        fields = ", ".join(present)
        raise FixtureError(f"Raw incident fixture contains prohibited answer fields: {fields}.")


def _parse_incident(payload: dict[str, Any]) -> Incident:
    validate_raw_incident_payload(payload)
    changes = tuple(RecentChange(**item) for item in payload.get("recent_changes", []))
    return Incident(
        incident_id=payload["incident_id"],
        title=payload["title"],
        severity=payload["severity"],
        status=payload["status"],
        started_at=payload["started_at"],
        service=payload["service"],
        symptoms=tuple(payload.get("symptoms", [])),
        alerts=tuple(payload.get("alerts", [])),
        recent_changes=changes,
        log_signals=tuple(payload.get("log_signals", [])),
        runbook_refs=tuple(payload.get("runbook_refs", [])),
        prior_incident_refs=tuple(payload.get("prior_incident_refs", [])),
        verification_signals=tuple(payload.get("verification_signals", [])),
    )


def _parse_expected(payload: dict[str, Any]) -> EvalExpectation:
    return EvalExpectation(
        incident_class=IncidentClass(payload["incident_class"]),
        allowed_next_actions=tuple(NextAction(value) for value in payload["allowed_next_actions"]),
        required_evidence_prefixes=tuple(payload.get("required_evidence_prefixes", [])),
        approval_required=bool(payload.get("approval_required", False)),
    )


def load_scenario(fixtures_dir: Path, name: str) -> Scenario:
    scenario_path = fixtures_dir / "scenarios" / f"{name}.json"
    if not scenario_path.exists():
        raise FixtureError(f"Unknown scenario: {name}.")
    payload = json.loads(scenario_path.read_text())
    return Scenario(
        name=name,
        incident=_parse_incident(payload["incident"]),
        expected=_parse_expected(payload["expected"]),
    )


def list_scenarios(fixtures_dir: Path) -> list[str]:
    scenarios_dir = fixtures_dir / "scenarios"
    if not scenarios_dir.exists():
        return []
    return sorted(path.stem for path in scenarios_dir.glob("*.json"))


def _ordered_tiers(values) -> tuple[SourceTier, ...]:
    seen = set(values)
    return tuple(tier for tier in SourceTier if tier in seen)


def _ordered_strings(values) -> tuple[str, ...]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return tuple(ordered)
