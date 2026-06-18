import unittest
from pathlib import Path

from incident_triage_agent.domain import SourceTier, load_scenario
from incident_triage_agent.grafana import normalize_grafana_payload
from incident_triage_agent.loki import LokiClient, LokiLogEntry
from incident_triage_agent.tools import load_tools
import json


class ToolsTests(unittest.TestCase):
    def test_service_lookup_returns_owner_and_escalation_context(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        service = package.by_id()["service:checkout-api"]

        self.assertEqual(service.source, "service")
        self.assertEqual(service.source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertIn("Checkout Platform", service.summary)
        self.assertIn("checkout-platform-oncall", service.detail)

    def test_runbook_lookup_returns_guidance_without_answer_fields(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        runbook = package.by_id()["runbook:dependency-outage"]

        self.assertEqual(runbook.source, "runbook")
        self.assertEqual(runbook.source_tier, SourceTier.GUIDANCE)
        self.assertIn("Dependency Outage Runbook", runbook.summary)
        self.assertNotIn("incident_class", runbook.detail)
        self.assertNotIn("next_action", runbook.detail)

    def test_prior_incident_lookup_returns_stable_evidence_id(self) -> None:
        scenario = load_scenario(Path("fixtures"), "bad-deploy-latency")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        prior = package.by_id()["prior:INC-2025-144"]

        self.assertEqual(prior.source, "prior_incident")
        self.assertEqual(prior.source_tier, SourceTier.HISTORICAL_CONTEXT)
        self.assertIn("Retry rollout", prior.summary)

    def test_tool_sources_receive_expected_tiers(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)
        evidence = package.by_id()

        self.assertEqual(evidence["alert:0"].source_tier, SourceTier.CURRENT_SIGNAL)
        self.assertEqual(evidence["symptom:0"].source_tier, SourceTier.CURRENT_SIGNAL)
        self.assertEqual(evidence["verification:0"].source_tier, SourceTier.CURRENT_SIGNAL)
        self.assertEqual(evidence["deploy:0"].source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertEqual(evidence["log:0"].source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertEqual(evidence["service:checkout-api"].source_tier, SourceTier.OPERATIONAL_CONTEXT)

    def test_missing_runbook_is_missing_context_not_crash(self) -> None:
        scenario = load_scenario(Path("fixtures"), "noisy-alert")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        self.assertIn("runbook", package.missing_context)
        self.assertNotIn("runbook:dependency-outage", package.ids())

    def test_evidence_package_is_deterministic(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        tools = load_tools(Path("fixtures"))

        first = tools.build_evidence_package(scenario)
        second = tools.build_evidence_package(scenario)

        self.assertEqual(first, second)

    def test_external_evidence_package_combines_grafana_and_loki_context(self) -> None:
        payload = json.loads(Path("fixtures/grafana/checkout-payment-timeout-webhook.json").read_text())
        normalized = normalize_grafana_payload(payload)
        logs = LokiClient.to_evidence(
            (
                LokiLogEntry("1781622420000000000", "payment timeout after 3000ms", {"service": "checkout-api"}),
            )
        )

        package = load_tools(Path("fixtures")).build_evidence_package_from_incident(
            normalized.scenario_name,
            normalized.incident,
            log_evidence=logs,
        )

        evidence = package.by_id()
        self.assertEqual(evidence["alert:0"].source_tier, SourceTier.CURRENT_SIGNAL)
        self.assertEqual(evidence["log:0"].source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertEqual(evidence["runbook:dependency-outage"].source_tier, SourceTier.GUIDANCE)
        self.assertEqual(evidence["service:checkout-api"].source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertNotIn("logs", package.missing_context)

    def test_external_bad_deploy_evidence_uses_deploy_fixture_when_webhook_has_no_recent_changes(self) -> None:
        payload = json.loads(Path("fixtures/grafana/bad-deploy-latency-webhook.json").read_text())
        normalized = normalize_grafana_payload(payload)

        package = load_tools(Path("fixtures")).build_evidence_package_from_incident(
            normalized.scenario_name,
            normalized.incident,
            log_evidence=LokiClient.to_evidence(
                (
                    LokiLogEntry(
                        "1781627400000000000",
                        "checkout-api p95 latency elevated after v2.19.0 traffic ramp",
                        {"service": "checkout-api"},
                    ),
                )
            ),
        )

        deploy = package.by_id()["deploy:0"]
        self.assertEqual(deploy.source, "deploy")
        self.assertEqual(deploy.source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertIn("checkout-api change at 2026-06-16T16:10:00Z", deploy.summary)
        self.assertIn("v2.19.0", deploy.detail)


if __name__ == "__main__":
    unittest.main()
