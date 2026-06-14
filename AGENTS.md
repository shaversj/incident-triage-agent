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
- Prefer `uv run ...` for local commands and keep Docker using the installed `triage` entrypoint from the uv-managed environment.
- Use the Anthropic-compatible MiniMax endpoint through the adapter boundary. Do not scatter direct provider calls through workflow code.
- Keep the CLI trace as a product surface: it should distinguish raw facts, gathered evidence, LLM output, validation, safety gating, and scorecard results.
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
