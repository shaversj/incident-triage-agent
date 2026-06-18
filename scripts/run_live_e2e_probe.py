from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from incident_triage_agent.config import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
COMPOSE_COMMAND = (
    "docker",
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.live.yml",
)
SCENARIOS = {
    "checkout-payment-timeout": {
        "fixture": "checkout-payment-timeout-webhook.json",
        "endpoint": "/checkout",
        "id_field": "checkout_id",
        "default_id": "demo-live-checkout-001",
        "log_label": "synthetic checkout logs",
    },
    "capacity-saturation": {
        "fixture": "capacity-saturation-webhook.json",
        "endpoint": "/capacity",
        "id_field": "incident_id",
        "default_id": "demo-live-capacity-001",
        "log_label": "synthetic capacity logs",
    },
    "bad-deploy-latency": {
        "fixture": "bad-deploy-latency-webhook.json",
        "endpoint": "/bad-deploy",
        "id_field": "incident_id",
        "default_id": "demo-live-bad-deploy-001",
        "log_label": "synthetic bad-deploy logs",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a local live E2E probe and print the LLM triage decision.",
    )
    parser.add_argument("--scenario", choices=tuple(SCENARIOS), default="checkout-payment-timeout")
    parser.add_argument("--checkout-id", default="demo-live-checkout-001")
    parser.add_argument("--incident-id", default=None)
    parser.add_argument("--no-build", action="store_true", help="Start Compose without rebuilding images.")
    parser.add_argument("--json", action="store_true", help="Print the sanitized response as JSON.")
    parser.add_argument("--verbose-compose", action="store_true", help="Show Docker Compose command output.")
    args = parser.parse_args()
    quiet_compose = not args.verbose_compose
    scenario = SCENARIOS[args.scenario]

    command = ("up", "-d")
    if not args.no_build:
        command = (*command, "--build")

    config = live_config()
    validate_live_config(config)

    try:
        emit("Starting live E2E stack...", json_mode=args.json)
        run_compose(*command, quiet=quiet_compose)
        wait_for_url("http://localhost:3100/ready")
        wait_for_url("http://localhost:8081/health")

        emit(f"Generating {scenario['log_label']}...", json_mode=args.json)
        incident_id = args.checkout_id if args.scenario == "checkout-payment-timeout" else args.incident_id
        service_response = generate_scenario_logs(scenario, incident_id)
        webhook_secret = config.get("GRAFANA_WEBHOOK_SECRET", "local-webhook-secret")
        emit("Posting Grafana webhook and waiting for MiniMax decision...", json_mode=args.json)
        response = post_grafana_payload(webhook_secret, scenario["fixture"])
        summary = sanitized_summary(response, service_response)

        if args.json:
            print(json.dumps(summary, indent=2, sort_keys=True))
        else:
            print_summary(summary)
        sys.stdout.flush()
        return 0
    finally:
        emit("Cleaning up live E2E stack...", json_mode=args.json)
        run_compose("down", "-v", check=False, quiet=quiet_compose)


def live_config() -> dict[str, str]:
    config = load_dotenv(PROJECT_ROOT / ".env")
    config.update(os.environ)
    return config


def validate_live_config(config: dict[str, str]) -> None:
    missing = [name for name in ("MINIMAX_API_KEY", "MODEL_NAME") if not config.get(name)]
    if missing:
        raise ValueError(f"Missing live MiniMax config: {', '.join(missing)}.")
    placeholders = [
        name
        for name in ("MINIMAX_API_KEY", "MODEL_NAME")
        if config[name].startswith("replace-with")
    ]
    if placeholders:
        raise ValueError(f"Live MiniMax config still has placeholder value(s): {', '.join(placeholders)}.")


def emit(message: str, *, json_mode: bool) -> None:
    print(message, file=sys.stderr if json_mode else sys.stdout, flush=True)


def run_compose(*args: str, check: bool = True, quiet: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [*COMPOSE_COMMAND, *args],
        cwd=PROJECT_ROOT,
        check=check,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.DEVNULL if quiet else None,
    )


def wait_for_url(url: str, timeout_seconds: int = 90) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                if response.status < 500:
                    return
        except URLError:
            time.sleep(1)
    raise TimeoutError(f"Timed out waiting for {url}")


def generate_scenario_logs(scenario: dict[str, str], incident_id: str | None) -> dict[str, Any]:
    body = json.dumps({scenario["id_field"]: incident_id or scenario["default_id"]}).encode("utf-8")
    request = Request(
        f"http://localhost:8081{scenario['endpoint']}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def post_grafana_payload(webhook_secret: str, fixture_name: str) -> dict[str, Any]:
    payload = json.loads((PROJECT_ROOT / "fixtures/grafana" / fixture_name).read_text())
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for alert in payload["alerts"]:
        alert["startsAt"] = now

    request = Request(
        "http://localhost:8080/webhooks/grafana",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Webhook-Secret": webhook_secret,
        },
        method="POST",
    )
    with urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def sanitized_summary(response: dict[str, Any], service_response: dict[str, Any]) -> dict[str, Any]:
    return {
        "checkout_response": service_response,
        "service_response": service_response,
        "incident": response.get("incident"),
        "validation": response.get("validation"),
        "decision": response.get("decision"),
        "provenance": response.get("provenance"),
        "safety": response.get("safety"),
        "scorecard": response.get("scorecard"),
    }


def print_summary(summary: dict[str, Any]) -> None:
    decision = summary.get("decision") or {}
    validation = summary.get("validation") or {}
    safety = summary.get("safety") or {}
    provenance = summary.get("provenance") or {}

    print("Live E2E probe complete")
    print(f"- validation: {'valid' if validation.get('valid') else 'invalid'}")
    print(f"- incident_class: {decision.get('incident_class', 'none')}")
    print(f"- next_action: {decision.get('next_action', 'none')}")
    print(f"- confidence: {decision.get('confidence', 'none')}")
    print(f"- evidence_ids: {', '.join(decision.get('evidence_ids') or []) or 'none'}")
    print(f"- cited_tiers: {', '.join(provenance.get('cited_tiers') or []) or 'none'}")
    print(f"- safety: {safety.get('status', 'none')}")
    print(f"- approval_required: {str(safety.get('approval_required', False)).lower()}")

    caveats = decision.get("caveats") or []
    if caveats:
        print("Caveats:")
        for caveat in caveats:
            print(f"- {caveat}")

    verification_plan = decision.get("verification_plan") or []
    if verification_plan:
        print("Verification plan:")
        for step in verification_plan:
            print(f"- {step}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(f"Live E2E probe failed: {error}", file=sys.stderr)
        raise SystemExit(1)
