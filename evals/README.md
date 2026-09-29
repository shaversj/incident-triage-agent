# Flue Evals

This directory contains `vitest-evals` suites for incident-triage behavior.

Use evals to compare prompt, model, or skill behavior over representative incidents. Do not use them as a replacement for deterministic validation, safety policy, provenance checks, or the default Vitest suite.

## Commands

Run deterministic evals:

```bash
npm run evals
```

Run the Phase 1 read-only canary:

```bash
npm run triage:read-only-canary -- --json
```

Write a JSON report:

```bash
npm run evals:json
```

Open saved reports in the local eval UI:

```bash
npm run evals:ui
```

Run live MiniMax evals through the Flue skill boundary:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run evals
```

Live evals require `.env` values for `MINIMAX_API_KEY` and `MODEL_NAME`.

The read-only canary also supports `--live`; it still uses recorded Grafana and Loki-shaped inputs, and it keeps production mutation paths disabled.

## Eval Layers

- `incident-outcomes.eval.ts` checks deterministic scenario contracts: bounded decisions, citation validity, provenance, safety, recoverable failures, and weak historical-only support.
- `recorded-triage-quality.eval.ts` checks recorded-triage quality gates as regression contracts: `schema_contract`, `evidence_grounding`, `provenance_support`, `safety_contract`, `mitigation_contract`, and `recorded_triage_readability`.
- `live-incident-triage.eval.ts` is opt-in and checks broad live-provider contracts without asserting exact model wording, including required evidence prefixes when available.
- `recommendation-quality.eval.ts` records a transparent judge score for explanation quality. It is a capability diagnostic, not the primary regression signal.
- `failure-regressions.eval.ts` executes protections promoted from reviewed traces and emits their failure-mode revision plus source-case provenance in eval metadata.

## Failure Review Artifacts

`npm run review:failures -- generate` creates local review batches under `.triage/failure-reviews/`. Those packets are working material and must not be committed. They contain complete run traces plus editable review records so an SRE can identify the first upstream failure without labeling every downstream symptom.

Promotion is the durability boundary:

- `failure-taxonomy.json` stores versioned active and retired failure-mode definitions.
- `failure-cases/` stores reduced, immutable source snapshots selected from reviewed runs.
- `failure-regressions.ts` stores executable case-specific assertions with links to a taxonomy revision and its promoted evidence.
- `failure-regressions.eval.ts` validates the registry before running and writes the provenance to eval reports.

A named active failure mode requires at least two promoted source examples. One-off observations may remain uncategorized in the local batch or be preserved as a candidate snapshot without receiving a named taxonomy assignment. Revising or retiring a mode adds a new revision; it does not rewrite the revision used by older reviews or regressions.

The review loop is qualitative discovery. Existing deterministic gates remain authoritative and continue to run independently. Do not turn review annotations into fixture expectations or let them bypass schema, evidence, safety, provenance, or mitigation checks.

## Quality Gates

Recorded triage quality gates are deterministic pass/fail checks. They should normally stay at 100% because they define the minimum acceptable representative run.

- `schema_contract`: the response completed with a valid bounded decision.
- `evidence_grounding`: decision, recommendation, and hypothesis evidence IDs cite known evidence.
- `provenance_support`: cited tiers, cited sources, cited evidence IDs, and support are present.
- `safety_contract`: safety status is present and no action was executed.
- `mitigation_contract`: mitigation control status, verification, catalog/staged fields, and non-execution guarantees are present.
- `recorded_triage_readability`: `finding_summary`, `recommendation.rationale`, and a non-empty verification plan are present.

The suite includes a known-good reference response to prove the gates are passable, plus targeted negative cases to show each gate fails for the right reason. When a quality gate fails, inspect the response context and gate reasons before assuming the model is wrong; the grader may be too strict or the task may be ambiguous.

## Rules

- Keep expected outcomes in eval cases, not in raw incident fixtures or Grafana payloads.
- Keep live evals opt-in because provider behavior, latency, and cost can vary.
- Keep judges focused on soft qualities such as summary clarity, recommendation usefulness, caveat specificity, and verification-plan actionability.
- Keep schema validity, evidence IDs, provenance, mitigation governance, safety, and recorded-triage readability as deterministic assertions.
- Keep raw review batches under `.triage/`; commit only curated taxonomy entries, promoted snapshots, and executable regressions.
- Keep regression assertions case-specific. Do not replace them with a generic assertion DSL.
- Preserve failure-mode revision and source-case links in saved eval metadata.
