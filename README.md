# Incident Triage Agent PoC

A CLI proof of concept for bounded LLM-assisted incident triage.

The point is not to build an incident chatbot or production automation. The point is to prove an architecture: raw incident data becomes an evidence package, MiniMax chooses a bounded incident class and next action, local validation checks the decision, policy gates risky actions, and the run ends with a scorecard.

## Architecture

```text
raw fixture -> mock tools -> evidence package -> MiniMax decision
  -> local validation -> safety gate -> verification plan -> scorecard
```

The workflow owns control flow. The LLM owns one bounded judgment.

Evidence records also carry source tiers so the workflow can distinguish live incident signals from operational context, runbook guidance, and historical analogy.

## Setup

Use `uv` with Python 3.11 or newer.

Create `.env` from `.env.example`:

```text
MINIMAX_API_KEY=replace-with-your-minimax-api-key
MODEL_NAME=MiniMax-M2.7
MINIMAX_BASE_URL=https://api.minimax.io
GRAFANA_WEBHOOK_SECRET=replace-with-a-local-webhook-secret
LOKI_BASE_URL=http://localhost:3100
LOKI_LIMIT=20
```

The real `.env` is ignored by git.

Install and lock dependencies:

```bash
uv sync
```

## TypeScript Migration

The Bun/TypeScript redesign is being introduced behind the existing Python runtime. It now includes the core fixture workflow, bounded decision validation, source-tiered evidence, safety policy, scorecards, Pino CLI logging, and handler-level Grafana/Loki webhook parity.

Install TypeScript dependencies:

```bash
bun install
```

Run the TypeScript tests and typecheck:

```bash
bun test
bun run typecheck
```

List scenarios and run the deterministic mock path:

```bash
bun run list
bun run triage run checkout-payment-timeout --mock-llm --trace
```

The TypeScript live LLM path intentionally treats Flue runtime loading as a compatibility boundary. Flue 1.0 beta currently pulls Node-only runtime pieces such as `node:sqlite`, so the Python runtime remains the live MiniMax/Docker demo surface until the Flue execution path is moved to a Node-compatible runtime surface or Bun compatibility is confirmed.

## Run

List scenarios:

```bash
uv run triage list
```

Run with deterministic mock LLM output:

```bash
uv run triage run checkout-payment-timeout --mock-llm --trace
```

Run with MiniMax:

```bash
uv run triage run checkout-payment-timeout --trace
```

Logs are emitted to stderr and scenario output is emitted to stdout. Default
logging shows high-level milestones; use `DEBUG` for detailed step logs or
`WARNING` for quiet output:

```bash
uv run triage --log-level DEBUG run checkout-payment-timeout --mock-llm
uv run triage --log-level WARNING run checkout-payment-timeout --mock-llm
```

## Docker

Build the local image:

```bash
docker build -t incident-triage-agent:local .
```

List scenarios in Docker:

```bash
docker run --rm incident-triage-agent:local list
```

Run the deterministic mock path in Docker:

```bash
docker run --rm incident-triage-agent:local run checkout-payment-timeout --mock-llm --trace
```

Run the real MiniMax path in Docker:

```bash
docker run --rm --env-file .env incident-triage-agent:local run checkout-payment-timeout --trace
```

Run the local Grafana/Loki integration stack with the synthetic incident service and mock LLM:

```bash
docker compose up -d --build
```

Generate synthetic checkout logs from a real local service request:

```bash
curl -s http://localhost:8081/checkout \
  -H 'Content-Type: application/json' \
  --data '{"checkout_id":"local-demo-001"}'
```

Generate capacity or bad-deploy logs:

```bash
curl -s http://localhost:8081/capacity \
  -H 'Content-Type: application/json' \
  --data '{"incident_id":"local-capacity-001"}'

curl -s http://localhost:8081/bad-deploy \
  -H 'Content-Type: application/json' \
  --data '{"incident_id":"local-bad-deploy-001"}'
```

Send the sample Grafana webhook payload:

```bash
curl -s http://localhost:8080/webhooks/grafana \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: local-webhook-secret' \
  --data @fixtures/grafana/checkout-payment-timeout-webhook.json
```

Stop the stack:

```bash
docker compose down -v
```

The Compose path is still synthetic. Grafana and Loki provide observability-shaped facts; they do not grant the agent production access or execution authority.

Run the same local stack with a live MiniMax call:

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml up -d --build
```

The live override removes `--mock-llm` from the agent and passes MiniMax settings through runtime environment interpolation. It may spend provider credits and can vary because it calls the real model.

Run the full live demo probe as one command:

```bash
uv run python scripts/run_live_e2e_probe.py
```

The probe starts the live Compose stack, generates logs through the synthetic service, posts the Grafana webhook, prints the LLM decision summary, and cleans up the stack. Use `--scenario capacity-saturation` or `--scenario bad-deploy-latency` to demo another incident path, and use `--json` to print the sanitized response shape. A saved example lives at `docs/examples/live-e2e-response.json`.

## Grafana Webhook Server

Run the webhook server locally with deterministic mock LLM output:

```bash
uv run triage serve --mock-llm
```

The server accepts `POST /webhooks/grafana` and requires the `X-Webhook-Secret` header to match `GRAFANA_WEBHOOK_SECRET`. It normalizes Grafana alert payloads into raw incident facts, queries Loki for bounded log context when configured, adds service, runbook, and deploy facts from fixtures, builds the normal evidence package, and runs the same workflow used by fixture scenarios.

Resolved-only Grafana payloads are ignored by default. Missing Loki logs become missing context instead of a crash. Bad-deploy webhook fixtures keep rollback language out of Grafana annotations; deploy context comes from `fixtures/deploys/deploys.json`.

The TypeScript runtime currently includes Grafana payload normalization, Loki query/evidence conversion, and a tested webhook handler function. The TypeScript HTTP `serve` command is not enabled yet; use the Python server for local webhook demos.

## Scenarios

- `checkout-payment-timeout`: dependency outage path.
- `bad-deploy-latency`: approval-gated rollback recommendation.
- `capacity-saturation`: runbook-guided approval path.
- `noisy-alert`: non-mutating monitor path with missing runbook context.

## Decision Contract

Allowed `incident_class` values:

- `dependency_outage`
- `bad_deploy`
- `capacity_saturation`
- `noisy_alert`
- `insufficient_context`
- `unknown`

Allowed `next_action` values:

- `escalate_owner`
- `request_rollback_approval`
- `apply_runbook_step_with_approval`
- `continue_monitoring`
- `ask_human`
- `gather_more_context`

The provider response is not trusted directly. The adapter extracts text from the Anthropic-compatible MiniMax response, then local validation checks JSON shape, taxonomy values, confidence, and evidence IDs.

## Evidence Provenance

Evidence tiers are assigned by the workflow, not by the LLM:

- `current_signal`: active alerts, symptoms, and verification signals.
- `operational_context`: logs, deploys, and service ownership.
- `guidance`: runbook context.
- `historical_context`: prior incidents.

CLI output includes a provenance section showing available tiers, cited tiers, cited sources, missing context, and whether the cited evidence includes current or operational support. Historical context can support a recommendation, but a confident concrete classification should not rely on historical context alone.

## Tests

Run the test suite with stdlib `unittest`:

```bash
uv run python -m unittest discover -s tests
```

Tests use fake LLM responses by default. Real MiniMax calls are not required for the suite.

Run the TypeScript suite:

```bash
bun test
bun run typecheck
```

The TypeScript default tests also avoid real MiniMax calls, Docker, and networked Loki. They exercise real parser, evidence, workflow, policy, scoring, CLI, Grafana, Loki, and webhook handler code paths with fixture payloads and fake external transports.

A sanitized TypeScript webhook-handler response example lives at `docs/examples/typescript-webhook-response.json`.

Outcome tests live in `tests/test_triage_outcomes.py` and `tests/test_webhook_outcomes.py`, with shared assertions in `tests/support/outcomes.py`. Use them when a change should preserve the operator-facing triage contract: bounded class/action, evidence citations, provenance support, safety behavior, and recoverable failure handling. Unit tests should still cover local parsing and policy details; scorecards still evaluate deterministic run quality.

The Docker-backed Grafana/Loki E2E test is opt-in:

```bash
RUN_DOCKER_E2E=1 uv run python -m unittest tests/test_e2e_grafana_loki.py
```

That test uses the synthetic incident service to generate checkout, capacity, and bad-deploy Loki logs, while keeping the LLM deterministic. The live MiniMax E2E is a separate opt-in test:

```bash
RUN_LIVE_LLM_E2E=1 uv run python -m unittest tests/test_e2e_real_service_live_llm.py
```

The live test requires Docker plus usable `MINIMAX_API_KEY` and `MODEL_NAME` config. It runs `checkout-payment-timeout` by default. Set `LIVE_E2E_SCENARIOS=capacity-saturation,bad-deploy-latency` or `LIVE_E2E_SCENARIOS=all` to run additional live scenarios. It asserts the bounded response contract, evidence citations, provenance, and safety behavior instead of exact model wording.

## Why Actions Are Simulated

Incident response actions can affect customers. This PoC stages approval-sensitive actions and prints audit payloads, but it does not call deployment, ticketing, chat, or observability systems. That keeps the architecture inspectable without creating production blast radius.
