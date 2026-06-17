import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import IncidentClass, NextAction, SafetyStatus, SourceTier, load_scenario
from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.loki import LokiClient, LokiLogEntry
from incident_triage_agent.server import WebhookRuntime, handle_grafana_webhook
from incident_triage_agent.tools import load_tools
from incident_triage_agent.workflow import TriageWorkflow
from tests.support.outcomes import (
    assert_recoverable_response,
    assert_recoverable_run,
    assert_valid_response_outcome,
    assert_valid_run_outcome,
)


class OutcomeHelperTests(unittest.TestCase):
    def test_valid_run_helper_accepts_expected_outcome(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.86,
                "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
                "caveats": [],
                "verification_plan": ["Watch payment timeout rate."],
            },
        )

        assert_valid_run_outcome(
            self,
            run,
            incident_class=IncidentClass.DEPENDENCY_OUTAGE,
            next_action=NextAction.ESCALATE_OWNER,
            evidence_prefixes=("alert:", "log:", "runbook:"),
            cited_sources=("alert", "log", "runbook"),
            cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
            safety_status=SafetyStatus.SAFE_RECOMMENDATION,
            approval_required=False,
            scorecard_checks=("state_correctness", "evidence_grounding"),
        )

    def test_valid_response_helper_accepts_expected_outcome(self) -> None:
        status, response = handle_grafana_webhook(
            self.load_payload(),
            "test-secret",
            self.runtime(),
        )

        self.assertEqual(status, 200)
        assert_valid_response_outcome(
            self,
            response,
            incident_class="dependency_outage",
            next_action="escalate_owner",
            evidence_prefixes=("alert:", "log:", "runbook:"),
            cited_sources=("alert", "log", "runbook"),
            available_tiers=("current_signal", "operational_context", "guidance"),
            cited_tiers=("current_signal", "operational_context", "guidance"),
            safety_status="safe_recommendation",
            approval_required=False,
            scorecard_checks=("state_correctness", "evidence_grounding"),
        )

    def test_valid_run_helper_reports_expected_contract_failure(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.86,
                "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
                "caveats": [],
                "verification_plan": ["Watch payment timeout rate."],
            },
        )

        with self.assertRaisesRegex(AssertionError, "expected incident_class='bad_deploy'"):
            assert_valid_run_outcome(self, run, incident_class=IncidentClass.BAD_DEPLOY)

    def test_recoverable_helpers_accept_invalid_provider_output(self) -> None:
        run = self.run_with_static_text("checkout-payment-timeout", "{not json")
        assert_recoverable_run(self, run, error_contains="not valid JSON")

        _, response = handle_grafana_webhook(
            self.load_payload(),
            "test-secret",
            self.runtime(llm_client=StaticLLMClient({"grafana-checkout-api": "{not json"})),
        )
        assert_recoverable_response(self, response, error_contains="not valid JSON")

    def run_with_response(self, scenario_name: str, response: dict):
        return self.run_with_static_text(scenario_name, json.dumps(response))

    def run_with_static_text(self, scenario_name: str, text: str):
        scenario = load_scenario(Path("fixtures"), scenario_name)
        workflow = TriageWorkflow(
            tools=load_tools(Path("fixtures")),
            llm_client=StaticLLMClient({scenario_name: text}),
        )
        return workflow.run(scenario)

    def runtime(self, llm_client=None) -> WebhookRuntime:
        scenario_name = "grafana-checkout-api"
        llm = llm_client or StaticLLMClient(
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
            loki_client=FakeLokiClient(),
        )

    def load_payload(self) -> dict:
        return json.loads(Path("fixtures/grafana/checkout-payment-timeout-webhook.json").read_text())


class FakeLokiClient:
    def query_range(self, *_args, **_kwargs):
        return (
            LokiLogEntry("1781622420000000000", "payment timeout after 3000ms", {"service": "checkout-api"}),
        )

    def to_evidence(self, entries):
        return LokiClient.to_evidence(entries)


if __name__ == "__main__":
    unittest.main()
