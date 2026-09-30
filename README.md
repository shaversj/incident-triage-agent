# Incident Triage Agent

[![CI](https://github.com/shaversj/incident-triage-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/shaversj/incident-triage-agent/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![Node](https://img.shields.io/badge/Node.js-22-green)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A TypeScript prototype of an AI-assisted SRE operator. It takes incident signals, gathers evidence, asks an LLM for one bounded judgment, validates that judgment locally, and routes risky mitigations through deterministic safety and approval controls.

This is not an incident chatbot. The project is about control: the workflow owns state, evidence, validation, provenance, mitigation policy, approval staging, audit output, persistence, and scoring. The LLM is limited to explaining the evidence and choosing from a fixed operational taxonomy.

## What The Project Does

- Ingests recorded incident scenarios or Grafana-shaped webhook payloads.
- Builds an evidence package from incident facts, runbooks, deploy data, service metadata, prior incidents, and Loki-shaped logs.
- Calls either a mock decision client or MiniMax through the Flue-backed adapter.
- Validates the LLM result before it can affect workflow state.
- Maps approval-sensitive actions through a mitigation catalog.
- Stages human approvals and records simulated executor output without touching production systems.
- Persists run reviews and evidence snapshots in memory or Postgres.
- Exposes browser consoles for run review and approval decisions.
- Runs deterministic tests and evals for schema, evidence grounding, safety, mitigation governance, and readability.
- Reviews representative run batches, promotes recurring first failures into a living taxonomy, and links them to executable regressions.

## Main Demo

Use this path to see the full operator loop: recorded alert -> evidence -> bounded decision -> approval gate -> simulated execution audit.

![Operator demo walkthrough](docs/assets/operator-demo-walkthrough.gif)

```bash
npm install
cp .env.example .env # if you do not already have one
docker compose up -d postgres
npm run demo:operator
```

`demo:operator` starts the server in local mode with the mock LLM, uses `.env` for persistence settings such as `DATABASE_URL`, and clears `OPERATOR_READ_TOKEN` for the demo process so `/runs` loads without an auth prompt.

Before starting the server, the script checks that `.env` exists, `DATABASE_URL` is set, and Postgres accepts a short connection. If the check fails, it prints the exact `docker compose up -d postgres` and `DATABASE_URL` guidance to fix the local setup.

Then open:

```text
http://127.0.0.1:8080/runs
```

In the UI:

1. Select `bad-deploy-latency`.
2. Click **Run Scenario**.
3. Review the generated incident, evidence, RCA hypothesis, decision, mitigation status, and approval gate.
4. Click **Approve**.
5. Confirm the approval audit timeline shows the decision and a `dry_run: true` simulated executor result.

If Docker maps Postgres to a different host port, keep `.env` consistent:

```text
POSTGRES_HOST_PORT=5433
DATABASE_URL=postgres://incident_triage:incident_triage@localhost:5433/incident_triage
```

## Fast CLI Demo

Run a deterministic triage report with no provider credentials and no Docker:

```bash
npm install
npm run triage -- run checkout-payment-timeout --mock-llm --trace
```

The run emits structured logs to stderr and the operator-facing triage report to stdout.

Sample output: [docs/examples/checkout-payment-timeout-trace.txt](docs/examples/checkout-payment-timeout-trace.txt)

## Scenarios

| Scenario | Incident type | Expected action | Shows |
| --- | --- | --- | --- |
| `checkout-payment-timeout` | Dependency outage | Escalate owner | Evidence grounding and dependency-vs-local reasoning |
| `bad-deploy-latency` | Bad deploy | Request rollback approval | Approval gate for risky remediation |
| `capacity-saturation` | Capacity saturation | Apply runbook step with approval | Runbook-guided next action |
| `noisy-alert` | Noisy alert | Continue monitoring | Restraint when evidence is weak |

List scenarios:

```bash
npm run list
```

Run a different CLI scenario:

```bash
npm run triage -- run bad-deploy-latency --mock-llm --trace
```

## What To Look At

Start with these files if you want to understand the implementation:

| File | Why it matters |
| --- | --- |
| [src/workflow.ts](src/workflow.ts) | Incident lifecycle and state machine. |
| [src/evidence.ts](src/evidence.ts) | Deterministic evidence gathering and provenance. |
| [src/llm.ts](src/llm.ts) | Mock and live LLM boundary plus response validation. |
| [src/mitigation-control.ts](src/mitigation-control.ts) | Catalog-backed mitigation governance, dry-run, audit, and approval staging. |
| [src/policy.ts](src/policy.ts) | Safety compatibility gate derived from mitigation governance. |
| [src/server.ts](src/server.ts) | Webhook handling, run review API, demo launcher, and approval API. |
| [src/run-review-console.ts](src/run-review-console.ts) | Browser UI for reviewing runs and approving staged mitigations. |
| [tests/e2e/run-review-approval.pw.ts](tests/e2e/run-review-approval.pw.ts) | Browser coverage for the approval workflow. |
| [docs/ai-operator-architecture.md](docs/ai-operator-architecture.md) | Architecture, trust boundaries, demo paths, and production integration points. |

## Architecture

```mermaid
flowchart LR
    A["Raw incident data"] --> B["Evidence package"]
    B --> C["Investigation trace"]
    C --> D["incident-triage skill"]
    D --> E["Structured LLM result"]
    E --> F["Schema and taxonomy validation"]
    F --> G["Evidence citation validation"]
    G --> H["Mitigation Control Plane"]
    H --> I["Safety compatibility gate"]
    I --> J["Operator output"]
    J --> K["Scorecard"]
```

The workflow owns control flow, factual investigation steps, validation, provenance, mitigation governance, safety, and scoring. The `incident-triage` skill guides the LLM through a human SRE-style investigation order: current signal, impact, recent changes, dependency-vs-local evidence, evidence quality, missing context, bounded next action, and verification.

The Mitigation Control Plane is the action-control layer of the prototype: the place an AI Operator-style system would prove a proposed mitigation is cataloged, bounded, approval-aware, and observable. It sits after local decision validation and deterministically decides whether the proposed action is recommendation-only, catalog-approved but approval-required, or blocked/escalated. It records evidence checks, simulated dry-run output, staged action state, audit data, and recorded verification outcomes without granting production mutation authority.

`AI_OPERATOR_MODE` controls which authority the server is allowed to exercise:

| Mode | Intended use | Approval staging | Execution |
| --- | --- | --- | --- |
| `local` | Fixture demos and local approval simulation | Enabled | Disabled |
| `read_only` | Phase 1 production triage against real alerts/logs | Disabled | Disabled |
| `approval` | Future durable approval workflow | Blocked until auth exists | Disabled |
| `execution_enabled` | Future bounded executor mode | Blocked until implemented | Blocked until implemented |

When `serve` sees real integration configuration such as Grafana, Loki, MiniMax, or database settings, `AI_OPERATOR_MODE` must be set explicitly. In `read_only`, the webhook path can return a safety decision that says approval would be required, but it does not emit approval requests, staged actions, simulated action states, or approval-store writes.

## Decision Contract

Each completed triage run returns a run envelope:

- `run_id` and `run_status` identify the run and lifecycle state.
- `investigation` summarizes workflow-authored evidence-gathering steps.
- `analysis`, `finding_summary`, and `recommendation` are LLM-authored explanation fields.
- `explanation_validation` reports whether explanation fields were valid, degraded, or unavailable.
- `decision` is the authoritative bounded operational result.
- `mitigation_control` records catalog match, policy reason, dry-run, staged or blocked state, audit event, and verification outcome.
- `safety`, `provenance`, and `scorecard` derive from the validated decision and deterministic mitigation governance.

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

The provider response is never trusted directly. Local validation checks JSON shape, taxonomy values, confidence, and cited evidence IDs before the workflow applies mitigation governance or safety policy.

## Recorded Observability Path

Run recorded Grafana webhook payloads plus Loki-shaped logs through the real webhook handler and workflow:

```bash
npm run triage:recorded
npm run triage:recorded -- --scenario capacity-saturation
npm run triage:recorded -- --scenario bad-deploy-latency --json
```

The recorded path does not start Grafana, Loki, Docker Compose, or a synthetic service. It loads fixtures from `fixtures/grafana/` and `fixtures/logs/`, then exercises webhook normalization, evidence construction, workflow validation, mitigation governance, safety policy, provenance, and scorecard output.

## Failure Discovery Loop

Use the failure review CLI after a meaningful workflow, prompt, or model change. The default catalog runs 24 stable mock and recorded cases without provider credentials:

```bash
npm run review:failures -- generate \
  --change "evidence-ranking-update" \
  --size 24 \
  --batch-id evidence-ranking-v1 \
  --json

npm run review:failures -- list evidence-ranking-v1
npm run review:failures -- show evidence-ranking-v1 \
  'review-run:mock:bad-deploy-latency:baseline'
```

Generated packets live under `.triage/failure-reviews/` and stay out of git. Each run includes the ordered workflow states, investigation steps, evidence, validation result, decision, provenance, mitigation state, safety result, and scorecard. Its matching review file starts as `pending`.

Complete each review as either `acceptable` or `failed`. A failed review records one first upstream failure, its workflow phase, optional investigation step, supporting evidence IDs, rationale, downstream effects, and follow-up disposition. Save the structured review through the CLI so invalid input cannot replace the prior record:

```json
{
  "schemaVersion": 1,
  "reviewId": "review:review-run:mock:bad-deploy-latency:baseline",
  "runId": "review-run:mock:bad-deploy-latency:baseline",
  "disposition": "failed",
  "observation": "The first material defect observed in this run.",
  "firstFailure": {
    "phase": "llm_decision_requested",
    "evidenceIds": ["alert:0", "deploy:0"],
    "rationale": "Why this is the earliest causal failure."
  },
  "downstreamEffects": ["A later recommendation became unreliable."],
  "independentFindings": [],
  "followUpDisposition": "candidate"
}
```

```bash
npm run review:failures -- annotate evidence-ranking-v1 \
  'review-run:mock:bad-deploy-latency:baseline' \
  --input review.json

npm run review:failures -- validate evidence-ranking-v1
npm run review:failures -- summarize evidence-ranking-v1
```

A named failure mode needs a definition, distinguishing notes, and at least two reviewed source runs. Promotion copies only reduced, allowlisted evidence into `evals/failure-cases/` and updates `evals/failure-taxonomy.json`:

```bash
npm run review:failures -- promote evidence-ranking-v1 \
  'review-run:mock:checkout-payment-timeout:unknown-evidence' \
  'review-run:mock:bad-deploy-latency:unknown-evidence' \
  --mode-id unsupported-evidence-citation \
  --name "Unsupported evidence citation" \
  --definition "The decision cites evidence absent from the run." \
  --distinguishing-notes "Use for invalid citations, not weak valid evidence."
```

Uncategorized observations can remain in their local review packet. Promote one as a versioned candidate snapshot only when it is worth preserving:

```bash
npm run review:failures -- promote evidence-ranking-v1 \
  'review-run:mock:noisy-alert:missing-runbook-context' \
  --candidate
```

Regression cases live in `evals/failure-regressions.ts`. Each one names the exact taxonomy revision and promoted source cases that justify it. `npm run evals` validates those references before executing the regression and includes the provenance in the saved eval report.

Live review capture is explicit and optional:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run review:failures -- generate \
  --change "live-provider-check" \
  --size 24 \
  --batch-id live-provider-check \
  --live
```

Live capture requires the normal provider configuration. It still uses synthetic incident scenarios, records provider failures as reviewable outcomes, and never enables production actions. Human findings supplement the deterministic schema, grounding, provenance, mitigation, and safety gates; they do not override them.

### Measured Live Iteration

A September 2026 review cycle turned two observed live-provider patterns into taxonomy entries and deterministic regressions. The final 24-run batch completed all four live scenarios with the expected incident classes and bounded actions, reduced duplicate recommendation action warnings from 4/4 to 0/4, and left one evidence-citation issue as an unpromoted candidate.

Read the [failure discovery case study](docs/failure-discovery-case-study.md) for the batches, fixes, and remaining limitation.

## Human Approval Simulation

Approval-required mitigation responses include a pending `approval_request` with the catalog ID, runbook ID, approve/reject commands, and `executed: false`.

```bash
npm run triage -- run bad-deploy-latency --mock-llm --trace
npm run triage:approval -- request rollback-approval --incident-id INC-2026-015 --service checkout-api --json
npm run triage:approval -- approve rollback-approval --incident-id INC-2026-015 --service checkout-api --json
npm run triage:approval -- status approval:INC-2026-015:rollback-approval --json
npm run triage:approval -- list
```

The approval command persists local approval state in `.triage/approvals.json` by default and records a simulated executor result for approvals. The local server also exposes the same store at `http://127.0.0.1:8080/approvals` with an approval queue, detail view, and approve/reject controls.

The approval CLI and console do not execute rollback, scaling, throttling, ticketing, chat, or production API calls.

## Approval UI Demo

Run the deterministic approval UI demo with recorded Grafana and Loki-shaped inputs:

```bash
npm run approval-demo
```

The demo seeds a pending `bad-deploy-latency` approval, starts the local approval console, and prints:

```text
http://127.0.0.1:8080/approvals
```

Use the live LLM path with the same recorded observability inputs:

```bash
npm run approval-demo -- --live
```

Live mode still uses recorded Grafana and Loki-shaped inputs, but the decision comes from MiniMax through Flue. The approval queue is populated only when the live model returns the bounded approval action, such as `request_rollback_approval`.

For scriptable verification without starting the server:

```bash
npm run approval-demo -- --once --json
```

## Phase 1 Read-Only Canary

Run the signed read-only webhook canary against recorded Grafana and Loki-shaped inputs:

```bash
npm run --silent triage:read-only-canary -- --json
```

The canary starts the local server in `AI_OPERATOR_MODE=read_only`, posts a signed Grafana webhook, verifies the run and evidence snapshot were persisted in the in-memory store, verifies duplicate replay is rejected, verifies approval routes are disabled, and verifies no approval request or staged action appears in the response.

Run the same canary against local Postgres:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://incident_triage:incident_triage@localhost:5432/incident_triage \
npm run --silent triage:read-only-canary -- --postgres --json
```

Use the live LLM boundary with the same recorded observability inputs:

```bash
npm run --silent triage:read-only-canary -- --live --json
```

Live canary mode requires `.env` values for `MINIMAX_API_KEY` and `MODEL_NAME`. It still uses recorded Grafana and Loki-shaped inputs and does not execute production actions.

## Live Provider Path

Create `.env` from `.env.example`:

```text
MINIMAX_API_KEY=replace-with-your-minimax-api-key
MODEL_NAME=MiniMax-M2.7
MINIMAX_BASE_URL=https://api.minimax.io
AI_OPERATOR_MODE=read_only
DATABASE_URL=postgres://incident_triage:incident_triage@localhost:5432/incident_triage
GRAFANA_WEBHOOK_SECRET=replace-with-a-local-webhook-secret
OPERATOR_READ_TOKEN=replace-with-a-local-read-token
LOKI_BASE_URL=http://localhost:3100
LOKI_LIMIT=20
LOKI_TIMEOUT_MS=10000
LOKI_TENANT_ID=
LOKI_BEARER_TOKEN=
```

Run with live MiniMax through Flue:

```bash
npm run triage -- run checkout-payment-timeout --trace
npm run triage:live
```

The real `.env` is ignored by git.

## Webhook Server

Run the local webhook server with mock LLM output:

```bash
AI_OPERATOR_MODE=local npm run serve -- --mock-llm
```

Without a local `.env`, provide a throwaway webhook secret:

```bash
AI_OPERATOR_MODE=local GRAFANA_WEBHOOK_SECRET=local-secret npm run serve -- --mock-llm
```

For the persisted browser demo, use the [Main Demo](#main-demo) path above. It starts Postgres, opens `/runs`, launches `bad-deploy-latency`, and records a simulated approval audit from the review console.

If `OPERATOR_READ_TOKEN` is set while using `/runs`, enter that value in the console and click **Load**. For the local demo script, the token is cleared for the server process so this step is normally unnecessary.

For Phase 1 read-only triage, start Postgres and provide `DATABASE_URL`:

```bash
docker compose up -d postgres
AI_OPERATOR_MODE=read_only \
DATABASE_URL=postgres://incident_triage:incident_triage@localhost:5432/incident_triage \
GRAFANA_WEBHOOK_SECRET=local-secret \
OPERATOR_READ_TOKEN=local-read-token \
npm run serve -- --mock-llm
```

Read-only mode requires Grafana HMAC headers on webhook requests. Configure Grafana with the shared secret from `GRAFANA_WEBHOOK_SECRET`, the default signature header `X-Grafana-Alerting-Signature`, and timestamp header `X-Grafana-Alerting-Timestamp`. The server verifies `HMAC(timestamp + ":" + raw_body)`, rejects stale timestamps, and rejects duplicate signed payloads when persistence is configured.

Read-only mode disables the approval console/API and suppresses approval-store writes, even when the decision maps to an approval-required mitigation. The older `X-Webhook-Secret` header remains for local/demo mode only.

The server runs the repo-owned SQL migrations at startup when `DATABASE_URL` is set. Persisted read-only review data can be fetched from `GET /api/runs` and `GET /api/runs/:run_id` with `Authorization: Bearer $OPERATOR_READ_TOKEN`; the detail response returns the run envelope and evidence snapshot without exposing approval mutation routes.

Open the read-only operator review console:

```text
http://127.0.0.1:8080/runs
```

The console prompts for `OPERATOR_READ_TOKEN`, stores it in browser session storage, lists retained runs, and loads the selected run review through the authenticated API.

For production-shaped Loki access, the client sends bounded `query_range` requests using service labels, alert start/end timestamps, limit, direction, timeout, optional `X-Scope-OrgID` tenant header, and optional bearer auth. Returned log lines are redacted for common token/email patterns before they become evidence.

Open the approval console:

```text
http://127.0.0.1:8080/approvals
```

Post a recorded approval-generating Grafana payload:

```bash
curl -s http://127.0.0.1:8080/webhooks/grafana \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: local-secret' \
  --data @fixtures/grafana/bad-deploy-latency-webhook.json
```

Real webhook mode expects real Grafana and Loki. The approval demo is the safer portfolio path because it uses recorded inputs while exercising the same webhook handler, workflow, approval store, and console.

## Verification

Run the full local verification path:

```bash
npm test
npm run test:e2e
npm run --silent triage:read-only-canary -- --json
npm run typecheck
npm run build
npm run evals
git diff --check
```

Default tests avoid real MiniMax calls, Docker, and networked Loki. They exercise parser, evidence, workflow, policy, scoring, CLI, Grafana, Loki-shaped log replay, webhook, and outcome code paths with fixture payloads and mock external transports.

Postgres integration tests are opt-in:

```bash
docker compose up -d postgres
POSTGRES_TEST_DATABASE_URL=postgres://incident_triage:incident_triage@localhost:5432/incident_triage npm run test:postgres
```

Deterministic evals cover scenario contracts, evidence citations, provenance, safety behavior, mitigation governance, recorded-triage readability, and provenance-linked failure regressions. Live evals are opt-in:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run evals
```

## Docker

Start local Postgres for persistence development:

```bash
docker compose up -d postgres
```

Build the local image:

```bash
docker build -t incident-triage-agent:local .
```

Run the deterministic path:

```bash
docker run --rm incident-triage-agent:local run checkout-payment-timeout --mock-llm --trace
```

Run the live provider path:

```bash
docker run --rm --env-file .env incident-triage-agent:local run checkout-payment-timeout --trace
```

## Why Actions Are Simulated

Incident response actions can affect customers. This prototype stages approval-sensitive actions and prints mitigation-control audit payloads, but it does not call deployment, ticketing, chat, or production observability systems. Simulated dry-runs and verification outcomes are recorded-fixture proof, not production execution. That keeps the architecture inspectable without creating production blast radius.
