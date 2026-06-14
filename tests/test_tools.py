import unittest
from pathlib import Path

from incident_triage_agent.domain import load_scenario
from incident_triage_agent.tools import load_tools


class ToolsTests(unittest.TestCase):
    def test_service_lookup_returns_owner_and_escalation_context(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        service = package.by_id()["service:checkout-api"]

        self.assertEqual(service.source, "service")
        self.assertIn("Checkout Platform", service.summary)
        self.assertIn("checkout-platform-oncall", service.detail)

    def test_runbook_lookup_returns_guidance_without_answer_fields(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        runbook = package.by_id()["runbook:dependency-outage"]

        self.assertEqual(runbook.source, "runbook")
        self.assertIn("Dependency Outage Runbook", runbook.summary)
        self.assertNotIn("incident_class", runbook.detail)
        self.assertNotIn("next_action", runbook.detail)

    def test_prior_incident_lookup_returns_stable_evidence_id(self) -> None:
        scenario = load_scenario(Path("fixtures"), "bad-deploy-latency")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)

        prior = package.by_id()["prior:INC-2025-144"]

        self.assertEqual(prior.source, "prior_incident")
        self.assertIn("Retry rollout", prior.summary)

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


if __name__ == "__main__":
    unittest.main()
