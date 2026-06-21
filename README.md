# Incident Triage Agent PoC

A TypeScript proof of concept for bounded LLM-assisted incident triage.

The point is not to build an incident chatbot or production automation. The point is to prove an architecture: raw incident data becomes an evidence package, the workflow records what it investigated, an `incident-triage` skill explains and chooses a bounded incident class and next action through MiniMax, local validation checks the result, policy gates risky actions, and the run ends with operator output plus a scorecard.

## Architecture

```text
raw incident data -> evidence package + investigation trace
  -> incident-triage skill -> structured result validation
  -> explanation validation -> evidence citation validation
  -> safety gate -> operator output -> scorecard
```

The workflow owns control flow, state, factual investigation steps, validation, provenance, safety, and scoring. The LLM owns evidence-grounded explanation and one bounded judgment. The `incident-triage` skill guides that judgment through a human SRE-style investigation order: current signal, impact, recent changes, dependency-vs-local evidence, evidence quality, missing context, bounded next action, and verification.

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

## Recorded Observability Triage

Run a recorded Grafana webhook payload plus recorded Loki-shaped logs through the real webhook handler and workflow with deterministic mock LLM output:

```bash
npm run triage:recorded
npm run triage:recorded -- --scenario capacity-saturation
npm run triage:recorded -- --scenario bad-deploy-latency --json
```

Run the same recorded input path with live MiniMax:

```bash
npm run triage:live
npm run triage:live -- --scenario capacity-saturation
```

The recorded triage run does not start Grafana, Loki, Docker Compose, or a synthetic service. It loads `fixtures/grafana/` payloads and `fixtures/logs/` records, then exercises the real webhook normalization, evidence construction, workflow, validation, safety, provenance, and scorecard path.
The default human output starts with an input summary so reviewers can see which recorded alerts, service, severity, start time, and log count produced the decision.

You can still run the webhook server directly when you want to post a payload yourself:

```bash
npm run serve -- --mock-llm

curl -s http://localhost:8080/webhooks/grafana \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: replace-with-a-local-webhook-secret' \
  --data @fixtures/grafana/checkout-payment-timeout-webhook.json
```

## Scenarios

- `checkout-payment-timeout`: dependency outage path.
- `bad-deploy-latency`: approval-gated rollback recommendation.
- `capacity-saturation`: runbook-guided approval path.
- `noisy-alert`: non-mutating monitor path with missing runbook context.

## Run Envelope And Decision Contract

Each completed triage run exposes an additive run envelope:

- `run_id` and `run_status` identify the run and terminal lifecycle state.
- `investigation` summarizes workflow-authored evidence-gathering steps.
- `analysis`, `finding_summary`, and `recommendation` are LLM-authored explanation fields.
- `explanation_validation` reports whether those explanation fields were valid, degraded, or unavailable.
- `decision` remains the authoritative bounded operational result.
- `safety`, `provenance`, and `scorecard` continue to derive from the validated decision.

The explanation layer is useful for human inspection, but it does not drive workflow state or production authority.

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

The provider response is not trusted directly. Local validation checks JSON shape, taxonomy values, confidence, and decision evidence IDs before the workflow applies safety policy. Explanation fields are validated separately; malformed explanation data can be dropped with warnings when the bounded decision is still valid.

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

Default tests avoid real MiniMax calls, Docker, and networked Loki. They exercise real parser, evidence, workflow, policy, scoring, CLI, Grafana, Loki-shaped log replay, webhook, and outcome code paths with fixture payloads and mock external transports.

Outcome tests live in `tests/triage-outcomes.test.ts` and `tests/webhook-outcomes.test.ts`, with shared assertions in `tests/support/outcomes.ts`.

The recorded observability integration test replays Grafana webhook payloads and Loki-shaped logs through real handler and workflow code:

```bash
npm test -- tests/observability-integration.test.ts
```

The live MiniMax path is covered by opt-in Flue evals and the recorded triage command:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run evals
npm run triage:live
```

## Evals

Flue evals are separate from the default test suite. Use them to compare prompt, skill, and model behavior over representative incident cases.

Run deterministic evals:

```bash
npm run evals
```

Write a JSON report and inspect it locally:

```bash
npm run evals:json
npm run evals:ui
```

Run live MiniMax evals explicitly:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run evals
```

Hard requirements such as schema validity, evidence citations, provenance support, and safety behavior are deterministic assertions. Judge-style evals are reserved for softer explanation qualities like recommendation usefulness and verification-plan actionability.

Recorded triage quality gates are deterministic regression checks. They report named pass/fail gates such as `schema_contract`, `evidence_grounding`, `provenance_support`, `safety_contract`, and `recorded_triage_readability`. A response that omits `recommendation.rationale` can still be safe, but it fails recorded-triage readability because the representative output is not clear enough for review.

## Why Actions Are Simulated

Incident response actions can affect customers. This PoC stages approval-sensitive actions and prints audit payloads, but it does not call deployment, ticketing, chat, or production observability systems. That keeps the architecture inspectable without creating production blast radius.
