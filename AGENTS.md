# AGENTS.md

## Project Overview

This repo is a TypeScript proof of concept for a bounded LLM-assisted incident triage agent.

The important architectural idea is that the workflow owns control flow and the LLM owns one bounded judgment. Raw incident facts are converted into an evidence package, the local `incident-triage` skill chooses an incident class and next action from a fixed taxonomy through MiniMax, local validation checks the result, policy gates risky actions, and the CLI/server emit provenance plus scorecard output.

Core flow:

```text
raw incident data -> evidence package -> incident-triage skill
  -> structured result validation -> evidence citation validation
  -> safety gate -> operator output -> scorecard
```

Primary TypeScript code lives in `src/`:

- `cli.ts`: command-line interface.
- `config.ts`: `.env` loading for MiniMax and webhook config.
- `domain.ts`: taxonomy, fixture loading, and raw incident validation.
- `evidence.ts`: deterministic SRE context tools and evidence package construction.
- `grafana.ts`: Grafana webhook payload normalization into raw incidents.
- `loki.ts`: bounded Loki query client and log evidence conversion.
- `llm.ts`: Flue-backed MiniMax decision adapter and decision validation.
- `policy.ts`: safety gate and simulated approval handling.
- `scoring.ts`: deterministic eval scorecard.
- `server.ts`: local Grafana webhook server and JSON response rendering.
- `workflow.ts`: triage state machine.
- `workflows/incident-triage.ts`: discovered Flue workflow boundary for the local `incident-triage` skill.

Local synthetic service code lives in `services/synthetic-checkout-service.ts`. It emits request-derived incident logs to Loki and has no production authority.

## Quick Start

Use Node.js 22 or newer.

```bash
npm install
npm test
npm run typecheck
npm run list
npm run triage -- run checkout-payment-timeout --mock-llm --trace
```

Create a local `.env` from `.env.example` for live MiniMax and webhook tests. The real `.env` is ignored by git and must stay untracked.

Run the real MiniMax path:

```bash
npm run triage -- run checkout-payment-timeout --trace
```

Run the webhook server locally with mock LLM output:

```bash
npm run serve -- --mock-llm
```

Run the local Grafana/Loki stack:

```bash
docker compose up -d --build
```

Run the live MiniMax Compose override only when you explicitly want provider variance and cost:

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml up -d --build
```

Run the one-command live demo probe:

```bash
npm run demo-live
npm run demo-live -- --scenario capacity-saturation
```

Useful verification before handing off changes:

```bash
npm test
npm run typecheck
git diff --check
```

## Hard Constraints

- Never commit `.env`, API keys, provider secrets, or real credentials.
- Do not print secret values in CLI output, test failures, logs, docs, or exceptions.
- Keep fixtures raw. Scenario incident data must not contain `suspected_causes`, `recommended_actions`, or `requires_approval`.
- Keep Grafana webhook ingestion raw. Alert labels and annotations may become facts, but they must not become suspected causes, recommended actions, or eval expectations.
- Keep bad-deploy webhook evidence raw. Deployment facts belong in deploy evidence fixtures or real deploy sources, not rollback hints inside Grafana annotations.
- Keep Loki lookup bounded by service labels, time window, and result limit before prompt assembly.
- Keep webhook secrets out of output and logs. Use `X-Webhook-Secret` only as an auth boundary, never as evidence.
- Do not let LLM output drive workflow state until local validation passes.
- Keep the incident class taxonomy bounded to `dependency_outage`, `bad_deploy`, `capacity_saturation`, `noisy_alert`, `insufficient_context`, and `unknown`.
- Keep the next action taxonomy bounded to `escalate_owner`, `request_rollback_approval`, `apply_runbook_step_with_approval`, `continue_monitoring`, `ask_human`, and `gather_more_context`.
- Approval-sensitive actions must be staged and audited, not executed.
- The scorecard must remain deterministic. Do not use the LLM to grade its own run.
- Outcome tests should assert the operator-facing contract: bounded decisions, evidence citations, provenance support, safety behavior, and recoverable failure handling.
- Preserve stable evidence IDs when changing mock tools or fixtures.
- Tests must not require real MiniMax credentials or network access.
- Docker-backed Grafana/Loki E2E tests must remain opt-in; the default suite should not start containers.
- Live MiniMax E2E must remain separate from the mock Docker E2E and require `RUN_LIVE_LLM_E2E=1`.
- Additional live MiniMax E2E scenarios must remain explicitly selected with `LIVE_E2E_SCENARIOS`; the default live path should stay narrow.
- Synthetic services may generate incident-shaped evidence, but they must not execute remediation or connect to production systems.
- Use `npm test`, `npm run typecheck`, and `npm run triage -- ...` for local verification.
- Use Docker for the local Grafana/Loki/demo runtime.
- Use the Anthropic-compatible MiniMax endpoint through the adapter boundary. Do not scatter direct provider calls through workflow code.
- Keep the CLI trace as a product surface: it should distinguish raw facts, gathered evidence, LLM output, validation, safety gating, and scorecard results.
- Keep diagnostic logs on stderr so stdout remains usable for the triage report.
- When changing library, SDK, API, CLI, framework, or cloud-service usage, fetch current docs with `ctx7` first as described by the repo instructions.

## Testing Convention

- Write tests that call actual functions, HTTP handlers, scripts, or local service endpoints and verify returned behavior.
- Use realistic payload fixtures from `fixtures/` for incident, Grafana, runbook, deploy, service, and prior-incident data.
- Prefer focused integration or outcome tests over many narrow object-shape tests.
- Verify parsing, validation, error handling, request/response contracts, evidence citations, provenance, safety behavior, and recoverable failure modes.
- When mocking, mock only unstable external boundaries such as the LLM provider, Loki transport, Docker availability, or live credentials; keep the parser, workflow, policy, scoring, and response-rendering paths real.
- Do not add tests that only instantiate local objects and assert the values they were constructed with.
- Avoid brittle hardcoded string checks unless the string is a public contract, a stable evidence ID, a safety/security guarantee, or a required operator-facing message.
- Docker and live-provider tests must remain opt-in, but when enabled they should fail or skip explicitly instead of silently passing without exercising a scenario.
- More tests are not automatically better. Bias toward fewer tests that prove meaningful behavior across real code paths.

## Topic Docs

- [README.md](README.md): project walkthrough, commands, scenarios, decision contract, and testing notes.
- [docs/learnings.md](docs/learnings.md): running teaching checklist and session learnings.
- [CONCEPTS.md](CONCEPTS.md): shared domain vocabulary.
- [docs/solutions/](docs/solutions/): searchable solution learnings from past problems and decisions.
- [.agents/skills/incident-triage/SKILL.md](.agents/skills/incident-triage/SKILL.md): incident-triage skill boundary discovered by Flue.
- [fixtures/scenarios/](fixtures/scenarios/): raw incident scenarios.
- [fixtures/runbooks/](fixtures/runbooks/): runbook grounding context.
- [fixtures/deploys/deploys.json](fixtures/deploys/deploys.json): mock deploy facts used by webhook evidence construction.
- [fixtures/services/services.json](fixtures/services/services.json): mock service ownership metadata.
- [fixtures/prior_incidents/prior-incidents.json](fixtures/prior_incidents/prior-incidents.json): mock prior incident context.
- [fixtures/grafana/](fixtures/grafana/): synthetic Grafana webhook payloads.
- [tests/support/outcomes.ts](tests/support/outcomes.ts): shared outcome assertions for workflow, webhook, Docker E2E, and live-provider tests.
- [docker-compose.yml](docker-compose.yml): local Grafana, Loki, synthetic service, and webhook-agent stack.
- [docker-compose.live.yml](docker-compose.live.yml): opt-in live MiniMax override.
- [services/synthetic-checkout-service.ts](services/synthetic-checkout-service.ts): local service that generates Loki logs from test requests.
- [scripts/run-live-e2e-probe.ts](scripts/run-live-e2e-probe.ts): one-command live demo probe.
- [docs/examples/live-e2e-response.json](docs/examples/live-e2e-response.json): sanitized example of a successful live-provider response.
