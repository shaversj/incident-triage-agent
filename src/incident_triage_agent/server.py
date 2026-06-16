from __future__ import annotations

from dataclasses import dataclass
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from loguru import logger

from .domain import FixtureError, Scenario, TriageRun
from .grafana import GrafanaPayloadError, normalize_grafana_payload
from .llm import LLMClient
from .loki import LokiClient, LokiClientError
from .tools import PrebuiltOperationalTools, load_tools
from .workflow import TriageWorkflow


log = logger.bind(component="server")


@dataclass(frozen=True)
class WebhookRuntime:
    fixtures_dir: Path
    webhook_secret: str
    llm_client: LLMClient
    loki_client: LokiClient | None = None
    loki_limit: int = 20


def handle_grafana_webhook(
    payload: dict[str, Any],
    provided_secret: str | None,
    runtime: WebhookRuntime,
) -> tuple[int, dict[str, Any]]:
    if runtime.webhook_secret and provided_secret != runtime.webhook_secret:
        log.warning("Rejected Grafana webhook with missing or invalid secret.")
        return 401, {"status": "error", "error": "unauthorized"}

    try:
        normalized = normalize_grafana_payload(payload)
    except (GrafanaPayloadError, FixtureError) as error:
        log.warning("Rejected Grafana webhook payload: {}", error)
        return 400, {"status": "error", "error": str(error)}

    if normalized.ignored:
        return 202, {
            "status": "ignored",
            "reason": normalized.ignored_reason,
            "incident_id": normalized.incident.incident_id,
        }

    extra_missing: list[str] = []
    log_evidence = ()
    if runtime.loki_client:
        try:
            entries = runtime.loki_client.query_range(
                normalized.loki_query_labels,
                normalized.start_ns,
                normalized.end_ns,
                limit=runtime.loki_limit,
                direction="forward",
            )
            log_evidence = runtime.loki_client.to_evidence(entries)
            if not log_evidence:
                extra_missing.append("logs")
        except LokiClientError as error:
            log.warning("Loki lookup failed: {}", error)
            extra_missing.append("logs")
    else:
        extra_missing.append("logs")

    tools = load_tools(runtime.fixtures_dir)
    package = tools.build_evidence_package_from_incident(
        normalized.scenario_name,
        normalized.incident,
        log_evidence=log_evidence,
        extra_missing_context=tuple(extra_missing),
    )
    scenario = Scenario(name=normalized.scenario_name, incident=normalized.incident, expected=None)
    workflow = TriageWorkflow(
        tools=PrebuiltOperationalTools(package),
        llm_client=runtime.llm_client,
    )
    run = workflow.run(scenario)
    return 200, run_to_response(run)


def run_to_response(run: TriageRun) -> dict[str, Any]:
    response: dict[str, Any] = {
        "status": "ok",
        "incident": {
            "incident_id": run.scenario.incident.incident_id,
            "title": run.scenario.incident.title,
            "severity": run.scenario.incident.severity,
            "service": run.scenario.incident.service,
            "status": run.scenario.incident.status,
            "started_at": run.scenario.incident.started_at,
        },
        "scenario": run.scenario.name,
        "states": [state.value for state in run.states],
    }

    if run.validation:
        response["validation"] = {
            "valid": run.validation.valid,
            "errors": list(run.validation.errors),
        }
        if run.validation.decision:
            decision = run.validation.decision
            response["decision"] = {
                "incident_class": decision.incident_class.value,
                "next_action": decision.next_action.value,
                "confidence": decision.confidence,
                "evidence_ids": list(decision.evidence_ids),
                "caveats": list(decision.caveats),
                "verification_plan": list(decision.verification_plan),
            }

    if run.evidence_package:
        cited_ids = ()
        if run.validation and run.validation.decision:
            cited_ids = run.validation.decision.evidence_ids
        provenance = run.evidence_package.provenance_summary(cited_ids)
        response["evidence"] = [
            {
                "evidence_id": item.evidence_id,
                "source": item.source,
                "source_tier": item.source_tier.value,
                "summary": item.summary,
            }
            for item in run.evidence_package.evidence
        ]
        response["provenance"] = {
            "available_tiers": [tier.value for tier in provenance.available_tiers],
            "cited_tiers": [tier.value for tier in provenance.cited_tiers],
            "cited_sources": list(provenance.cited_sources),
            "cited_evidence_ids": list(provenance.cited_evidence_ids),
            "missing_context": list(provenance.missing_context),
            "support": _support(provenance),
        }

    if run.safety:
        response["safety"] = {
            "status": run.safety.status,
            "approval_required": run.safety.approval_required,
            "reason": run.safety.reason,
            "staged_payload": run.safety.staged_payload,
            "audit_event": run.safety.audit_event,
        }

    if run.scorecard:
        response["scorecard"] = {
            "scenario_name": run.scorecard.scenario_name,
            "scores": run.scorecard.scores,
            "notes": list(run.scorecard.notes),
        }

    return response


def serve(host: str, port: int, runtime: WebhookRuntime) -> None:
    handler = _handler_for(runtime)
    httpd = ThreadingHTTPServer((host, port), handler)
    log.info("Starting Grafana webhook server on {}:{}.", host, port)
    httpd.serve_forever()


def _handler_for(runtime: WebhookRuntime):
    class GrafanaWebhookHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/webhooks/grafana":
                self._write_json(404, {"status": "error", "error": "not_found"})
                return

            provided_secret = self.headers.get("X-Webhook-Secret")
            if runtime.webhook_secret and provided_secret != runtime.webhook_secret:
                self._write_json(401, {"status": "error", "error": "unauthorized"})
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > 1_000_000:
                    self._write_json(413, {"status": "error", "error": "payload_too_large"})
                    return
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, json.JSONDecodeError):
                self._write_json(400, {"status": "error", "error": "invalid_json"})
                return

            try:
                status, response = handle_grafana_webhook(payload, provided_secret, runtime)
            except Exception as error:
                log.exception("Unhandled Grafana webhook error: {}", error)
                status, response = 500, {"status": "error", "error": "internal_error"}
            self._write_json(status, response)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return GrafanaWebhookHandler


def _support(provenance) -> str:
    if provenance.historical_only:
        return "historical_only"
    if provenance.has_current_or_operational_support:
        return "current_or_operational"
    return "none"
