import json
import unittest
from pathlib import Path

from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.loki import LokiClient, LokiLogEntry
from incident_triage_agent.server import WebhookRuntime, handle_grafana_webhook


class FakeLokiClient:
    def query_range(self, labels, start_ns, end_ns, limit=20, direction="forward"):
        self.last_query = {
            "labels": labels,
            "start_ns": start_ns,
            "end_ns": end_ns,
            "limit": limit,
            "direction": direction,
        }
        return (
            LokiLogEntry("1781622420000000000", "payment timeout after 3000ms", {"service": "checkout-api"}),
        )

    def to_evidence(self, entries):
        return LokiClient.to_evidence(entries)


class ServerTests(unittest.TestCase):
    def test_rejects_invalid_webhook_secret(self) -> None:
        status, response = handle_grafana_webhook(
            self.load_payload(),
            "wrong-secret",
            self.runtime(),
        )

        self.assertEqual(status, 401)
        self.assertEqual(response["error"], "unauthorized")

    def test_valid_webhook_returns_triage_json(self) -> None:
        loki = FakeLokiClient()
        payload = self.load_payload()

        status, response = handle_grafana_webhook(
            payload,
            "test-secret",
            self.runtime(loki_client=loki),
        )

        self.assertEqual(status, 200)
        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["incident"]["service"], "checkout-api")
        self.assertEqual(response["decision"]["incident_class"], "dependency_outage")
        self.assertEqual(response["decision"]["next_action"], "escalate_owner")
        self.assertIn("alert:0", response["decision"]["evidence_ids"])
        self.assertIn("log:0", response["decision"]["evidence_ids"])
        self.assertEqual(response["safety"]["status"], "safe_recommendation")
        self.assertIn("current_signal", response["provenance"]["available_tiers"])
        self.assertIn("operational_context", response["provenance"]["available_tiers"])
        self.assertEqual(loki.last_query["labels"], {"service": "checkout-api"})
        self.assertEqual(loki.last_query["direction"], "forward")

    def test_resolved_webhook_is_ignored(self) -> None:
        payload = self.load_payload()
        payload["status"] = "resolved"
        for alert in payload["alerts"]:
            alert["status"] = "resolved"

        status, response = handle_grafana_webhook(
            payload,
            "test-secret",
            self.runtime(),
        )

        self.assertEqual(status, 202)
        self.assertEqual(response["status"], "ignored")
        self.assertEqual(response["reason"], "resolved_alert")

    def runtime(self, loki_client=None) -> WebhookRuntime:
        scenario_name = "grafana-checkout-api"
        llm = StaticLLMClient(
            {
                scenario_name: json.dumps(
                    {
                        "incident_class": "dependency_outage",
                        "next_action": "escalate_owner",
                        "confidence": 0.87,
                        "evidence_ids": ["alert:0", "log:0", "runbook:dependency-outage"],
                        "caveats": ["Synthetic integration path."],
                        "verification_plan": ["Watch payment timeout rate."],
                    }
                )
            }
        )
        return WebhookRuntime(
            fixtures_dir=Path("fixtures"),
            webhook_secret="test-secret",
            llm_client=llm,
            loki_client=loki_client,
        )

    def load_payload(self) -> dict:
        return json.loads(Path("fixtures/grafana/checkout-payment-timeout-webhook.json").read_text())


if __name__ == "__main__":
    unittest.main()
