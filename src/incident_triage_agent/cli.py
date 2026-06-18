from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from loguru import logger

from .config import ConfigError, load_config, load_webhook_config
from .domain import FixtureError, Scenario, TriageRun, load_scenario, list_scenarios
from .llm import MiniMaxAnthropicClient, StaticLLMClient
from .loki import LokiClient
from .observability import configure_logging
from .server import WebhookRuntime, serve
from .tools import load_tools
from .workflow import TriageWorkflow


LOG_LEVELS = ("TRACE", "DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage",
        description="Run bounded LLM-assisted incident triage scenarios.",
    )
    parser.add_argument(
        "--log-level",
        choices=LOG_LEVELS,
        default="INFO",
        help="Log level for step-by-step diagnostic logs emitted to stderr.",
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

    serve_parser = subparsers.add_parser("serve", help="Run the Grafana webhook server.")
    serve_parser.add_argument("--host", default="0.0.0.0", help="Host for the webhook server.")
    serve_parser.add_argument("--port", type=int, default=8080, help="Port for the webhook server.")
    serve_parser.add_argument(
        "--fixtures-dir",
        default="fixtures",
        help="Path to fixture directory.",
    )
    serve_parser.add_argument(
        "--mock-llm",
        action="store_true",
        help="Use deterministic fake LLM responses instead of MiniMax.",
    )
    serve_parser.add_argument(
        "--no-loki",
        action="store_true",
        help="Skip Loki lookup and mark logs as missing context.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    configure_logging(args.log_level)
    log = logger.bind(component="cli")
    log.debug("CLI command parsed: {}", args.command or "help")

    if args.command is None:
        log.debug("No command provided; printing help.")
        parser.print_help()
        return 0

    if args.command == "list":
        fixtures_dir = Path("fixtures")
        log.debug("Listing scenarios from {}.", fixtures_dir)
        scenarios = list_scenarios(fixtures_dir)
        log.info("Found {} scenario(s).", len(scenarios))
        for name in scenarios:
            print(name)
        return 0

    if args.command == "run":
        fixtures_dir = Path(args.fixtures_dir)
        log = log.bind(scenario=args.scenario)
        log.info("Starting triage run for scenario '{}' using fixtures at {}.", args.scenario, fixtures_dir)
        try:
            scenario = load_scenario(fixtures_dir, args.scenario)
            log.info(
                "Loaded incident {} for service {}.",
                scenario.incident.incident_id,
                scenario.incident.service,
            )
            tools = load_tools(fixtures_dir)
            log.debug("Loaded mock operational tools.")
        except FixtureError as error:
            log.error("Fixture loading failed: {}", error)
            print(f"Fixture error: {error}", file=sys.stderr)
            return 2

        if args.mock_llm:
            log.info("Using deterministic mock LLM response.")
            llm_client = StaticLLMClient({scenario.name: json.dumps(mock_decision_for(scenario))})
        else:
            try:
                log.debug("Loading MiniMax configuration from .env.")
                config = load_config(Path(".env"))
            except ConfigError as error:
                log.error("Configuration loading failed: {}", error)
                print(f"Configuration error: {error}", file=sys.stderr)
                return 2
            log.info("Using MiniMax model '{}' at {}.", config.model_name, config.minimax_base_url)
            llm_client = MiniMaxAnthropicClient(config)

        workflow = TriageWorkflow(tools=tools, llm_client=llm_client)
        run = workflow.run(scenario)
        log.debug("Rendering triage run output.")
        render_run(run, trace=args.trace)
        log.info("Triage run complete.")
        return 0

    if args.command == "serve":
        fixtures_dir = Path(args.fixtures_dir)
        try:
            if not fixtures_dir.exists():
                raise FixtureError(f"Fixture directory does not exist: {fixtures_dir}.")
            webhook_config = load_webhook_config(Path(".env"))
        except (FixtureError, ConfigError) as error:
            log.error("Webhook server configuration failed: {}", error)
            print(f"Configuration error: {error}", file=sys.stderr)
            return 2

        if args.mock_llm:
            log.info("Using deterministic mock LLM response for webhook server.")
            llm_client = StaticLLMClient(mock_webhook_decisions())
        else:
            try:
                config = load_config(Path(".env"))
            except ConfigError as error:
                log.error("MiniMax configuration loading failed: {}", error)
                print(f"Configuration error: {error}", file=sys.stderr)
                return 2
            log.info("Using MiniMax model '{}' at {}.", config.model_name, config.minimax_base_url)
            llm_client = MiniMaxAnthropicClient(config)

        loki_client = None
        if not args.no_loki:
            loki_client = LokiClient(webhook_config.loki_base_url)
            log.info("Using Loki at {}.", webhook_config.loki_base_url)

        runtime = WebhookRuntime(
            fixtures_dir=fixtures_dir,
            webhook_secret=webhook_config.grafana_webhook_secret,
            llm_client=llm_client,
            loki_client=loki_client,
            loki_limit=webhook_config.loki_limit,
        )
        serve(args.host, args.port, runtime)
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


def mock_webhook_decisions() -> dict[str, str]:
    return {
        "grafana-checkout-api": json.dumps(
            {
                "incident_class": "dependency_outage",
                "next_action": "escalate_owner",
                "confidence": 0.87,
                "evidence_ids": ["alert:0", "log:0", "runbook:dependency-outage"],
                "caveats": ["Synthetic Grafana/Loki integration path."],
                "verification_plan": ["Watch payment timeout rate."],
            }
        ),
        "grafana-search-api": json.dumps(
            {
                "incident_class": "capacity_saturation",
                "next_action": "apply_runbook_step_with_approval",
                "confidence": 0.84,
                "evidence_ids": ["alert:0", "log:0", "runbook:capacity-saturation"],
                "caveats": ["Scaling or throttling changes require approval."],
                "verification_plan": ["Check CPU utilization.", "Check queue depth.", "Check p95 latency."],
            }
        ),
        "grafana-bad-deploy-latency": json.dumps(
            {
                "incident_class": "bad_deploy",
                "next_action": "request_rollback_approval",
                "confidence": 0.86,
                "evidence_ids": ["alert:0", "deploy:0", "log:0", "runbook:bad-deploy"],
                "caveats": ["Rollback requires human approval."],
                "verification_plan": ["Check checkout p95 latency.", "Check checkout error budget burn."],
            }
        ),
    }


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
                print(f"- {item.evidence_id} [{item.source}/{item.source_tier.value}] {item.summary}")
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

    render_provenance(run)

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


def render_provenance(run: TriageRun) -> None:
    if not run.evidence_package:
        return
    cited_ids: tuple[str, ...] = ()
    if run.validation and run.validation.decision:
        cited_ids = run.validation.decision.evidence_ids
    summary = run.evidence_package.provenance_summary(cited_ids)

    print("\nProvenance:")
    print(f"- available_tiers: {format_value([tier.value for tier in summary.available_tiers])}")
    print(f"- cited_tiers: {format_value([tier.value for tier in summary.cited_tiers])}")
    print(f"- cited_sources: {format_value(list(summary.cited_sources))}")
    if summary.missing_context:
        print(f"- missing_context: {', '.join(summary.missing_context)}")
    if summary.historical_only:
        support = "historical_only"
    elif summary.has_current_or_operational_support:
        support = "current_or_operational"
    else:
        support = "none"
    print(f"- support: {support}")


if __name__ == "__main__":
    raise SystemExit(main())
