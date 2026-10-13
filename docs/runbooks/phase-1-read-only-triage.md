# Phase 1 Read-Only Triage Runbook

Use this runbook when operating the project in `AI_OPERATOR_MODE=read_only`.

## Purpose

Phase 1 proves the AI Operator can process production-shaped alerts and logs without creating approval records or executing actions.

Read-only mode may:

- Accept signed Grafana webhook notifications.
- Query bounded Loki logs for the affected service and alert window.
- Load service ownership and runbook evidence through adapter boundaries.
- Compare fresh evidence with the latest retained run and suppress semantically equivalent updates.
- Ask the LLM for one bounded judgment.
- Validate, score, persist, and return the run envelope.
- Record authenticated operator verification, lifecycle events, recovery budgets, and reduced review candidates.

Read-only mode must not:

- Emit approval requests.
- Emit staged actions.
- Transition to `approval_pending` or `simulated_action_recorded`.
- Write approval-store records.
- Execute production actions.
- Serve approval UI/API routes.

## Required Configuration

```text
AI_OPERATOR_MODE=read_only
GRAFANA_WEBHOOK_SECRET=<shared-hmac-secret>
LOKI_BASE_URL=<loki-url>
LOKI_LIMIT=20
LOKI_TIMEOUT_MS=10000
DATABASE_URL=<postgres-url>
OPERATOR_READ_TOKEN=<read-token>
OPERATOR_WRITE_TOKEN=<distinct-write-token>
```

Optional Loki settings:

```text
LOKI_TENANT_ID=<tenant>
LOKI_BEARER_TOKEN=<token>
```

## Grafana HMAC Setup

Configure Grafana webhook HMAC signing with:

- Signature header: `X-Grafana-Alerting-Signature`
- Timestamp header: `X-Grafana-Alerting-Timestamp`
- Secret: same value as `GRAFANA_WEBHOOK_SECRET`

The server verifies the raw request body using `HMAC(timestamp + ":" + body)`, rejects stale timestamps, and rejects duplicate signed payloads when persistence is configured.

## Local Persistence

Start local Postgres:

```bash
docker compose up -d postgres
```

The server runs SQL migrations at startup when `DATABASE_URL` is set.

Incident reviewers should inspect:

- `incident_runs`: run envelope, incident ID, service, validation status, safety status, mitigation status, evidence IDs, scorecard, retention class, and correlation ID.
- `evidence_snapshots`: evidence available to the model at decision time.
- `replay_keys`: signed webhook replay claims and expiry.
- `evidence_gate_decisions`: first-observation, material, and suppressed decisions with bounded delta summaries and run lineage.
- `incident_verification_events`: independent resolved, unresolved, and inconclusive evidence.
- `incident_recovery_budgets` and `incident_recovery_events`: per-class counters and append-only attempt/reset history.
- `outcome_review_candidates`: reduced pending or imported inputs to failure review.

## Re-entry Outcomes

Every accepted firing notification reaches the re-entry gate after evidence collection:

- `200` with `trigger: first_observation` establishes a baseline and runs full triage.
- `200` with `trigger: material_evidence` creates a complete child run linked through `parent_run_id`.
- `202` with `reason: non_material_evidence` records the decision but creates no run.

Exact signed-request replays still return `409` before evidence comparison. A materiality classifier is used only for deltas that deterministic policy cannot resolve. Invalid or unavailable classifier output is recorded as `classifier_fallback` and reruns triage rather than suppressing evidence.

Open `/runs` and inspect **Evidence Re-entry** for the selected run's trigger, parent, basis, rationale, delta summary, and recent suppressed updates.

## Closure And Recovery

Use the **Incident Lifecycle** panel or `npm run triage:lifecycle` to record independent verification. Approval, recommendation, and simulated execution never set `resolved`. `inconclusive` waits for more evidence. `unresolved` stays open and creates a pending review candidate.

Recovery state is isolated by failure class and stops after three attempts. Reset only the affected class with authenticated operator intent or a material-evidence decision. Candidate import remains a human review operation and cannot activate taxonomy or regression changes by itself.

## Canary

Run the deterministic read-only canary:

```bash
npm run triage:read-only-canary -- --json
```

The canary must report:

- `persisted_run: true`
- `persisted_evidence_snapshot: true`
- `first_observation_recorded: true`
- `semantic_duplicate_suppressed: true`
- `material_child_recorded: true`
- `gate_decision_history_recorded: true`
- `incident_run_count_correct: true`
- `replay_rejected: true`
- `approval_routes_disabled: true`
- `approval_artifacts_absent: true`

## Retention And Redaction

Phase 1 persistence records retention classes and expiry timestamps. Cleanup removes expired runs, evidence snapshots, gate decisions, lifecycle events, budgets, review candidates, and replay keys. A retained child can still explain its prior-run identifier from the gate decision after the parent expires.

The incident coordinator is process-local. Run one read-only server process for this phase; add a durable incident-head or lease before horizontally scaling ingestion.

Logs are redacted for common token/email patterns before becoming evidence. Persisted records must not include webhook secrets, provider keys, auth headers, or raw sensitive operational data.
