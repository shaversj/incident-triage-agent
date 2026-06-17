import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import IncidentClass, NextAction, SafetyStatus, SourceTier, WorkflowState, load_scenario
from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.tools import load_tools
from incident_triage_agent.workflow import TriageWorkflow
from tests.support.outcomes import assert_recoverable_run, assert_valid_run_outcome


class TriageOutcomeTests(unittest.TestCase):
    def test_checkout_payment_timeout_outcome_escalates_dependency_owner(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.88,
                "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
                "caveats": ["Checkout deploy is lower-confidence context."],
                "verification_plan": ["Watch payment-gateway timeout rate."],
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
            scorecard_checks=(
                "state_correctness",
                "evidence_grounding",
                "safety_behavior",
                "classification_quality",
                "next_action_quality",
                "evidence_quality",
            ),
        )

    def test_bad_deploy_outcome_requires_rollback_approval_without_execution(self) -> None:
        run = self.run_with_response(
            "bad-deploy-latency",
            {
                "incident_class": "bad_deploy",
                "next_action": "request_rollback_approval",
                "confidence": 0.9,
                "evidence_ids": ["deploy:0", "log:0", "runbook:bad-deploy"],
                "caveats": [],
                "verification_plan": ["Check checkout latency and error burn."],
            },
        )

        assert_valid_run_outcome(
            self,
            run,
            incident_class=IncidentClass.BAD_DEPLOY,
            next_action=NextAction.REQUEST_ROLLBACK_APPROVAL,
            evidence_prefixes=("deploy:", "log:", "runbook:"),
            cited_sources=("deploy", "log", "runbook"),
            cited_tiers=(SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
            safety_status=SafetyStatus.APPROVAL_REQUIRED,
            approval_required=True,
            scorecard_checks=("safety_behavior", "classification_quality", "next_action_quality"),
        )
        self.assertIn(WorkflowState.SIMULATED_ACTION_RECORDED, run.states)

    def test_capacity_saturation_outcome_stages_runbook_action_for_approval(self) -> None:
        run = self.run_with_response(
            "capacity-saturation",
            {
                "incident_class": "capacity_saturation",
                "next_action": "apply_runbook_step_with_approval",
                "confidence": 0.91,
                "evidence_ids": ["alert:0", "log:0", "runbook:capacity-saturation"],
                "caveats": ["Scaling or throttling requires oncall approval."],
                "verification_plan": ["Check CPU and queue depth after mitigation."],
            },
        )

        assert_valid_run_outcome(
            self,
            run,
            incident_class=IncidentClass.CAPACITY_SATURATION,
            next_action=NextAction.APPLY_RUNBOOK_STEP_WITH_APPROVAL,
            evidence_prefixes=("alert:", "log:", "runbook:"),
            cited_sources=("alert", "log", "runbook"),
            cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
            safety_status=SafetyStatus.APPROVAL_REQUIRED,
            approval_required=True,
            scorecard_checks=("safety_behavior", "classification_quality", "next_action_quality"),
        )

    def test_noisy_alert_outcome_continues_monitoring_without_mutation(self) -> None:
        run = self.run_with_response(
            "noisy-alert",
            {
                "incident_class": "noisy_alert",
                "next_action": "continue_monitoring",
                "confidence": 0.82,
                "evidence_ids": ["alert:0", "log:1", "verification:0"],
                "caveats": ["No runbook evidence was found, but signals recovered."],
                "verification_plan": ["Keep watching latency and error rate."],
            },
        )

        assert_valid_run_outcome(
            self,
            run,
            incident_class=IncidentClass.NOISY_ALERT,
            next_action=NextAction.CONTINUE_MONITORING,
            evidence_prefixes=("alert:", "log:", "verification:"),
            cited_sources=("alert", "log", "verification"),
            cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT),
            safety_status=SafetyStatus.SAFE_RECOMMENDATION,
            approval_required=False,
            scorecard_checks=("safety_behavior", "classification_quality", "next_action_quality"),
        )

    def test_malformed_provider_output_outcome_fails_recoverably(self) -> None:
        run = self.run_with_static_text("checkout-payment-timeout", "{not json")

        assert_recoverable_run(self, run, error_contains="not valid JSON")

    def test_unknown_evidence_id_outcome_fails_grounding_before_safety(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.88,
                "evidence_ids": ["prior_incident:0"],
                "caveats": [],
                "verification_plan": ["Watch payment-gateway timeout rate."],
            },
        )

        assert_recoverable_run(self, run, error_contains="unknown evidence IDs")

    def test_missing_critical_context_outcome_asks_for_human_input(self) -> None:
        run = self.run_with_response(
            "noisy-alert",
            {
                "incident_class": "capacity_saturation",
                "next_action": "apply_runbook_step_with_approval",
                "confidence": 0.8,
                "evidence_ids": ["alert:0", "log:0", "verification:0"],
                "caveats": ["No runbook evidence was found."],
                "verification_plan": ["Check latency."],
            },
        )

        assert_valid_run_outcome(
            self,
            run,
            incident_class=IncidentClass.CAPACITY_SATURATION,
            next_action=NextAction.APPLY_RUNBOOK_STEP_WITH_APPROVAL,
            evidence_prefixes=("alert:", "log:", "verification:"),
            cited_sources=("alert", "log", "verification"),
            safety_status=SafetyStatus.NEEDS_HUMAN_INPUT,
            approval_required=False,
        )
        self.assertIn(WorkflowState.HUMAN_INPUT_NEEDED, run.states)

    def test_historical_only_outcome_remains_visible_as_weak_evidence(self) -> None:
        run = self.run_with_response(
            "checkout-payment-timeout",
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.88,
                "evidence_ids": ["prior:INC-2025-102"],
                "caveats": ["Only historical evidence was cited."],
                "verification_plan": ["Watch payment-gateway timeout rate."],
            },
        )

        assert_valid_run_outcome(
            self,
            run,
            incident_class=IncidentClass.DEPENDENCY_OUTAGE,
            next_action=NextAction.ESCALATE_OWNER,
            evidence_prefixes=("prior:",),
            cited_sources=("prior_incident",),
            cited_tiers=(SourceTier.HISTORICAL_CONTEXT,),
            safety_status=SafetyStatus.SAFE_RECOMMENDATION,
            approval_required=False,
        )
        assert run.scorecard is not None
        self.assertFalse(run.scorecard.scores["evidence_quality"])

    def run_with_response(self, scenario_name: str, response: dict):
        return self.run_with_static_text(scenario_name, json.dumps(response))

    def run_with_static_text(self, scenario_name: str, text: str):
        scenario = load_scenario(Path("fixtures"), scenario_name)
        workflow = TriageWorkflow(
            tools=load_tools(Path("fixtures")),
            llm_client=StaticLLMClient({scenario_name: text}),
        )
        return workflow.run(scenario)


if __name__ == "__main__":
    unittest.main()
