from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .config import ConfigError, load_config
from .domain import FixtureError, Scenario, TriageRun, load_scenario, list_scenarios
from .llm import MiniMaxAnthropicClient, StaticLLMClient
from .tools import load_tools
from .workflow import TriageWorkflow


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage",
        description="Run bounded LLM-assisted incident triage scenarios.",
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("list", help="List available mock scenarios.")

    run_parser = subparsers.add_parser("run", help="Run a mock incident scenario.")
    run_parser.add_argument("scenario", help="Scenario name.")
    run_parser.add_argument("--trace", action="store_true", help="Show state and evidence trace.")
    run_parser.add_argument(
        "--mock-llm",
        action="store_true",
        help="Use deterministic fake LLM responses instead of MiniMax.",
    )
    run_parser.add_argument(
        "--fixtures-dir",
        default="fixtures",
        help="Path to fixture directory.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    if args.command == "list":
        for name in list_scenarios(Path("fixtures")):
            print(name)
        return 0

    if args.command == "run":
        fixtures_dir = Path(args.fixtures_dir)
        try:
            scenario = load_scenario(fixtures_dir, args.scenario)
            tools = load_tools(fixtures_dir)
        except FixtureError as error:
            print(f"Fixture error: {error}", file=sys.stderr)
            return 2

        if args.mock_llm:
            llm_client = StaticLLMClient({scenario.name: json.dumps(mock_decision_for(scenario))})
        else:
            try:
                config = load_config(Path(".env"))
            except ConfigError as error:
                print(f"Configuration error: {error}", file=sys.stderr)
                return 2
            llm_client = MiniMaxAnthropicClient(config)

        workflow = TriageWorkflow(tools=tools, llm_client=llm_client)
        run = workflow.run(scenario)
        render_run(run, trace=args.trace)
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 2


def mock_decision_for(scenario: Scenario) -> dict:
    evidence_by_scenario = {
        "checkout-payment-timeout": {
            "incident_class": "dependency_outage",
            "next_action": "escalate_owner",
            "confidence": 0.88,
            "evidence_ids": ["alert:1", "log:0", "runbook:dependency-outage"],
            "caveats": ["Recent checkout deploy is lower-confidence context than payment timeout evidence."],
            "verification_plan": ["Track payment-gateway timeout rate.", "Confirm checkout latency returns below SLO."]
        },
        "bad-deploy-latency": {
            "incident_class": "bad_deploy",
            "next_action": "request_rollback_approval",
            "confidence": 0.9,
            "evidence_ids": ["deploy:0", "log:0", "runbook:bad-deploy"],
            "caveats": ["Rollback requires human approval."],
            "verification_plan": ["Check checkout latency.", "Check error budget burn."]
        },
        "capacity-saturation": {
            "incident_class": "capacity_saturation",
            "next_action": "apply_runbook_step_with_approval",
            "confidence": 0.83,
            "evidence_ids": ["alert:0", "log:0", "runbook:capacity-saturation"],
            "caveats": ["Scaling or throttling action requires approval."],
            "verification_plan": ["Check CPU.", "Check queue depth.", "Check p95 latency."]
        },
        "noisy-alert": {
            "incident_class": "noisy_alert",
            "next_action": "continue_monitoring",
            "confidence": 0.78,
            "evidence_ids": ["alert:0", "log:1", "verification:0"],
            "caveats": ["No runbook was matched, but recovery signals are healthy."],
            "verification_plan": ["Continue monitoring latency and error rate."]
        },
    }
    return evidence_by_scenario.get(
        scenario.name,
        {
            "incident_class": "unknown",
            "next_action": "ask_human",
            "confidence": 0.7,
            "evidence_ids": [],
            "caveats": ["No canned mock decision exists for this scenario."],
            "verification_plan": []
        },
    )


def render_run(run: TriageRun, trace: bool) -> None:
    print(f"Incident: {run.scenario.incident.incident_id} - {run.scenario.incident.title}")
    print(f"Scenario: {run.scenario.name}")
    print(f"Service: {run.scenario.incident.service}")

    if trace:
        print("\nState trace:")
        for state in run.states:
            print(f"- {state.value}")

        if run.evidence_package:
            print("\nEvidence:")
            for item in run.evidence_package.evidence:
                print(f"- {item.evidence_id} [{item.source}] {item.summary}")
            if run.evidence_package.missing_context:
                print(f"- missing: {', '.join(run.evidence_package.missing_context)}")

    if run.validation and run.validation.decision:
        decision = run.validation.decision
        print("\nLLM decision:")
        print(f"- incident_class: {decision.incident_class.value}")
        print(f"- next_action: {decision.next_action.value}")
        print(f"- confidence: {decision.confidence:.2f}")
        print(f"- evidence_ids: {', '.join(decision.evidence_ids) or 'none'}")
        if decision.caveats:
            print(f"- caveats: {'; '.join(decision.caveats)}")
        if decision.verification_plan:
            print("- verification_plan:")
            for step in decision.verification_plan:
                print(f"  - {step}")
    elif run.validation:
        print("\nLLM decision: invalid")
        for error in run.validation.errors:
            print(f"- {error}")

    if run.safety:
        print("\nSafety gate:")
        print(f"- status: {run.safety.status}")
        print(f"- approval_required: {str(run.safety.approval_required).lower()}")
        print(f"- reason: {run.safety.reason}")
        if run.safety.staged_payload:
            print("- staged_payload:")
            for key, value in run.safety.staged_payload.items():
                print(f"  - {key}: {format_value(value)}")
        if run.safety.audit_event:
            print("- audit_event:")
            for key, value in run.safety.audit_event.items():
                print(f"  - {key}: {format_value(value)}")

    if run.scorecard:
        print("\nScorecard:")
        for name, passed in run.scorecard.scores.items():
            print(f"- {name}: {'pass' if passed else 'fail'}")
        for note in run.scorecard.notes:
            print(f"- note: {note}")


def format_value(value) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) or "none"
    return str(value)


if __name__ == "__main__":
    raise SystemExit(main())
