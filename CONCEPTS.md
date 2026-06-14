# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Incident Triage Domain

### Raw Incident Fixture
Synthetic incident input that contains operational facts but not derived answers, recommendations, or approval hints.

### Triage Workflow
The governed process that gathers incident context, asks for a bounded model judgment, validates the result, applies safety policy, and scores the run.

### Evidence Package
The traceable bundle of incident context assembled from operational sources before the model is asked to decide.

### Bounded Decision
An LLM judgment constrained to the project's allowed incident classes and next actions, with confidence, evidence citations, caveats, and verification steps.

### Safety Gate
The deterministic policy step that decides whether a bounded decision is safe to present, requires approval, needs human input, or is unsupported.

### Scorecard
The deterministic evaluation result that records whether a triage run satisfied state, grounding, safety, classification, and next-action expectations.

## Relationships

A Raw Incident Fixture is transformed into an Evidence Package. The Triage Workflow asks for a Bounded Decision using that evidence, then passes the decision through the Safety Gate before producing a Scorecard.
