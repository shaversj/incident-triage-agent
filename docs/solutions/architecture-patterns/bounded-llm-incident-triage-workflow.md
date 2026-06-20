---
title: Bounded LLM Incident Triage Workflow
date: 2026-06-14
category: architecture-patterns
module: incident triage agent
problem_type: architecture_pattern
component: assistant
severity: medium
applies_when:
  - Building an LLM-assisted operational workflow where recommendations can affect reliability or customer impact
  - Turning raw operational context into a constrained decision without granting the model open-ended control flow
  - Demonstrating incident automation safely with mock data before production integrations exist
tags: [llm, incident-triage, sre, safety-gates, evidence-grounding, scorecards]
---

# Bounded LLM Incident Triage Workflow

## Context

The incident triage agent needed to prove more than "an LLM can summarize an incident." The useful question was whether an LLM can make a bounded, inspectable triage judgment from raw incident-related evidence while deterministic software controls state, validation, safety, and evaluation.

The project deliberately avoided pre-enriched fixture fields such as suspected causes, recommended actions, or approval hints. That kept the proof honest: the workflow had to gather evidence, the model had to infer from that evidence, and the surrounding system had to decide whether the result was usable.

Session history note: the session-history search found only the current Codex session for this repo and topic, so no prior-session findings were incorporated.

## Guidance

Use the LLM as one reasoning step inside a deterministic incident workflow, not as the workflow itself.

The reusable shape is:

```text
raw fixture -> mock tools -> evidence package -> LLM decision
  -> local validation -> safety gate -> verification plan -> scorecard
```

The recorded observability integration variant keeps the same center:

```text
recorded Grafana webhook -> raw incident normalization -> recorded Loki-shaped logs
  -> evidence package -> LLM decision -> validation -> safety gate
```

The observability scenario matrix should exercise more than one alert shape without weakening the raw-data boundary:

- Checkout dependency outage can use alert, log, and runbook facts.
- Capacity saturation can use alert, log, service, and runbook facts with approval-gated runbook action.
- Bad deploy should add deploy evidence as operational context rather than hiding rollback recommendations in Grafana annotations.

The workflow should own:

- Context gathering through tool-like boundaries.
- The allowed incident class and next action vocabulary.
- Response parsing and local validation.
- State transitions and terminal states.
- Safety policy for approval-sensitive actions.
- Deterministic scorecards.
- Outcome tests that verify the operator-facing contract across fixture, webhook, recorded observability, and live-provider paths.

The LLM should own one bounded judgment:

- Choose one incident class from the allowed taxonomy.
- Choose one next action from the allowed taxonomy.
- Cite evidence IDs.
- Provide confidence, caveats, and a verification plan.

Provider output should never be trusted directly. In this project, the adapter extracts text from the Anthropic-compatible MiniMax response, strips optional JSON fences, parses the candidate object, and validates taxonomy values, confidence, and cited evidence IDs before the workflow can transition past the decision boundary.

Safety belongs outside the prompt. Rollback-like or runbook-action recommendations are staged as approval-required payloads and audit events. Missing critical context moves the run to human input instead of letting a fluent answer masquerade as a safe action.

The same architecture should be runnable through the normal local and container paths. Here, `npm run triage -- ...`, `npm run demo`, and the Docker image all exercise the same TypeScript boundaries, so local demos, tests, and container demos do not drift into separate execution paths.

When adding observability integrations, preserve the same separation. Grafana webhook payloads should be normalized into raw alert facts, and Loki query results or recorded Loki-shaped logs should become operational evidence. Neither source should carry expected incident classes, next actions, suspected causes, or approval hints into the model prompt.

If a webhook scenario needs deterministic routing because multiple alert shapes use the same service, use neutral test metadata such as a scenario label for mock selection only. Do not treat that label as evidence for the incident class.

## Why This Matters

Incident response is high-context and risk-sensitive. A model can help reason across alerts, logs, deploys, runbooks, owners, prior incidents, and verification signals, but it can also hallucinate, overstate confidence, cite nonexistent evidence, or recommend an unsafe operational action.

The architecture matters because it separates reasoning from authority:

- The LLM can classify and recommend.
- The workflow validates whether that recommendation is structurally and semantically usable.
- The policy layer decides whether the recommendation can be shown, staged for approval, or must ask a human.
- The scorecard makes success and failure visible after every run.

That separation makes the proof of concept safer and more honest. A successful run is not only a nice incident narrative; it is a trace showing which component made which decision and where the system would have stopped if the model produced invalid or unsafe output.

## When to Apply

- When building an agentic SRE or operations assistant where actions may affect production reliability.
- When model decisions need to be routed, scored, audited, or gated.
- When mock data should preserve the shape of future real integrations without creating production blast radius.
- When a demo needs to prove architecture quality, not just produce polished prose.
- When missing context should be visible as a workflow state rather than hidden inside an answer.

## Examples

The raw incident fixture is intentionally not allowed to contain answer-like fields:

```ts
export const prohibitedIncidentFields = new Set([
  "suspected_causes",
  "recommended_actions",
  "requires_approval",
]);
```

The workflow validates the model result before applying safety policy:

```ts
run.validation = await this.llmClient.decide(run.evidencePackage);

if (!run.validation.valid || !run.validation.decision) {
  this.transition(run, "recoverable_failure");
  this.transition(run, "scored");
  run.scorecard = scoreRun(run);
  return run;
}

this.transition(run, "decision_validated");
run.safety = evaluateSafety(run.validation.decision, run.evidencePackage);
```

Approval-sensitive recommendations are staged, not executed:

```ts
if (approvalRequiredActions.has(decision.nextAction)) {
  const stagedPayload = buildStagedPayload(decision, evidencePackage);
  return {
    status: "approval_required",
    approvalRequired: true,
    reason: "Action requires human approval; simulated payload staged and not executed.",
    stagedPayload,
    auditEvent: {
      event: "simulated_action_staged",
      incidentId: evidencePackage.incident.incidentId,
      nextAction: decision.nextAction,
      executed: false,
    },
  };
}
```

A good verification pass exercises both the local and container paths:

```bash
npm run list
npm test
npm run demo
npm run typecheck
docker build -t incident-triage-agent:local .
docker run --rm incident-triage-agent:local run checkout-payment-timeout --mock-llm --trace
```

The recorded observability integration test should cover the deterministic scenario matrix while still using a mock LLM:

```bash
npm test -- tests/observability-integration.test.ts
```

The live provider path should remain opt-in:

```bash
RUN_LIVE_FLUE_EVALS=1 npm run evals
npm run demo-live
```

Use this only when provider credentials, spend, network dependency, and model variance are acceptable for the validation pass.

Outcome-based tests sit between unit tests and E2E tests. They should assert that a run or webhook response has a bounded decision, cited evidence, source-tier provenance, safe or approval-gated behavior, and recoverable failure handling. They should not assert exact model caveat wording or reimplement scorecard calculations.

Flue evals sit beside the test suite as a drift surface for prompts, skills, and model behavior:

```bash
npm run evals
RUN_LIVE_FLUE_EVALS=1 npm run evals
npm run evals:json
```

Use deterministic eval assertions for schema validity, evidence citations, provenance, safety, and bounded actions. Use judge-style evals only for softer explanation qualities such as finding-summary clarity, recommendation usefulness, caveat specificity, and verification-plan actionability. Expected outcomes still belong in eval cases or tests, never inside raw incident fixtures or Grafana payloads.

## Related

- [README.md](../../../README.md)
- [Incident Triage Agent Requirements](../../brainstorms/2026-06-14-incident-triage-agent-requirements.md)
- [Incident Triage Agent Plan](../../plans/2026-06-14-001-feat-incident-triage-agent-plan.md)
