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
from incident_triage_agent.domain import IncidentClass, NextAction


RUN_LIVE_LLM_E2E = os.environ.get("RUN_LIVE_LLM_E2E") == "1"


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
            self.generate_checkout_incident()

            response = self.post_grafana_payload(live_config["GRAFANA_WEBHOOK_SECRET"])

            self.assertEqual(response["status"], "ok")
            self.assertTrue(response["validation"]["valid"], response["validation"].get("errors"))
            self.assertIn(response["decision"]["incident_class"], {item.value for item in IncidentClass})
            self.assertIn(response["decision"]["next_action"], {item.value for item in NextAction})
            self.assertTrue(
                any(evidence_id.startswith("alert:") for evidence_id in response["decision"]["evidence_ids"]),
                response["decision"]["evidence_ids"],
            )
            self.assertTrue(
                any(evidence_id.startswith("log:") for evidence_id in response["decision"]["evidence_ids"]),
                response["decision"]["evidence_ids"],
            )
            self.assertIn("current_signal", response["provenance"]["available_tiers"])
            self.assertIn("operational_context", response["provenance"]["available_tiers"])
            audit_event = response["safety"].get("audit_event") or {}
            self.assertNotEqual(audit_event.get("executed"), True)
        finally:
            self.run_compose("down", "-v")

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

    def generate_checkout_incident(self) -> dict:
        body = json.dumps({"checkout_id": "live-e2e-checkout-001"}).encode("utf-8")
        request = Request(
            "http://localhost:8081/checkout",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["status"], "accepted")
        self.assertEqual(payload["service"], "checkout-api")
        self.assertGreaterEqual(payload["log_count"], 2)
        return payload

    def post_grafana_payload(self, webhook_secret: str) -> dict:
        payload = json.loads(Path("fixtures/grafana/checkout-payment-timeout-webhook.json").read_text())
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
