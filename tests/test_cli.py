from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import os
from pathlib import Path
import tempfile
import unittest

from incident_triage_agent.cli import main, render_run
from incident_triage_agent.domain import load_scenario
from incident_triage_agent.llm import StaticLLMClient
from incident_triage_agent.tools import load_tools
from incident_triage_agent.workflow import TriageWorkflow


FIXTURES_DIR = str(Path(__file__).resolve().parents[1] / "fixtures")


class CliTests(unittest.TestCase):
    def run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        stdout = StringIO()
        stderr = StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_help_does_not_require_credentials(self) -> None:
        with self.assertRaises(SystemExit) as exc:
            self.run_cli(["--help"])

        self.assertEqual(exc.exception.code, 0)

    def test_cli_list_does_not_require_credentials(self) -> None:
        code, output, _ = self.run_cli(["list"])

        self.assertEqual(code, 0)
        self.assertIn("checkout-payment-timeout", output)

    def test_cli_run_requires_credentials_without_mock_llm(self) -> None:
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chdir(tmpdir)
            try:
                code, _, error = self.run_cli([
                    "run",
                    "checkout-payment-timeout",
                    "--fixtures-dir",
                    FIXTURES_DIR,
                ])
            finally:
                os.chdir(original_cwd)

        self.assertEqual(code, 2)
        self.assertIn("Configuration error", error)
        self.assertIn("MINIMAX_API_KEY", error)

    def test_cli_run_allows_mock_llm_without_credentials(self) -> None:
        code, output, _ = self.run_cli(["run", "checkout-payment-timeout", "--mock-llm"])

        self.assertEqual(code, 0)
        self.assertIn("checkout-payment-timeout", output)
        self.assertIn("LLM decision", output)
        self.assertIn("Provenance", output)
        self.assertIn("current_or_operational", output)

    def test_cli_trace_includes_state_evidence_and_scorecard(self) -> None:
        code, output, _ = self.run_cli(["run", "bad-deploy-latency", "--mock-llm", "--trace"])

        self.assertEqual(code, 0)
        self.assertIn("State trace", output)
        self.assertIn("deploy:0", output)
        self.assertIn("[deploy/operational_context]", output)
        self.assertIn("Safety gate", output)
        self.assertIn("Scorecard", output)
        self.assertNotIn("MINIMAX_API_KEY", output)

    def test_cli_invalid_decision_still_renders_provenance(self) -> None:
        scenario = load_scenario(Path("fixtures"), "checkout-payment-timeout")
        workflow = TriageWorkflow(
            tools=load_tools(Path("fixtures")),
            llm_client=StaticLLMClient({"checkout-payment-timeout": "{not json"}),
        )
        run = workflow.run(scenario)
        stdout = StringIO()

        with redirect_stdout(stdout):
            render_run(run, trace=False)

        output = stdout.getvalue()
        self.assertIn("LLM decision: invalid", output)
        self.assertIn("Provenance", output)
        self.assertIn("available_tiers: current_signal, operational_context, guidance, historical_context", output)
        self.assertIn("cited_tiers: none", output)

    def test_cli_debug_logs_include_detailed_steps(self) -> None:
        code, _, error = self.run_cli([
            "--log-level",
            "DEBUG",
            "run",
            "checkout-payment-timeout",
            "--mock-llm",
        ])

        self.assertEqual(code, 0)
        self.assertIn("Starting triage run", error)
        self.assertIn("State transition: received", error)
        self.assertIn("Scorecard complete", error)

    def test_cli_default_logs_high_level_steps(self) -> None:
        code, _, error = self.run_cli(["run", "checkout-payment-timeout", "--mock-llm"])

        self.assertEqual(code, 0)
        self.assertIn("Starting triage run", error)
        self.assertIn("Evidence package ready", error)
        self.assertIn("Scorecard complete", error)
        self.assertNotIn("State transition: received", error)
        self.assertNotIn("Collected 2 alerts", error)

    def test_cli_warning_log_level_suppresses_info_logs(self) -> None:
        code, _, error = self.run_cli([
            "--log-level",
            "WARNING",
            "run",
            "checkout-payment-timeout",
            "--mock-llm",
        ])

        self.assertEqual(code, 0)
        self.assertNotIn("Starting triage run", error)

    def test_cli_serve_requires_webhook_secret(self) -> None:
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chdir(tmpdir)
            try:
                code, _, error = self.run_cli([
                    "serve",
                    "--mock-llm",
                    "--fixtures-dir",
                    FIXTURES_DIR,
                ])
            finally:
                os.chdir(original_cwd)

        self.assertEqual(code, 2)
        self.assertIn("GRAFANA_WEBHOOK_SECRET", error)


if __name__ == "__main__":
    unittest.main()
