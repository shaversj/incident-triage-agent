import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import SafetyStatus, load_scenario
from incident_triage_agent.llm import parse_decision_text
from incident_triage_agent.policy import evaluate_safety
from incident_triage_agent.tools import load_tools


class PolicyTests(unittest.TestCase):
    def test_bad_deploy_rollback_is_staged_for_approval(self) -> None:
        scenario = load_scenario(Path("fixtures"), "bad-deploy-latency")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)
        validation = parse_decision_text(
            json.dumps(
                {
                    "incident_class": "bad_deploy",
                    "next_action": "request_rollback_approval",
                    "confidence": 0.86,
                    "evidence_ids": ["deploy:0", "log:0", "runbook:bad-deploy"],
                    "caveats": [],
                    "verification_plan": ["Check latency after rollback."]
                }
            ),
            package,
        )
        assert validation.decision is not None

        safety = evaluate_safety(validation.decision, package)

        self.assertEqual(safety.status, SafetyStatus.APPROVAL_REQUIRED.value)
        self.assertTrue(safety.approval_required)
        self.assertIsNotNone(safety.staged_payload)
        self.assertFalse(safety.audit_event["executed"])

    def test_runbook_action_without_runbook_needs_human_input(self) -> None:
        scenario = load_scenario(Path("fixtures"), "noisy-alert")
        package = load_tools(Path("fixtures")).build_evidence_package(scenario)
        validation = parse_decision_text(
            json.dumps(
                {
                    "incident_class": "capacity_saturation",
                    "next_action": "apply_runbook_step_with_approval",
                    "confidence": 0.81,
                    "evidence_ids": ["alert:0", "log:0", "verification:0"],
                    "caveats": [],
                    "verification_plan": ["Check latency."]
                }
            ),
            package,
        )
        assert validation.decision is not None

        safety = evaluate_safety(validation.decision, package)

        self.assertEqual(safety.status, SafetyStatus.NEEDS_HUMAN_INPUT.value)
        self.assertIn("Runbook", safety.reason)


if __name__ == "__main__":
    unittest.main()
