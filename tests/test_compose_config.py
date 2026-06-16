import unittest
from pathlib import Path


class ComposeConfigTests(unittest.TestCase):
    def test_base_compose_keeps_mock_llm_agent_path(self) -> None:
        compose = Path("docker-compose.yml").read_text()

        self.assertIn('"--mock-llm"', compose)
        self.assertIn("synthetic-checkout", compose)
        self.assertIn('"python", "-m", "services.synthetic_checkout_service"', compose)

    def test_live_compose_override_removes_mock_llm_and_uses_runtime_provider_env(self) -> None:
        compose = Path("docker-compose.live.yml").read_text()

        self.assertNotIn("--mock-llm", compose)
        self.assertIn('MINIMAX_API_KEY: "${MINIMAX_API_KEY}"', compose)
        self.assertIn('MODEL_NAME: "${MODEL_NAME}"', compose)
        self.assertIn('MINIMAX_BASE_URL: "${MINIMAX_BASE_URL:-https://api.minimax.io}"', compose)


if __name__ == "__main__":
    unittest.main()
