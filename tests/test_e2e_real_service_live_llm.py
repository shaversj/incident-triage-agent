import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from datetime import datetime, timezone
import unittest
from urllib.error import URLError
from urllib.request import Request, urlopen

from incident_triage_agent.config import ConfigError, load_dotenv
from incident_triage_agent.domain import IncidentClass, NextAction, SourceTier
from tests.support.outcomes import assert_valid_response_outcome


RUN_LIVE_LLM_E2E = os.environ.get("RUN_LIVE_LLM_E2E") == "1"
LIVE_E2E_SCENARIOS_ENV = "LIVE_E2E_SCENARIOS"


SCENARIOS = {
    "checkout-payment-timeout": {
        "fixture": "checkout-payment-timeout-webhook.json",
        "endpoint": "/checkout",
        "request": {"checkout_id": "live-e2e-checkout-001"},
        "service": "checkout-api",
        "evidence_prefixes": ("alert:", "log:"),
    },
    "capacity-saturation": {
        "fixture": "capacity-saturation-webhook.json",
        "endpoint": "/capacity",
        "request": {"incident_id": "live-e2e-capacity-001"},
        "service": "search-api",
        "evidence_prefixes": ("alert:", "log:"),
    },
    "bad-deploy-latency": {
        "fixture": "bad-deploy-latency-webhook.json",
        "endpoint": "/bad-deploy",
        "request": {"incident_id": "live-e2e-bad-deploy-001"},
        "service": "checkout-api",
        "evidence_prefixes": ("alert:", "deploy:", "log:"),
    },
}


@unittest.skipUnless(RUN_LIVE_LLM_E2E, "set RUN_LIVE_LLM_E2E=1 to run live MiniMax Docker E2E")
class RealServiceLiveLLME2ETests(unittest.TestCase):
    def test_real_service_logs_and_live_llm_decision_reach_agent(self) -> None:
        if not shutil.which("docker"):
            self.skipTest("docker is not installed")
        live_config = self.live_config_or_skip()

        self.run_compose("up", "-d", "--build")
        try:
            self.wait_for_url("http://localhost:3100/ready")
            self.wait_for_url("http://localhost:8081/health")
            for name, scenario in self.selected_scenarios().items():
                with self.subTest(scenario=name):
                    self.generate_scenario_logs(scenario)
                    response = self.post_grafana_payload(
                        live_config["GRAFANA_WEBHOOK_SECRET"],
                        scenario["fixture"],
                    )

                    self.assertEqual(response["incident"]["service"], scenario["service"])
                    assert_valid_response_outcome(
                        self,
                        response,
                        evidence_prefixes=scenario["evidence_prefixes"],
                        available_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT),
                        cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT),
                        require_safety=True,
                    )
                    self.assertIn(response["decision"]["incident_class"], {item.value for item in IncidentClass})
                    self.assertIn(response["decision"]["next_action"], {item.value for item in NextAction})
        finally:
            self.run_compose("down", "-v")

    def selected_scenarios(self) -> dict[str, dict]:
        raw = os.environ.get(LIVE_E2E_SCENARIOS_ENV, "checkout-payment-timeout")
        requested = tuple(name.strip() for name in raw.split(",") if name.strip())
        if requested == ("all",):
            return dict(SCENARIOS)

        unknown = sorted(name for name in requested if name not in SCENARIOS)
        if unknown:
            self.skipTest(f"unknown live E2E scenario(s): {', '.join(unknown)}")
        return {name: SCENARIOS[name] for name in requested}

    def live_config_or_skip(self) -> dict[str, str]:
        try:
            config = load_dotenv(Path(".env"))
            config.update(os.environ)
        except ConfigError as error:
            self.skipTest(f"invalid .env: {error}")

        missing = [name for name in ("MINIMAX_API_KEY", "MODEL_NAME") if not config.get(name)]
        if missing:
            self.skipTest(f"missing live MiniMax config: {', '.join(missing)}")
        if config["MINIMAX_API_KEY"].startswith("replace-with"):
            self.skipTest("MINIMAX_API_KEY is still a placeholder")
        if config["MODEL_NAME"].startswith("replace-with"):
            self.skipTest("MODEL_NAME is still a placeholder")
        config.setdefault("GRAFANA_WEBHOOK_SECRET", "local-webhook-secret")
        return config

    def generate_scenario_logs(self, scenario: dict) -> dict:
        body = json.dumps(scenario["request"]).encode("utf-8")
        request = Request(
            f"http://localhost:8081{scenario['endpoint']}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["status"], "accepted")
        self.assertEqual(payload["service"], scenario["service"])
        self.assertGreaterEqual(payload["log_count"], 2)
        return payload

    def post_grafana_payload(self, webhook_secret: str, fixture_name: str) -> dict:
        payload = json.loads((Path("fixtures/grafana") / fixture_name).read_text())
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        for alert in payload["alerts"]:
            alert["startsAt"] = now
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            "http://localhost:8080/webhooks/grafana",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Webhook-Secret": webhook_secret,
            },
            method="POST",
        )
        with urlopen(request, timeout=90) as response:
            return json.loads(response.read().decode("utf-8"))

    def wait_for_url(self, url: str) -> None:
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                with urlopen(url, timeout=2) as response:
                    if response.status < 500:
                        return
            except URLError:
                time.sleep(1)
        self.fail(f"Timed out waiting for {url}")

    def run_compose(self, *args: str) -> None:
        subprocess.run(
            ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.live.yml", *args],
            check=True,
            cwd=Path(__file__).resolve().parents[1],
        )


if __name__ == "__main__":
    unittest.main()
