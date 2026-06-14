import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import WorkflowState, load_scenario
from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.tools import load_tools
from incident_triage_agent.workflow import TriageWorkflow


class WorkflowTests(unittest.TestCase):
    def test_valid_dependency_scenario_reaches_verification_ready(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.84,
                "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
                "caveats": [],
                "verification_plan": ["Monitor timeout rate."]
            },
        )

        self.assertIn(WorkflowState.VERIFICATION_READY, run.states)
        self.assertIn(WorkflowState.SCORED, run.states)

    def test_invalid_llm_output_reaches_recoverable_failure_and_scorecard(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        workflow = TriageWorkflow(
            tools=load_tools(Path("fixtures")),
            llm_client=StaticLLMClient({"checkout-payment-timeout": "{not json"}),
        )

        run = workflow.run(scenario)

        self.assertIn(WorkflowState.RECOVERABLE_FAILURE, run.states)
        self.assertIn(WorkflowState.SCORED, run.states)
        self.assertIsNotNone(run.scorecard)

    def test_missing_critical_context_moves_to_human_input(self) -> None:
        run = self.run_with_response(
            "noisy-alert",
            {
                "incident_class": "capacity_saturation",
                "next_action": "apply_runbook_step_with_approval",
                "confidence": 0.8,
                "evidence_ids": ["alert:0", "log:0", "verification:0"],
                "caveats": ["No runbook evidence was found."],
                "verification_plan": ["Check latency."]
            },
        )

        self.assertIn(WorkflowState.HUMAN_INPUT_NEEDED, run.states)

    def run_with_response(self, scenario_name: str, response: dict):
        scenario = load_scenario(Path("fixtures"), scenario_name)
        workflow = TriageWorkflow(
            tools=load_tools(Path("fixtures")),
            llm_client=StaticLLMClient({scenario_name: json.dumps(response)}),
        )
        return workflow.run(scenario)


if __name__ == "__main__":
    unittest.main()
