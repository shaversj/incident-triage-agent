import tempfile
import unittest
from pathlib import Path

from incident_triage_agent.config import ConfigError, load_config, load_dotenv, redact_secret


class ConfigTests(unittest.TestCase):
    def test_load_config_reads_required_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text("MINIMAX_API_KEY=secret-key\nMODEL_NAME=MiniMax-M2.7\n")

            config = load_config(env_file, environ={})

        self.assertEqual(config.minimax_api_key, "secret-key")
        self.assertEqual(config.model_name, "MiniMax-M2.7")

    def test_load_config_reports_missing_names_without_secret_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text("MINIMAX_API_KEY=secret-key\n")

            with self.assertRaises(ConfigError) as exc:
                load_config(env_file, environ={})

        message = str(exc.exception)
        self.assertIn("MODEL_NAME", message)
        self.assertNotIn("secret-key", message)

    def test_load_dotenv_rejects_malformed_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text("MINIMAX_API_KEY\n")

            with self.assertRaisesRegex(ConfigError, "Invalid .env line 1"):
                load_dotenv(env_file)

    def test_redact_secret_replaces_configured_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text("MINIMAX_API_KEY=secret-key\nMODEL_NAME=MiniMax-M2.7\n")
            config = load_config(env_file, environ={})

        self.assertEqual(redact_secret("failed with secret-key", config), "failed with <redacted>")


if __name__ == "__main__":
    unittest.main()
