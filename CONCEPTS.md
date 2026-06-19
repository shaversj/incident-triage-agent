# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Incident Triage Domain

### Raw Incident Fixture
Synthetic incident input that contains operational facts but not derived answers, recommendations, or approval hints.

### Triage Workflow
The governed process that gathers incident context, asks for a bounded model judgment, validates the result, applies safety policy, and scores the run.

### Evidence Package
The traceable bundle of incident context assembled from operational sources before the model is asked to decide.

### Source Tier
A trust category assigned to evidence so the workflow can distinguish live incident signals, operational context, guidance, and historical context.

### Provenance Summary
A compact explanation of which evidence sources shaped a triage result, how strong those sources are, and which context is missing.

### Grafana Webhook Ingestion
A local observability integration surface that accepts Grafana alert payloads as raw alert facts for the triage workflow.

### Loki Log Lookup
The bounded log-enrichment step that queries Loki for service-specific logs around an alert window and converts results into operational evidence.

### Integration E2E
A Docker-backed test path that exercises external-system-shaped inputs while still using synthetic alerts, logs, and services.

### Synthetic Incident Service
A local fake service that handles real test requests and generates incident-shaped logs for the triage workflow.

### Live Provider E2E
An opt-in E2E path that calls the real LLM provider while still using synthetic local incident data and no remediation authority.

### Outcome-Based Test Suite
A contract-focused test layer that verifies the operator-facing triage result: bounded decision, evidence citations, provenance support, safety behavior, and recoverable failure handling.

### Agentic Run Envelope
The outer triage result shape that makes a run look and read like an investigation while preserving the bounded decision as the authoritative operational contract.

### Investigation Step
A workflow-authored record of evidence-gathering work that actually happened, such as inspecting alerts, querying logs, checking deploys, loading runbooks, or collecting verification signals.

### Explanation Layer
The non-authoritative LLM-authored material around a bounded decision, such as evidence-grounded hypotheses, finding summary, and recommendation rationale.

### Bounded Decision
An LLM judgment constrained to the project's allowed incident classes and next actions, with confidence, evidence citations, caveats, and verification steps.

### Safety Gate
The deterministic policy step that decides whether a bounded decision is safe to present, requires approval, needs human input, or is unsupported.

### Scorecard
The deterministic evaluation result that records whether a triage run satisfied state, grounding, safety, classification, and next-action expectations.

## Relationships

A Raw Incident Fixture or Grafana Webhook Ingestion payload is transformed into an Evidence Package. A Synthetic Incident Service can generate logs that Loki Log Lookup adds as operational evidence. Evidence carries a Source Tier so the Provenance Summary can explain the quality of the cited context. The Triage Workflow can record Investigation Steps inside an Agentic Run Envelope, ask for an Explanation Layer and Bounded Decision using that evidence, then pass the decision through the Safety Gate before producing a Scorecard, Outcome-Based Test Suite result, Integration E2E assertions, or Live Provider E2E assertions.
