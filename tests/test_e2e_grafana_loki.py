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


SCENARIOS = (
    {
        "name": "checkout-payment-timeout",
        "fixture": "checkout-payment-timeout-webhook.json",
        "endpoint": "/checkout",
        "request": {"checkout_id": "e2e-checkout-001"},
        "service": "checkout-api",
        "incident_class": IncidentClass.DEPENDENCY_OUTAGE,
        "next_action": NextAction.ESCALATE_OWNER,
        "evidence_prefixes": ("alert:", "log:", "runbook:"),
        "cited_sources": ("alert", "log", "runbook"),
        "safety_status": SafetyStatus.SAFE_RECOMMENDATION,
        "approval_required": False,
    },
    {
        "name": "capacity-saturation",
        "fixture": "capacity-saturation-webhook.json",
        "endpoint": "/capacity",
        "request": {"incident_id": "e2e-capacity-001"},
        "service": "search-api",
        "incident_class": IncidentClass.CAPACITY_SATURATION,
        "next_action": NextAction.APPLY_RUNBOOK_STEP_WITH_APPROVAL,
        "evidence_prefixes": ("alert:", "log:", "runbook:"),
        "cited_sources": ("alert", "log", "runbook"),
        "safety_status": SafetyStatus.APPROVAL_REQUIRED,
        "approval_required": True,
    },
    {
        "name": "bad-deploy-latency",
        "fixture": "bad-deploy-latency-webhook.json",
        "endpoint": "/bad-deploy",
        "request": {"incident_id": "e2e-bad-deploy-001"},
        "service": "checkout-api",
        "incident_class": IncidentClass.BAD_DEPLOY,
        "next_action": NextAction.REQUEST_ROLLBACK_APPROVAL,
        "evidence_prefixes": ("alert:", "deploy:", "log:", "runbook:"),
        "cited_sources": ("alert", "deploy", "log", "runbook"),
        "safety_status": SafetyStatus.APPROVAL_REQUIRED,
        "approval_required": True,
    },
)


@unittest.skipUnless(RUN_DOCKER_E2E, "set RUN_DOCKER_E2E=1 to run Docker Grafana/Loki E2E")
class GrafanaLokiDockerE2ETests(unittest.TestCase):
    def test_grafana_payloads_and_loki_logs_reach_agent_for_scenario_matrix(self) -> None:
        if not shutil.which("docker"):
            self.skipTest("docker is not installed")

        self.run_compose("up", "-d", "--build")
        try:
            self.wait_for_url("http://localhost:3100/ready")
            self.wait_for_url("http://localhost:8081/health")
            for scenario in SCENARIOS:
                with self.subTest(scenario=scenario["name"]):
                    self.generate_scenario_logs(scenario)
                    response = self.post_grafana_payload(scenario["fixture"])

                    self.assertEqual(response["incident"]["service"], scenario["service"])
                    assert_valid_response_outcome(
                        self,
                        response,
                        incident_class=scenario["incident_class"],
                        next_action=scenario["next_action"],
                        evidence_prefixes=scenario["evidence_prefixes"],
                        cited_sources=scenario["cited_sources"],
                        available_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
                        cited_tiers=(SourceTier.CURRENT_SIGNAL, SourceTier.OPERATIONAL_CONTEXT, SourceTier.GUIDANCE),
                        safety_status=scenario["safety_status"],
                        approval_required=scenario["approval_required"],
                    )
        finally:
            self.run_compose("down", "-v")

    def post_grafana_payload(self, fixture_name: str) -> dict:
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
                "X-Webhook-Secret": "local-webhook-secret",
            },
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

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
