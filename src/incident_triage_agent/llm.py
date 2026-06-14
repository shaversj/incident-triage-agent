from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import AppConfig, redact_secret
from .domain import (
    DecisionValidationError,
    EvidencePackage,
    IncidentClass,
    NextAction,
    TriageDecision,
    ValidationResult,
)


LOW_CONFIDENCE_THRESHOLD = 0.55


class LLMClient(Protocol):
    def decide(self, evidence_package: EvidencePackage) -> ValidationResult:
        ...


@dataclass(frozen=True)
class ProviderFailure:
    message: str


def build_decision_prompt(evidence_package: EvidencePackage) -> str:
    incident = evidence_package.incident
    evidence_lines = [
        f"- {item.evidence_id} [{item.source}] {item.summary}: {item.detail}"
        for item in evidence_package.evidence
    ]
    missing = ", ".join(evidence_package.missing_context) or "none"
    classes = ", ".join(item.value for item in IncidentClass)
    actions = ", ".join(item.value for item in NextAction)
    return "\n".join(
        [
            "Classify this incident and choose the next bounded action.",
            f"Allowed incident_class values: {classes}.",
            f"Allowed next_action values: {actions}.",
            "Return only one JSON object.",
            "Use this shape exactly: {\"incident_class\":\"...\",\"next_action\":\"...\",\"confidence\":0.0,\"evidence_ids\":[\"...\"],\"caveats\":[\"...\"],\"verification_plan\":[\"...\"]}.",
            "The evidence_ids, caveats, and verification_plan fields must be arrays of strings.",
            "",
            f"Incident: {incident.incident_id} - {incident.title}",
            f"Service: {incident.service}",
            f"Severity: {incident.severity}",
            f"Missing context: {missing}",
            "Evidence:",
            *evidence_lines,
        ]
    )


def extract_text_from_anthropic_response(payload: dict[str, Any]) -> str:
    blocks = payload.get("content", [])
    if not isinstance(blocks, list):
        raise DecisionValidationError("MiniMax response content is not a list.")

    text_blocks: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            text_blocks.append(block["text"])

    if not text_blocks:
        raise DecisionValidationError("MiniMax response did not contain usable text content.")
    return "\n".join(text_blocks).strip()


def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped


def parse_decision_text(text: str, evidence_package: EvidencePackage | None = None) -> ValidationResult:
    cleaned = _strip_json_fence(text)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as error:
        return ValidationResult(
            decision=None,
            valid=False,
            errors=(f"Decision was not valid JSON: {error.msg}.",),
            raw_text=text,
        )

    try:
        decision = validate_decision_payload(payload, evidence_package)
    except DecisionValidationError as error:
        return ValidationResult(decision=None, valid=False, errors=(str(error),), raw_text=text)

    return ValidationResult(decision=decision, valid=True, raw_text=text)


def validate_decision_payload(
    payload: dict[str, Any],
    evidence_package: EvidencePackage | None = None,
) -> TriageDecision:
    if not isinstance(payload, dict):
        raise DecisionValidationError("Decision payload must be an object.")

    try:
        incident_class = IncidentClass(payload["incident_class"])
    except (KeyError, ValueError) as error:
        raise DecisionValidationError("Decision incident_class is missing or unsupported.") from error

    try:
        next_action = NextAction(payload["next_action"])
    except (KeyError, ValueError) as error:
        raise DecisionValidationError("Decision next_action is missing or unsupported.") from error

    confidence = payload.get("confidence")
    if not isinstance(confidence, int | float):
        raise DecisionValidationError("Decision confidence must be numeric.")
    confidence = float(confidence)
    if not 0 <= confidence <= 1:
        raise DecisionValidationError("Decision confidence must be between 0 and 1.")
    if confidence < LOW_CONFIDENCE_THRESHOLD:
        raise DecisionValidationError("Decision confidence is too low for workflow use.")

    evidence_ids = _require_string_tuple(payload, "evidence_ids")
    caveats = _require_string_tuple(payload, "caveats")
    verification_plan = _require_string_tuple(payload, "verification_plan")

    if evidence_package:
        known_ids = evidence_package.ids()
        unknown = sorted(item for item in evidence_ids if item not in known_ids)
        if unknown:
            raise DecisionValidationError(f"Decision cited unknown evidence IDs: {', '.join(unknown)}.")

    return TriageDecision(
        incident_class=incident_class,
        next_action=next_action,
        confidence=confidence,
        evidence_ids=evidence_ids,
        caveats=caveats,
        verification_plan=verification_plan,
    )


def _require_string_tuple(payload: dict[str, Any], key: str) -> tuple[str, ...]:
    value = payload.get(key)
    if isinstance(value, str):
        return (value,)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise DecisionValidationError(f"Decision {key} must be a string or list of strings.")
    return tuple(value)


class MiniMaxAnthropicClient:
    def __init__(self, config: AppConfig, timeout_seconds: int = 30) -> None:
        self.config = config
        self.timeout_seconds = timeout_seconds

    def decide(self, evidence_package: EvidencePackage) -> ValidationResult:
        prompt = build_decision_prompt(evidence_package)
        request_payload = {
            "model": self.config.model_name,
            "messages": [{"role": "user", "content": prompt}],
        }
        try:
            response_payload = self._post_messages(request_payload)
            text = extract_text_from_anthropic_response(response_payload)
        except (DecisionValidationError, ProviderFailure) as error:
            return ValidationResult(decision=None, valid=False, errors=(str(error),), raw_text="")

        return parse_decision_text(text, evidence_package)

    def _post_messages(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.config.minimax_base_url.rstrip('/')}/anthropic/v1/messages",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Api-Key": self.config.minimax_api_key,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise ProviderFailure(f"MiniMax HTTP error: {error.code}.") from error
        except URLError as error:
            safe_reason = redact_secret(str(error.reason), self.config)
            raise ProviderFailure(f"MiniMax request failed: {safe_reason}.") from error
        except TimeoutError as error:
            raise ProviderFailure("MiniMax request timed out.") from error


class StaticLLMClient:
    def __init__(self, responses: dict[str, str]) -> None:
        self.responses = responses

    def decide(self, evidence_package: EvidencePackage) -> ValidationResult:
        text = self.responses.get(evidence_package.scenario_name)
        if text is None:
            return ValidationResult(
                decision=None,
                valid=False,
                errors=(f"No static LLM response for scenario: {evidence_package.scenario_name}.",),
            )
        return parse_decision_text(text, evidence_package)
