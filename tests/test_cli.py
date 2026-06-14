from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import os
from pathlib import Path
import tempfile
import unittest

from incident_triage_agent.cli import main


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

    def test_cli_trace_includes_state_evidence_and_scorecard(self) -> None:
        code, output, _ = self.run_cli(["run", "bad-deploy-latency", "--mock-llm", "--trace"])

        self.assertEqual(code, 0)
        self.assertIn("State trace", output)
        self.assertIn("deploy:0", output)
        self.assertIn("Safety gate", output)
        self.assertIn("Scorecard", output)
        self.assertNotIn("MINIMAX_API_KEY", output)


if __name__ == "__main__":
    unittest.main()
