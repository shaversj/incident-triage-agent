# AGENTS.md

## Project Overview

This repo is a proof of concept for a bounded LLM-assisted incident triage agent.

The important architectural idea is that the workflow owns control flow and the LLM owns one bounded judgment. Raw incident fixtures are converted into an evidence package, MiniMax chooses an incident class and next action from a fixed taxonomy, local validation checks the decision, policy gates risky actions, and the CLI emits a trace plus scorecard.

Core flow:

```text
raw fixture -> mock tools -> evidence package -> MiniMax decision
  -> local validation -> safety gate -> verification plan -> scorecard
```

Primary code lives in `src/incident_triage_agent/`:

- `cli.py`: command-line interface.
- `config.py`: `.env` loading for MiniMax config.
- `domain.py`: dataclasses, taxonomy, fixture loading, validation.
- `grafana.py`: Grafana webhook payload normalization into raw incidents.
- `loki.py`: bounded Loki `query_range` client and log evidence conversion.
- `server.py`: local Grafana webhook server and JSON response rendering.
- `tools.py`: deterministic mock SRE context tools.
- `llm.py`: MiniMax Anthropic-compatible adapter and decision parsing.
- `policy.py`: safety gate and simulated approval handling.
- `scoring.py`: deterministic eval scorecard.
- `workflow.py`: triage state machine.

The project intentionally uses mock operational data. It should prove the architecture and decision boundaries without integrating with production incident, deploy, ticketing, chat, or observability systems.

## Quick Start

Use `uv` with Python 3.11 or newer.

Create a local `.env` from `.env.example`:

```text
MINIMAX_API_KEY=replace-with-your-minimax-api-key
MODEL_NAME=MiniMax-M2.7
GRAFANA_WEBHOOK_SECRET=replace-with-a-local-webhook-secret
LOKI_BASE_URL=http://localhost:3100
LOKI_LIMIT=20
```

The real `.env` is ignored by git and must stay untracked.

Install and lock dependencies:

```bash
uv sync
```

List scenarios:

```bash
uv run triage list
```

Run the deterministic mock LLM path:

```bash
uv run triage run checkout-payment-timeout --mock-llm --trace
```

Run the real MiniMax path:

```bash
uv run triage run checkout-payment-timeout --trace
```

CLI logs are emitted to stderr. Default logs show high-level milestones; use `--log-level DEBUG` for detailed step logs or `--log-level WARNING` for quiet output. Keep stdout reserved for scenario results.

Build the Docker image:

```bash
docker build -t incident-triage-agent:local .
```

Run through Docker:

```bash
docker run --rm incident-triage-agent:local run checkout-payment-timeout --mock-llm --trace
```

Run the real MiniMax path through Docker:

```bash
docker run --rm --env-file .env incident-triage-agent:local run checkout-payment-timeout --trace
```

Run the Grafana webhook server locally with mock LLM output:

```bash
uv run triage serve --mock-llm
```

Run the local Grafana/Loki stack:

```bash
docker compose up -d --build
```

Run tests:

```bash
uv run python -m unittest discover -s tests
```

Useful verification before handing off changes:

```bash
uv run python -m compileall -q src tests
uv run python -m unittest discover -s tests
git diff --check
```

## Hard Constraints

- Never commit `.env`, API keys, provider secrets, or real credentials.
- Do not print secret values in CLI output, test failures, logs, docs, or exceptions.
- Keep fixtures raw. Scenario incident data must not contain `suspected_causes`, `recommended_actions`, or `requires_approval`.
- Keep Grafana webhook ingestion raw. Alert labels and annotations may become facts, but they must not become suspected causes, recommended actions, or eval expectations.
- Keep Loki lookup bounded by service labels, time window, and result limit before prompt assembly.
- Keep webhook secrets out of output and logs. Use `X-Webhook-Secret` only as an auth boundary, never as evidence.
- Do not let LLM output drive workflow state until local validation passes.
- Keep the incident class taxonomy bounded to:
  - `dependency_outage`
  - `bad_deploy`
  - `capacity_saturation`
  - `noisy_alert`
  - `insufficient_context`
  - `unknown`
- Keep the next action taxonomy bounded to:
  - `escalate_owner`
  - `request_rollback_approval`
  - `apply_runbook_step_with_approval`
  - `continue_monitoring`
  - `ask_human`
  - `gather_more_context`
- Approval-sensitive actions must be staged and audited, not executed.
- The scorecard must remain deterministic. Do not use the LLM to grade its own run.
- Preserve stable evidence IDs when changing mock tools or fixtures.
- Tests must not require real MiniMax credentials or network access.
- Docker-backed Grafana/Loki E2E tests must remain opt-in; the default suite should not start containers.
- Prefer `uv run ...` for local commands and keep Docker using the installed `triage` entrypoint from the uv-managed environment.
- Use the Anthropic-compatible MiniMax endpoint through the adapter boundary. Do not scatter direct provider calls through workflow code.
- Keep the CLI trace as a product surface: it should distinguish raw facts, gathered evidence, LLM output, validation, safety gating, and scorecard results.
- Keep diagnostic logs on stderr so stdout remains usable for the triage report.
- When changing library, SDK, API, CLI, framework, or cloud-service usage, fetch current docs with `ctx7` first as described by the repo instructions.

## Topic Docs

- [README.md](README.md): project walkthrough, commands, scenarios, decision contract, and testing notes.
- [docs/learnings.md](docs/learnings.md): running teaching checklist and session learnings.
- [docs/solutions/](docs/solutions/): searchable solution learnings from past problems and decisions, organized by category with YAML frontmatter such as `module`, `tags`, and `problem_type`; relevant when implementing, debugging, or making decisions in documented areas.
- [CONCEPTS.md](CONCEPTS.md): shared domain vocabulary for project-specific concepts; relevant when orienting to the codebase or discussing incident-triage architecture.
- [docs/brainstorms/2026-06-14-incident-triage-agent-requirements.md](docs/brainstorms/2026-06-14-incident-triage-agent-requirements.md): original requirements and product framing.
- [docs/plans/2026-06-14-001-feat-incident-triage-agent-plan.md](docs/plans/2026-06-14-001-feat-incident-triage-agent-plan.md): implementation plan and architecture breakdown.
- [fixtures/scenarios/](fixtures/scenarios/): raw incident scenarios.
- [fixtures/runbooks/](fixtures/runbooks/): runbook grounding context.
- [fixtures/services/services.json](fixtures/services/services.json): mock service ownership metadata.
- [fixtures/prior_incidents/prior-incidents.json](fixtures/prior_incidents/prior-incidents.json): mock prior incident context.
- [fixtures/grafana/](fixtures/grafana/): synthetic Grafana webhook payloads for integration tests.
- [docker-compose.yml](docker-compose.yml): local Grafana, Loki, and webhook-agent stack.
- [scripts/seed_loki_logs.py](scripts/seed_loki_logs.py): synthetic Loki log seeding helper.
