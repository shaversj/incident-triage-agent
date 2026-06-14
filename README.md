# Incident Triage Agent PoC

A CLI proof of concept for bounded LLM-assisted incident triage.

The point is not to build an incident chatbot or production automation. The point is to prove an architecture: raw incident data becomes an evidence package, MiniMax chooses a bounded incident class and next action, local validation checks the decision, policy gates risky actions, and the run ends with a scorecard.

## Architecture

```text
raw fixture -> mock tools -> evidence package -> MiniMax decision
  -> local validation -> safety gate -> verification plan -> scorecard
```

The workflow owns control flow. The LLM owns one bounded judgment.

## Setup

Use `uv` with Python 3.11 or newer.

Create `.env` from `.env.example`:

```text
MINIMAX_API_KEY=replace-with-your-minimax-api-key
MODEL_NAME=MiniMax-M2.7
```

The real `.env` is ignored by git.

Install and lock dependencies:

```bash
uv sync
```

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

## Tests

Run the test suite with stdlib `unittest`:

```bash
uv run python -m unittest discover -s tests
```

Tests use fake LLM responses by default. Real MiniMax calls are not required for the suite.

## Why Actions Are Simulated

Incident response actions can affect customers. This PoC stages approval-sensitive actions and prints audit payloads, but it does not call deployment, ticketing, chat, or observability systems. That keeps the architecture inspectable without creating production blast radius.
