# Flue Evals

This directory contains `vitest-evals` suites for incident-triage behavior.

Use evals to compare prompt, model, or skill behavior over representative incidents. Do not use them as a replacement for deterministic validation, safety policy, provenance checks, or the default Vitest suite.

## Commands

Run deterministic evals:

```bash
npm run evals
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

## Eval Layers

- `incident-outcomes.eval.ts` checks deterministic scenario contracts: bounded decisions, citation validity, provenance, safety, recoverable failures, and weak historical-only support.
- `recorded-triage-quality.eval.ts` checks recorded-triage quality gates as regression contracts: `schema_contract`, `evidence_grounding`, `provenance_support`, `safety_contract`, and `recorded_triage_readability`.
- `live-incident-triage.eval.ts` is opt-in and checks broad live-provider contracts without asserting exact model wording.
- `recommendation-quality.eval.ts` records a transparent judge score for explanation quality. It is a capability diagnostic, not the primary regression signal.

## Quality Gates

Recorded triage quality gates are deterministic pass/fail checks. They should normally stay at 100% because they define the minimum acceptable representative run.

- `schema_contract`: the response completed with a valid bounded decision.
- `evidence_grounding`: decision, recommendation, and hypothesis evidence IDs cite known evidence.
- `provenance_support`: cited tiers, cited sources, cited evidence IDs, and support are present.
- `safety_contract`: safety status is present and no action was executed.
- `recorded_triage_readability`: `finding_summary`, `recommendation.rationale`, and a non-empty verification plan are present.

The suite includes a known-good reference response to prove the gates are passable, plus targeted negative cases to show each gate fails for the right reason. When a quality gate fails, inspect the response context and gate reasons before assuming the model is wrong; the grader may be too strict or the task may be ambiguous.

## Rules

- Keep expected outcomes in eval cases, not in raw incident fixtures or Grafana payloads.
- Keep live evals opt-in because provider behavior, latency, and cost can vary.
- Keep judges focused on soft qualities such as summary clarity, recommendation usefulness, caveat specificity, and verification-plan actionability.
- Keep schema validity, evidence IDs, provenance, safety, and recorded-triage readability as deterministic assertions.
