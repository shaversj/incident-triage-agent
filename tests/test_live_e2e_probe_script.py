import importlib.util
import unittest
from pathlib import Path


def load_probe_module():
    module_path = Path("scripts/run_live_e2e_probe.py")
    spec = importlib.util.spec_from_file_location("run_live_e2e_probe", module_path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class LiveE2EProbeScriptTests(unittest.TestCase):
    def test_sanitized_summary_keeps_only_safe_operator_fields(self) -> None:
        probe = load_probe_module()

        response = {
            "incident": {"incident_id": "GRAFANA-checkout-latency-001"},
            "validation": {"valid": True, "errors": []},
            "decision": {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.92,
                "evidence_ids": ["alert:1", "log:0"],
            },
            "provenance": {"cited_tiers": ["current_signal", "operational_context"]},
            "safety": {"status": "safe_recommendation", "approval_required": False},
            "scorecard": {"scores": {"state_correctness": True}},
            "evidence": [{"detail": "raw evidence detail"}],
            "states": ["received"],
        }
        checkout_response = {"status": "accepted", "log_count": 3}

        summary = probe.sanitized_summary(response, checkout_response)

        self.assertEqual(summary["checkout_response"], checkout_response)
        self.assertEqual(summary["decision"]["incident_class"], "dependency_outage")
        self.assertNotIn("evidence", summary)
        self.assertNotIn("states", summary)

    def test_validate_live_config_rejects_missing_required_provider_values(self) -> None:
        probe = load_probe_module()

        with self.assertRaisesRegex(ValueError, "MINIMAX_API_KEY"):
            probe.validate_live_config({"MODEL_NAME": "MiniMax-M2.7"})

    def test_validate_live_config_rejects_placeholder_values_without_printing_secret(self) -> None:
        probe = load_probe_module()

        with self.assertRaisesRegex(ValueError, "placeholder"):
            probe.validate_live_config(
                {
                    "MINIMAX_API_KEY": "replace-with-your-minimax-api-key",
                    "MODEL_NAME": "MiniMax-M2.7",
                }
            )

    def test_validate_live_config_accepts_required_provider_values(self) -> None:
        probe = load_probe_module()

        probe.validate_live_config(
            {
                "MINIMAX_API_KEY": "test-key",
                "MODEL_NAME": "MiniMax-M2.7",
            }
        )


if __name__ == "__main__":
    unittest.main()
