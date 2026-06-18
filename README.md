# Incident Triage Agent PoC

A TypeScript proof of concept for bounded LLM-assisted incident triage.

The point is not to build an incident chatbot or production automation. The point is to prove an architecture: raw incident data becomes an evidence package, an `incident-triage` skill chooses a bounded incident class and next action through MiniMax, local validation checks the result, policy gates risky actions, and the run ends with operator output plus a scorecard.

## Architecture

```text
raw incident data -> evidence package -> incident-triage skill
  -> structured result validation -> evidence citation validation
  -> safety gate -> operator output -> scorecard
```

The workflow owns control flow, state, validation, provenance, safety, and scoring. The LLM owns one bounded judgment.

## Setup

Use Node.js 22 or newer.

```bash
npm install
```

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

## Run

List scenarios:

```bash
npm run list
```

Run with deterministic mock LLM output:

```bash
npm run triage -- run checkout-payment-timeout --mock-llm --trace
```

Run with live MiniMax through Flue:

```bash
npm run triage -- run checkout-payment-timeout --trace
```

Run the webhook server locally with mock LLM output:

```bash
npm run serve -- --mock-llm
```

Logs are emitted to stderr and scenario output is emitted to stdout.

## Docker

Build the local image:

```bash
docker build -t incident-triage-agent:local .
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

Generate local service logs:

```bash
curl -s http://localhost:8081/checkout \
  -H 'Content-Type: application/json' \
  --data '{"checkout_id":"local-demo-001"}'

curl -s http://localhost:8081/capacity \
  -H 'Content-Type: application/json' \
  --data '{"incident_id":"local-capacity-001"}'

curl -s http://localhost:8081/bad-deploy \
  -H 'Content-Type: application/json' \
  --data '{"incident_id":"local-bad-deploy-001"}'
```

Send a sample Grafana webhook payload:

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

Run the same local stack with live MiniMax:

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml up -d --build
```

The live override removes `--mock-llm` from the agent and passes MiniMax settings through runtime environment interpolation.

Run the one-command live demo probe:

```bash
npm run demo-live
npm run demo-live -- --scenario capacity-saturation
npm run demo-live -- --scenario bad-deploy-latency --json
```

The probe starts the live Compose stack, generates logs through the synthetic service, posts the Grafana webhook, prints a sanitized LLM decision summary, and cleans up.

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

The provider response is not trusted directly. Local validation checks JSON shape, taxonomy values, confidence, and evidence IDs before the workflow applies safety policy.

## Evidence Provenance

Evidence tiers are assigned by the workflow, not by the LLM:

- `current_signal`: active alerts, symptoms, and verification signals.
- `operational_context`: logs, deploys, and service ownership.
- `guidance`: runbook context.
- `historical_context`: prior incidents.

Operator output includes provenance showing available tiers, cited tiers, cited sources, missing context, and whether cited evidence includes current or operational support.

## Tests

Run the default suite:

```bash
npm test
npm run typecheck
```

Default tests avoid real MiniMax calls, Docker, and networked Loki. They exercise real parser, evidence, workflow, policy, scoring, CLI, Grafana, Loki, webhook, synthetic service, and outcome code paths with fixture payloads and fake external transports.

Outcome tests live in `tests/triage-outcomes.test.ts` and `tests/webhook-outcomes.test.ts`, with shared assertions in `tests/support/outcomes.ts`.

The Docker-backed Grafana/Loki E2E test is opt-in:

```bash
RUN_DOCKER_E2E=1 npm test -- tests/e2e-grafana-loki.test.ts
```

The live MiniMax E2E is separate and opt-in:

```bash
RUN_LIVE_LLM_E2E=1 npm test -- tests/e2e-live-service-llm.test.ts
LIVE_E2E_SCENARIOS=all RUN_LIVE_LLM_E2E=1 npm test -- tests/e2e-live-service-llm.test.ts
```

## Why Actions Are Simulated

Incident response actions can affect customers. This PoC stages approval-sensitive actions and prints audit payloads, but it does not call deployment, ticketing, chat, or production observability systems. That keeps the architecture inspectable without creating production blast radius.
