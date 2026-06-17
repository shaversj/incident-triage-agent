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

from incident_triage_agent.domain import IncidentClass, NextAction, SafetyStatus, SourceTier
from tests.support.outcomes import assert_valid_response_outcome


RUN_DOCKER_E2E = os.environ.get("RUN_DOCKER_E2E") == "1"


@unittest.skipUnless(RUN_DOCKER_E2E, "set RUN_DOCKER_E2E=1 to run Docker Grafana/Loki E2E")
class GrafanaLokiDockerE2ETests(unittest.TestCase):
    def test_grafana_payload_and_loki_logs_reach_agent(self) -> None:
        if not shutil.which("docker"):
            self.skipTest("docker is not installed")

        self.run_compose("up", "-d", "--build")
        try:
            self.wait_for_url("http://localhost:3100/ready")
            self.wait_for_url("http://localhost:8081/health")
            self.generate_checkout_incident()
            response = self.post_grafana_payload()

            self.assertEqual(response["incident"]["service"], "checkout-api")
            assert_valid_response_outcome(
                self,
                response,
                incident_class=IncidentClass.DEPENDENCY_OUTAGE,
                next_action=NextAction.ESCALATE_OWNER,
                evidence_prefixes=("alert:", "log:", "runbook:"),
                cited_sources=("alert", "log", "runbook"),
                available_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
                cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
                safety_status=SafetyStatus.SAFE_RECOMMENDATION,
                approval_required=False,
            )
        finally:
            self.run_compose("down", "-v")

    def post_grafana_payload(self) -> dict:
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
                "X-Webhook-Secret": "local-webhook-secret",
            },
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

    def generate_checkout_incident(self) -> dict:
        body = json.dumps({"checkout_id": "e2e-checkout-001"}).encode("utf-8")
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

    def wait_for_url(self, url: str) -> None:
        deadline = time.time() + 60
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
            ["docker", "compose", *args],
            check=True,
            cwd=Path(__file__).resolve().parents[1],
        )


if __name__ == "__main__":
    unittest.main()
