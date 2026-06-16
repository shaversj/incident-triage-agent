import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import FixtureError
from incident_triage_agent.grafana import GrafanaPayloadError, normalize_grafana_payload


class GrafanaPayloadTests(unittest.TestCase):
    def test_active_payload_normalizes_to_raw_incident(self) -> None:
        payload = self.load_payload()

        result = normalize_grafana_payload(payload)

        self.assertFalse(result.ignored)
        self.assertEqual(result.scenario_name, "grafana-checkout-api")
        self.assertEqual(result.incident.incident_id, "GRAFANA-checkout-latency-001")
        self.assertEqual(result.incident.title, "Checkout API latency spike")
        self.assertEqual(result.incident.status, "active")
        self.assertEqual(result.incident.started_at, "2026-06-16T14:07:00Z")
        self.assertEqual(result.incident.service, "checkout-api")
        self.assertEqual(
            result.incident.alerts,
            ("checkout-api HighLatency", "payment-gateway ElevatedErrors"),
        )
        self.assertIn("Checkout API p95 latency above 2500ms", result.incident.symptoms)
        self.assertIn("grafana:fingerprint:checkout-latency-001", result.incident.verification_signals)
        self.assertEqual(result.incident.runbook_refs, ("dependency-outage",))
        self.assertEqual(result.loki_query_labels, {"service": "checkout-api"})

    def test_resolved_only_payload_is_ignored(self) -> None:
        payload = self.load_payload()
        payload["status"] = "resolved"
        for alert in payload["alerts"]:
            alert["status"] = "resolved"

        result = normalize_grafana_payload(payload)

        self.assertTrue(result.ignored)
        self.assertEqual(result.ignored_reason, "resolved_alert")

    def test_answer_like_annotation_is_rejected(self) -> None:
        payload = self.load_payload()
        payload["alerts"][0]["annotations"]["recommended_actions"] = "roll back production"

        with self.assertRaises(FixtureError):
            normalize_grafana_payload(payload)

    def test_missing_service_label_raises_payload_error(self) -> None:
        payload = self.load_payload()
        payload["commonLabels"].pop("service")
        payload["groupLabels"].pop("service")
        for alert in payload["alerts"]:
            alert["labels"].pop("service", None)

        with self.assertRaises(GrafanaPayloadError):
            normalize_grafana_payload(payload)

    def load_payload(self) -> dict:
        return json.loads(Path("fixtures/grafana/checkout-payment-timeout-webhook.json").read_text())


if __name__ == "__main__":
    unittest.main()
