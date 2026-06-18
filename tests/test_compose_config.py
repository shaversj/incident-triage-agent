import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


class ComposeConfigTests(unittest.TestCase):
    def test_base_compose_keeps_mock_llm_agent_path(self) -> None:
        config = self.compose_config("docker-compose.yml")

        agent = config["services"]["agent"]
        self.assertEqual(
            agent["command"],
            ["serve", "--host", "0.0.0.0", "--port", "8080", "--mock-llm"],
        )
        self.assertIn("synthetic-checkout", agent["depends_on"])
        self.assertEqual(
            config["services"]["synthetic-checkout"]["entrypoint"],
            ["python", "-m", "services.synthetic_checkout_service"],
        )

    def test_live_compose_override_removes_mock_llm_and_uses_runtime_provider_env(self) -> None:
        config = self.compose_config(
            "docker-compose.yml",
            "docker-compose.live.yml",
            env={
                "MINIMAX_API_KEY": "test-key",
                "MODEL_NAME": "test-model",
            },
        )

        agent = config["services"]["agent"]
        self.assertEqual(agent["command"], ["serve", "--host", "0.0.0.0", "--port", "8080"])
        self.assertEqual(agent["environment"]["MINIMAX_API_KEY"], "test-key")
        self.assertEqual(agent["environment"]["MODEL_NAME"], "test-model")
        self.assertEqual(agent["environment"]["MINIMAX_BASE_URL"], "https://api.minimax.io")

    def compose_config(self, *compose_files: str, env: dict[str, str] | None = None) -> dict:
        if not shutil.which("docker"):
            self.skipTest("docker is not installed")
        command = ["docker", "compose"]
        for compose_file in compose_files:
            command.extend(("-f", compose_file))
        command.extend(("config", "--format", "json"))
        result = subprocess.run(
            command,
            cwd=Path(__file__).resolve().parents[1],
            check=True,
            text=True,
            capture_output=True,
            env={**os.environ, **(env or {})},
        )
        return json.loads(result.stdout)


if __name__ == "__main__":
    unittest.main()
