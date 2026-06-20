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
- `live-incident-triage.eval.ts` is opt-in and checks broad live-provider contracts without asserting exact model wording.
- `recommendation-quality.eval.ts` records a transparent judge score for explanation quality. It does not replace hard safety or citation assertions.

## Rules

- Keep expected outcomes in eval cases, not in raw incident fixtures or Grafana payloads.
- Keep live evals opt-in because provider behavior, latency, and cost can vary.
- Keep judges focused on soft qualities such as summary clarity, recommendation usefulness, caveat specificity, and verification-plan actionability.
- Keep schema validity, evidence IDs, provenance, and safety gates as deterministic assertions.
