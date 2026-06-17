import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import IncidentClass, NextAction, SafetyStatus, SourceTier
from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.loki import LokiClient, LokiLogEntry
from incident_triage_agent.server import WebhookRuntime, handle_grafana_webhook
from tests.support.outcomes import (
    assert_ignored_response,
    assert_recoverable_response,
    assert_valid_response_outcome,
)


class WebhookOutcomeTests(unittest.TestCase):
    def test_active_webhook_outcome_includes_alert_log_provenance_and_safety(self) -> None:
        status, response = handle_grafana_webhook(
            self.load_payload(),
            "test-secret",
            self.runtime(),
        )

        self.assertEqual(status, 200)
        assert_valid_response_outcome(
            self,
            response,
            incident_class=IncidentClass.DEPENDENCY_OUTAGE,
            next_action=NextAction.ESCALATE_OWNER,
            evidence_prefixes=("alert:", "log:", "runbook:"),
            cited_sources=("alert", "log", "runbook"),
            available_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
            cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
            safety_status=SafetyStatus.SAFE_RECOMMENDATION,
            approval_required=False,
            scorecard_checks=("state_correctness", "evidence_grounding", "safety_behavior", "evidence_quality"),
        )

    def test_resolved_webhook_outcome_is_ignored_without_decision_or_safety(self) -> None:
        payload = self.load_payload()
        payload["status"] = "resolved"
        for alert in payload["alerts"]:
            alert["status"] = "resolved"

        status, response = handle_grafana_webhook(
            payload,
            "test-secret",
            self.runtime(),
        )

        assert_ignored_response(self, status, response, reason="resolved_alert")

    def test_missing_loki_logs_outcome_preserves_missing_context(self) -> None:
        status, response = handle_grafana_webhook(
            self.load_payload(),
            "test-secret",
            self.runtime(
                loki_client=EmptyLokiClient(),
                llm_client=self.llm_response(
                    {
                        "incident_class": "dependency_outage",
                        "next_action": "escalate_owner",
                        "confidence": 0.81,
                        "evidence_ids": ["alert:0", "runbook:dependency-outage"],
                        "caveats": ["Loki returned no logs for the alert window."],
                        "verification_plan": ["Keep watching timeout rate."],
                    }
                ),
            ),
        )

        self.assertEqual(status, 200)
        assert_valid_response_outcome(
            self,
            response,
            incident_class=IncidentClass.DEPENDENCY_OUTAGE,
            next_action=NextAction.ESCALATE_OWNER,
            evidence_prefixes=("alert:", "runbook:"),
            available_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
            cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.GUIDANCE),
            safety_status=SafetyStatus.SAFE_RECOMMENDATION,
            approval_required=False,
        )
        self.assertIn("logs", response["provenance"]["missing_context"])

    def test_invalid_webhook_decision_outcome_is_recoverable(self) -> None:
        status, response = handle_grafana_webhook(
            self.load_payload(),
            "test-secret",
            self.runtime(llm_client=StaticLLMClient({"grafana-checkout-api": "{not json"})),
        )

        self.assertEqual(status, 200)
        assert_recoverable_response(self, response, error_contains="not valid JSON")

    def runtime(self, loki_client=None, llm_client=None) -> WebhookRuntime:
        return WebhookRuntime(
            fixtures_dir=Path("fixtures"),
            webhook_secret="test-secret",
            llm_client=llm_client or self.llm_response(
                {
                    "incident_class": "dependency_outage",
                    "next_action": "escalate_owner",
                    "confidence": 0.87,
                    "evidence_ids": ["alert:0", "log:0", "runbook:dependency-outage"],
                    "caveats": ["Synthetic integration path."],
                    "verification_plan": ["Watch payment timeout rate."],
                }
            ),
            loki_client=loki_client or FakeLokiClient(),
        )

    def llm_response(self, response: dict) -> StaticLLMClient:
        return StaticLLMClient({"grafana-checkout-api": json.dumps(response)})

    def load_payload(self) -> dict:
        return json.loads(Path("fixtures/grafana/checkout-payment-timeout-webhook.json").read_text())


class FakeLokiClient:
    def query_range(self, *_args, **_kwargs):
        return (
            LokiLogEntry("1781622420000000000", "payment timeout after 3000ms", {"service": "checkout-api"}),
        )

    def to_evidence(self, entries):
        return LokiClient.to_evidence(entries)


class EmptyLokiClient:
    def query_range(self, *_args, **_kwargs):
        return ()

    def to_evidence(self, entries):
        return LokiClient.to_evidence(entries)


if __name__ == "__main__":
    unittest.main()
