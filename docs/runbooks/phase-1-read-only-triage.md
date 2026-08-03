# Phase 1 Read-Only Triage Runbook

Use this runbook when operating the project in `AI_OPERATOR_MODE=read_only`.

## Purpose

Phase 1 proves the AI Operator can process production-shaped alerts and logs without creating approval records or executing actions.

Read-only mode may:

- Accept signed Grafana webhook notifications.
- Query bounded Loki logs for the affected service and alert window.
- Load service ownership and runbook evidence through adapter boundaries.
- Ask the LLM for one bounded judgment.
- Validate, score, persist, and return the run envelope.

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

## Canary

Run the deterministic read-only canary:

```bash
npm run triage:read-only-canary -- --json
```

The canary must report:

- `persisted_run: true`
- `persisted_evidence_snapshot: true`
- `replay_rejected: true`
- `approval_routes_disabled: true`
- `approval_artifacts_absent: true`

## Retention And Redaction

Phase 1 persistence records retention classes and expiry timestamps. Expired evidence snapshots and replay keys can be cleaned up through the persistence store cleanup path while preserving the run envelope.

Logs are redacted for common token/email patterns before becoming evidence. Persisted records must not include webhook secrets, provider keys, auth headers, or raw sensitive operational data.
