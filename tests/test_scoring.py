import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import WorkflowState, load_scenario
from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.tools import load_tools
from incident_triage_agent.workflow import TriageWorkflow


class ScoringTests(unittest.TestCase):
    def test_dependency_outage_scores_success_for_escalation(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.88,
                "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
                "caveats": ["Checkout deploy is lower-confidence context."],
                "verification_plan": ["Watch payment-gateway timeout rate."]
            },
        )

        assert run.scorecard is not None
        self.assertTrue(all(run.scorecard.scores.values()))

    def test_bad_deploy_scores_approval_gated_path(self) -> None:
        run = self.run_with_response(
            "bad-deploy-latency",
            {
                "incident_class": "bad_deploy",
                "next_action": "request_rollback_approval",
                "confidence": 0.9,
                "evidence_ids": ["deploy:0", "log:0", "runbook:bad-deploy"],
                "caveats": [],
                "verification_plan": ["Check checkout latency and error burn."]
            },
        )

        assert run.scorecard is not None
        self.assertIn(WorkflowState.SIMULATED_ACTION_RECORDED, run.states)
        self.assertTrue(run.scorecard.scores["safety_behavior"])

    def test_scorecard_distinguishes_wrong_classification(self) -> None:
        run = self.run_with_response(
            "capacity-saturation",
            {
                "incident_class": "bad_deploy",
                "next_action": "request_rollback_approval",
                "confidence": 0.75,
                "evidence_ids": ["alert:0", "log:0", "runbook:capacity-saturation"],
                "caveats": [],
                "verification_plan": ["Check CPU."]
            },
        )

        assert run.scorecard is not None
        self.assertFalse(run.scorecard.scores["classification_quality"])

    def test_scorecard_notes_missing_required_evidence_prefixes(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.88,
                "evidence_ids": ["alert:1", "log:0"],
                "caveats": [],
                "verification_plan": ["Watch payment-gateway timeout rate."]
            },
        )

        assert run.scorecard is not None
        self.assertFalse(run.scorecard.scores["evidence_grounding"])
        self.assertIn("Missing required evidence prefixes: runbook:", run.scorecard.notes)

    def run_with_response(self, scenario_name: str, response: dict):
        scenario = load_scenario(Path("fixtures"), scenario_name)
        workflow = TriageWorkflow(
            tools=load_tools(Path("fixtures")),
            llm_client=StaticLLMClient({scenario_name: json.dumps(response)}),
        )
        return workflow.run(scenario)


if __name__ == "__main__":
    unittest.main()
