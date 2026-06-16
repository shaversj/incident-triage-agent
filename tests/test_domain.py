import json
import tempfile
import unittest
from pathlib import Path

from incident_triage_agent.domain import (
    Evidence,
    EvidencePackage,
    FixtureError,
    IncidentClass,
    NextAction,
    SourceTier,
    list_scenarios,
    load_scenario,
)


class DomainTests(unittest.TestCase):
    def test_load_scenario_parses_raw_fixture_and_expected_metadata(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")

        self.assertEqual(scenario.incident.incident_id, "INC-2026-014")
        self.assertEqual(scenario.expected.incident_class, IncidentClass.DEPENDENCY_OUTAGE)
        self.assertIn(NextAction.ESCALATE_OWNER, scenario.expected.allowed_next_actions)

    def test_fixture_with_prohibited_answer_fields_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixtures = Path(tmpdir)
            scenarios = fixtures / "scenarios"
            scenarios.mkdir()
            payload = {
                "incident": {
                    "incident_id": "INC-test",
                    "title": "Bad fixture",
                    "severity": "SEV4",
                    "status": "active",
                    "started_at": "2026-06-14T00:00:00Z",
                    "service": "checkout-api",
                    "symptoms": [],
                    "alerts": [],
                    "suspected_causes": ["answer leak"]
                },
                "expected": {
                    "incident_class": "unknown",
                    "allowed_next_actions": ["ask_human"]
                }
            }
            (scenarios / "bad.json").write_text(json.dumps(payload))

            with self.assertRaisesRegex(FixtureError, "prohibited answer fields"):
                load_scenario(fixtures, "bad")

    def test_list_scenarios_returns_fixture_names(self) -> None:
        names = list_scenarios(Path("fixtures"))

        self.assertIn("checkout-payment-timeout", names)
        self.assertIn("bad-deploy-latency", names)
        self.assertIn("capacity-saturation", names)
        self.assertIn("noisy-alert", names)

    def test_taxonomy_rejects_unknown_values(self) -> None:
        with self.assertRaises(ValueError):
            IncidentClass("mystery")

        with self.assertRaises(ValueError):
            NextAction("do_anything")

    def test_source_tier_values_are_stable_strings(self) -> None:
        self.assertEqual(SourceTier.CURRENT_SIGNAL.value, "current_signal")
        self.assertEqual(SourceTier.OPERATIONAL_CONTEXT.value, "operational_context")
        self.assertEqual(SourceTier.GUIDANCE.value, "guidance")
        self.assertEqual(SourceTier.HISTORICAL_CONTEXT.value, "historical_context")

    def test_evidence_preserves_source_tier(self) -> None:
        evidence = Evidence("alert:0", "alert", SourceTier.CURRENT_SIGNAL, "High latency")

        self.assertEqual(evidence.source_tier, SourceTier.CURRENT_SIGNAL)

    def test_provenance_summary_reports_available_and_cited_tiers(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        package = EvidencePackage(
            scenario_name=scenario.name,
            incident=scenario.incident,
            evidence=(
                Evidence("alert:0", "alert", SourceTier.CURRENT_SIGNAL, "High latency"),
                Evidence("prior:INC-1", "prior_incident", SourceTier.HISTORICAL_CONTEXT, "Similar issue"),
            ),
            missing_context=("runbook",),
        )

        summary = package.provenance_summary(("prior:INC-1",))

        self.assertEqual(
            summary.available_tiers,
            (SourceTier.CURRENT_SIGNAL, SourceTier.HISTORICAL_CONTEXT),
        )
        self.assertEqual(summary.cited_tiers, (SourceTier.HISTORICAL_CONTEXT,))
        self.assertEqual(summary.cited_sources, ("prior_incident",))
        self.assertEqual(summary.missing_context, ("runbook",))
        self.assertTrue(summary.historical_only)
        self.assertFalse(summary.has_current_or_operational_support)


if __name__ == "__main__":
    unittest.main()
