# Failure Discovery Case Study

## Removing Duplicate Action Authority

The incident triage workflow gives the LLM one bounded decision field: `decision.next_action`. Explanatory fields may justify that action, but they must not create another action-bearing field.

In September 2026, a 24-run live review batch showed that the MiniMax responses were returning `recommendation.next_action` in all four live scenarios. Local validation kept `decision.next_action` authoritative and downgraded the explanation, so no unsafe action reached the mitigation layer. The repeated warning still exposed a contract problem between the model-facing schema and the workflow.

## Method

Each batch used the same 24 cases:

- 17 deterministic mock cases, including malformed output and invalid evidence citations
- 3 recorded Grafana and Loki-shaped scenarios
- 4 live MiniMax scenarios through Flue

A human review marked the first upstream failure in each run. Repeated failures were promoted only after appearing in at least two source runs. Raw review batches stayed under `.triage/`; the repository received only reduced source snapshots, taxonomy entries, and executable regressions.

## What The Runs Found

| Batch | Live runs completed | Duplicate action warnings | Correct live class and action | Review result |
| --- | ---: | ---: | ---: | --- |
| Initial provider baseline | 1/4 | Not comparable | 1/1 completed | Three provider-overload candidates |
| Recovered provider baseline | 4/4 | 4/4 | 4/4 | Four duplicate-action candidates |
| Corrected output schema | 4/4 | 0/4 | 4/4 | 23 acceptable, 1 candidate |

The initial provider batch also exposed three exhausted 529 overload failures. The workflow already failed safely, but it surfaced raw Flue diagnostics. That failure mode produced a separate regression and a stable operator message: `LLM provider is temporarily overloaded after retries; retry triage later.`

## Why Prompt Wording Was Not Enough

The skill already said that `recommendation` must not contain `next_action`. A stronger prompt-only attempt reduced the warning in one batch but did not remove it consistently. A concrete action example also biased one capacity-saturation run toward the example's action.

The model-facing Valibot result schema was the stronger signal. It listed `recommendation.next_action` as an optional field so local validation could warn when it appeared. Flue exposed that schema to the model, which made the unwanted field look valid.

The final change removed `next_action` from the recommendation schema while retaining raw-payload validation as a defensive check. A deterministic regression now proves that even if a mock payload includes the duplicate field, it cannot become workflow authority.

## Result

After the schema correction:

- All four live scenarios completed.
- All four returned the expected incident class and bounded next action.
- All four explanation validations were valid.
- No live response duplicated `next_action` in `recommendation`.
- Safety and mitigation governance remained deterministic.

One capacity-saturation run omitted an `alert:` citation from the authoritative decision. Its classification, action, safety, and mitigation results were correct, but the evidence-grounding gate failed. That observation remains an unpromoted candidate until another independent run shows the same pattern.

## Reproduce The Review

Live capture requires provider configuration and remains non-mutating:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run review:failures -- generate \
  --change "schema-single-action-authority" \
  --size 24 \
  --batch-id schema-single-action-authority \
  --live
```

Run the deterministic protections without provider credentials:

```bash
npm test
npm run evals
```

These results use synthetic incident scenarios. They demonstrate model-boundary validation and eval-driven iteration, not production incident resolution or autonomous remediation.
