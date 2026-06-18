from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any

from loguru import logger

from .domain import FixtureError, Incident, PROHIBITED_INCIDENT_FIELDS, validate_raw_incident_payload


log = logger.bind(component="grafana")
SERVICE_LABELS = ("service", "app", "job")


class GrafanaPayloadError(Exception):
    """Raised when a Grafana webhook payload cannot become a raw incident."""


@dataclass(frozen=True)
class GrafanaNormalizationResult:
    scenario_name: str
    incident: Incident
    loki_query_labels: dict[str, str]
    start_ns: int
    end_ns: int
    ignored: bool = False
    ignored_reason: str = ""


def normalize_grafana_payload(payload: dict[str, Any]) -> GrafanaNormalizationResult:
    if not isinstance(payload, dict):
        raise GrafanaPayloadError("Grafana payload must be a JSON object.")
    _reject_answer_like_fields(payload)

    alerts = payload.get("alerts")
    if not isinstance(alerts, list):
        raise GrafanaPayloadError("Grafana payload must include an alerts array.")
    if not alerts:
        raise GrafanaPayloadError("Grafana payload did not include any alerts.")

    active_alerts = [alert for alert in alerts if isinstance(alert, dict) and alert.get("status") == "firing"]
    service_key, service = _extract_service(payload, alerts)
    scenario_name = _scenario_name(payload, active_alerts or alerts, service)
    start = _earliest_start(active_alerts or alerts)
    start_ns, end_ns = _loki_window_ns(start)

    if not active_alerts:
        incident = Incident(
            incident_id=f"GRAFANA-{_first_fingerprint(alerts)}",
            title=_title(payload, service),
            severity=_severity(payload, alerts),
            status="resolved",
            started_at=start,
            service=service,
            symptoms=(),
            alerts=(),
        )
        return GrafanaNormalizationResult(
            scenario_name=scenario_name,
            incident=incident,
            loki_query_labels={service_key: service},
            start_ns=start_ns,
            end_ns=end_ns,
            ignored=True,
            ignored_reason="resolved_alert",
        )

    incident_payload = {
        "incident_id": f"GRAFANA-{_first_fingerprint(active_alerts)}",
        "title": _title(payload, service),
        "severity": _severity(payload, active_alerts),
        "status": "active",
        "started_at": start,
        "service": service,
        "symptoms": _symptoms(active_alerts),
        "alerts": _alert_names(active_alerts),
        "recent_changes": [],
        "log_signals": [],
        "runbook_refs": _runbook_refs(active_alerts),
        "prior_incident_refs": [],
        "verification_signals": _verification_signals(active_alerts),
    }
    validate_raw_incident_payload(incident_payload)
    incident = Incident(
        incident_id=incident_payload["incident_id"],
        title=incident_payload["title"],
        severity=incident_payload["severity"],
        status=incident_payload["status"],
        started_at=incident_payload["started_at"],
        service=incident_payload["service"],
        symptoms=tuple(incident_payload["symptoms"]),
        alerts=tuple(incident_payload["alerts"]),
        runbook_refs=tuple(incident_payload["runbook_refs"]),
        verification_signals=tuple(incident_payload["verification_signals"]),
    )
    log.info(
        "Normalized Grafana payload for service {} with {} firing alert(s).",
        service,
        len(active_alerts),
    )
    return GrafanaNormalizationResult(
        scenario_name=scenario_name,
        incident=incident,
        loki_query_labels={service_key: service},
        start_ns=start_ns,
        end_ns=end_ns,
    )


def _reject_answer_like_fields(value: Any) -> None:
    if isinstance(value, dict):
        prohibited = sorted(PROHIBITED_INCIDENT_FIELDS.intersection(value))
        if prohibited:
            raise FixtureError(
                "Grafana payload contains prohibited answer fields: "
                f"{', '.join(prohibited)}."
            )
        for nested in value.values():
            _reject_answer_like_fields(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_answer_like_fields(nested)


def _extract_service(payload: dict[str, Any], alerts: list[Any]) -> tuple[str, str]:
    for labels_key in ("commonLabels", "groupLabels"):
        labels = payload.get(labels_key)
        if isinstance(labels, dict):
            for key in SERVICE_LABELS:
                if labels.get(key):
                    return key, str(labels[key])

    for alert in alerts:
        if not isinstance(alert, dict):
            continue
        labels = alert.get("labels")
        if not isinstance(labels, dict):
            continue
        for key in SERVICE_LABELS:
            if labels.get(key):
                return key, str(labels[key])

    raise GrafanaPayloadError("Grafana payload did not include a service, app, or job label.")


def _scenario_name(payload: dict[str, Any], alerts: list[Any], service: str) -> str:
    for labels_key in ("commonLabels", "groupLabels"):
        labels = payload.get(labels_key)
        if isinstance(labels, dict) and labels.get("scenario"):
            return f"grafana-{_slug(str(labels['scenario']))}"

    for alert in alerts:
        if not isinstance(alert, dict):
            continue
        labels = alert.get("labels")
        if isinstance(labels, dict) and labels.get("scenario"):
            return f"grafana-{_slug(str(labels['scenario']))}"

    return f"grafana-{_slug(service)}"


def _title(payload: dict[str, Any], service: str) -> str:
    common_annotations = payload.get("commonAnnotations")
    if isinstance(common_annotations, dict) and common_annotations.get("summary"):
        return str(common_annotations["summary"])

    title = str(payload.get("title") or f"Grafana alert for {service}")
    return re.sub(r"^\[[^\]]+\]\s*", "", title).strip() or f"Grafana alert for {service}"


def _severity(payload: dict[str, Any], alerts: list[dict[str, Any]]) -> str:
    labels_sources = [payload.get("commonLabels"), payload.get("groupLabels")]
    labels_sources.extend(alert.get("labels") for alert in alerts if isinstance(alert, dict))
    for labels in labels_sources:
        if isinstance(labels, dict) and labels.get("severity"):
            return str(labels["severity"]).upper()
    return "UNKNOWN"


def _alert_names(alerts: list[dict[str, Any]]) -> tuple[str, ...]:
    names: list[str] = []
    for index, alert in enumerate(alerts):
        labels = alert.get("labels") if isinstance(alert, dict) else {}
        if isinstance(labels, dict) and labels.get("alertname"):
            names.append(str(labels["alertname"]))
        else:
            names.append(f"grafana-alert-{index}")
    return tuple(names)


def _symptoms(alerts: list[dict[str, Any]]) -> tuple[str, ...]:
    symptoms: list[str] = []
    for alert in alerts:
        annotations = alert.get("annotations")
        if isinstance(annotations, dict):
            for key in ("summary", "description"):
                value = annotations.get(key)
                if value:
                    symptoms.append(str(value))
        values = alert.get("values")
        if isinstance(values, dict):
            rendered = ", ".join(f"{key}={value}" for key, value in sorted(values.items()))
            if rendered:
                symptoms.append(f"grafana_values: {rendered}")
    return tuple(dict.fromkeys(symptoms))


def _runbook_refs(alerts: list[dict[str, Any]]) -> tuple[str, ...]:
    refs: list[str] = []
    for alert in alerts:
        annotations = alert.get("annotations")
        if not isinstance(annotations, dict):
            continue
        for key in ("runbook_ref", "runbook"):
            if annotations.get(key):
                refs.append(str(annotations[key]))
    return tuple(dict.fromkeys(refs))


def _verification_signals(alerts: list[dict[str, Any]]) -> tuple[str, ...]:
    signals: list[str] = []
    for alert in alerts:
        fingerprint = alert.get("fingerprint")
        if fingerprint:
            signals.append(f"grafana:fingerprint:{fingerprint}")
        for key in ("generatorURL", "dashboardURL", "panelURL", "silenceURL"):
            value = alert.get(key)
            if value:
                signals.append(f"grafana:{key}:{value}")
    return tuple(dict.fromkeys(signals))


def _first_fingerprint(alerts: list[Any]) -> str:
    for alert in alerts:
        if isinstance(alert, dict) and alert.get("fingerprint"):
            return _slug(str(alert["fingerprint"]))
    return "unknown"


def _earliest_start(alerts: list[Any]) -> str:
    starts = (
        _parse_time(str(alert["startsAt"]))
        for alert in alerts
        if isinstance(alert, dict) and isinstance(alert.get("startsAt"), str)
    )
    earliest = min(starts, default=None)
    if earliest is None:
        raise GrafanaPayloadError("Grafana payload did not include startsAt on any alert.")
    return earliest.isoformat().replace("+00:00", "Z")


def _loki_window_ns(starts_at: str, padding: timedelta = timedelta(minutes=10)) -> tuple[int, int]:
    started = _parse_time(starts_at)
    return (
        _to_ns(started - padding),
        _to_ns(started + padding),
    )


def _parse_time(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise GrafanaPayloadError(f"Invalid Grafana startsAt value: {value}.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _to_ns(value: datetime) -> int:
    return int(value.timestamp() * 1_000_000_000)


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return slug or "unknown"
