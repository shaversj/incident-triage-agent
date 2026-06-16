import json
import unittest
from pathlib import Path

from incident_triage_agent.domain import IncidentClass, NextAction, load_scenario
from incident_triage_agent.llm import (
    MiniMaxAnthropicClient,
    ProviderFailure,
    extract_text_from_anthropic_response,
    parse_decision_text,
)
from incident_triage_agent.config import AppConfig
from incident_triage_agent.tools import load_tools


class LLMTests(unittest.TestCase):
    def evidence_package(self):
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        return load_tools(Path("fixtures")).build_evidence_package(scenario)

    def test_valid_mocked_response_parses_into_decision(self) -> None:
        package = self.evidence_package()
        text = json.dumps(
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.82,
                "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
                "caveats": ["Checkout deploy should still be watched."],
                "verification_plan": ["Track payment-gateway timeout rate."]
            }
        )

        result = parse_decision_text(text, package)

        self.assertTrue(result.valid)
        self.assertIsNotNone(result.decision)
        assert result.decision is not None
        self.assertEqual(result.decision.incident_class, IncidentClass.DEPENDENCY_OUTAGE)
        self.assertEqual(result.decision.next_action, NextAction.ESCALATE_OWNER)

    def test_malformed_json_is_recoverable_validation_failure(self) -> None:
        result = parse_decision_text("{not json", self.evidence_package())

        self.assertFalse(result.valid)
        self.assertIn("not valid JSON", result.errors[0])

    def test_unknown_taxonomy_values_are_rejected(self) -> None:
        text = json.dumps(
            {
                "incident_class": "mystery",
                "next_action": "escalate_owner",
                "confidence": 0.9,
                "evidence_ids": [],
                "caveats": [],
                "verification_plan": []
            }
        )

        result = parse_decision_text(text, self.evidence_package())

        self.assertFalse(result.valid)
        self.assertIn("incident_class", result.errors[0])

    def test_low_confidence_is_recoverable_validation_failure(self) -> None:
        text = json.dumps(
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.25,
                "evidence_ids": ["alert:1"],
                "caveats": [],
                "verification_plan": []
            }
        )

        result = parse_decision_text(text, self.evidence_package())

        self.assertFalse(result.valid)
        self.assertIn("confidence", result.errors[0])

    def test_string_caveats_and_verification_plan_are_normalized(self) -> None:
        text = json.dumps(
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.9,
                "evidence_ids": ["alert:1"],
                "caveats": "Single caveat.",
                "verification_plan": "Single verification step."
            }
        )

        result = parse_decision_text(text, self.evidence_package())

        self.assertTrue(result.valid)
        assert result.decision is not None
        self.assertEqual(result.decision.caveats, ("Single caveat.",))
        self.assertEqual(result.decision.verification_plan, ("Single verification step.",))

    def test_unknown_evidence_ids_are_rejected(self) -> None:
        text = json.dumps(
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.9,
                "evidence_ids": ["log:missing"],
                "caveats": [],
                "verification_plan": []
            }
        )

        result = parse_decision_text(text, self.evidence_package())

        self.assertFalse(result.valid)
        self.assertIn("unknown evidence IDs", result.errors[0])

    def test_anthropic_response_extracts_text_blocks_only(self) -> None:
        payload = {
            "content": [
                {"type": "thinking", "thinking": "private reasoning"},
                {"type": "text", "text": "{\"incident_class\":\"unknown\"}"}
            ]
        }

        self.assertEqual(extract_text_from_anthropic_response(payload), "{\"incident_class\":\"unknown\"}")

    def test_anthropic_response_without_text_is_rejected(self) -> None:
        with self.assertRaisesRegex(Exception, "usable text"):
            extract_text_from_anthropic_response({"content": [{"type": "thinking", "thinking": "x"}]})

    def test_prompt_guides_model_to_cite_runbook_when_present(self) -> None:
        from incident_triage_agent.llm import build_decision_prompt

        prompt = build_decision_prompt(self.evidence_package())

        self.assertIn("runbook evidence", prompt)
        self.assertIn("runbook:dependency-outage", prompt)

    def test_prompt_includes_mission_and_scope_boundary(self) -> None:
        from incident_triage_agent.llm import build_decision_prompt

        prompt = build_decision_prompt(self.evidence_package())

        self.assertIn("You are an incident triage decision agent.", prompt)
        self.assertIn("using only the supplied evidence package", prompt)
        self.assertIn("You are not an incident commander.", prompt)
        self.assertIn("You do not execute production changes.", prompt)
        self.assertIn("You do not invent missing evidence.", prompt)

    def test_prompt_includes_exact_allowed_evidence_id_contract(self) -> None:
        from incident_triage_agent.llm import build_decision_prompt

        prompt = build_decision_prompt(self.evidence_package())

        self.assertIn("Allowed evidence_ids:", prompt)
        self.assertIn("- prior:INC-2025-102", prompt)
        self.assertIn("Copy evidence IDs exactly as written.", prompt)
        self.assertIn("Do not invent, shorten, rename, reformat, or convert evidence IDs.", prompt)
        self.assertIn("appears exactly in Allowed evidence_ids", prompt)

    def test_provider_failure_returns_recoverable_validation_result(self) -> None:
        class FailingClient(MiniMaxAnthropicClient):
            def _post_messages(self, payload):
                raise ProviderFailure("provider unavailable")

        client = FailingClient(AppConfig(minimax_api_key="secret", model_name="test-model"))
        result = client.decide(self.evidence_package())

        self.assertFalse(result.valid)
        self.assertIn("provider unavailable", result.errors[0])


if __name__ == "__main__":
    unittest.main()
