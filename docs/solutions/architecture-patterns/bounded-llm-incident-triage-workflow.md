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

The observability integration variant keeps the same center:

```text
Grafana webhook -> raw incident normalization -> Loki log lookup
  -> evidence package -> LLM decision -> validation -> safety gate
```

The stronger local E2E variant adds a synthetic service before Loki:

```text
synthetic checkout request -> service-generated Loki logs -> Grafana webhook
  -> Loki log lookup -> evidence package -> LLM decision -> validation -> safety gate
```

The workflow should own:

- Context gathering through tool-like boundaries.
- The allowed incident class and next action vocabulary.
- Response parsing and local validation.
- State transitions and terminal states.
- Safety policy for approval-sensitive actions.
- Deterministic scorecards.

The LLM should own one bounded judgment:

- Choose one incident class from the allowed taxonomy.
- Choose one next action from the allowed taxonomy.
- Cite evidence IDs.
- Provide confidence, caveats, and a verification plan.

Provider output should never be trusted directly. In this project, the adapter extracts text from the Anthropic-compatible MiniMax response, strips optional JSON fences, parses the candidate object, and validates taxonomy values, confidence, and cited evidence IDs before the workflow can transition past the decision boundary.

Safety belongs outside the prompt. Rollback-like or runbook-action recommendations are staged as approval-required payloads and audit events. Missing critical context moves the run to human input instead of letting a fluent answer masquerade as a safe action.

The same architecture should be runnable through the normal local and container paths. Here, `uv run triage ...` and the Docker image both exercise the same package entrypoint, so local demos, tests, and container demos do not drift into separate execution paths.

When adding observability integrations, preserve the same separation. Grafana webhook payloads should be normalized into raw alert facts, and Loki query results should become operational evidence. Neither source should carry expected incident classes, next actions, suspected causes, or approval hints into the model prompt.

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

```python
PROHIBITED_INCIDENT_FIELDS = {"suspected_causes", "recommended_actions", "requires_approval"}
```

The workflow validates the model result before applying safety policy:

```python
run.validation = self.llm_client.decide(run.evidence_package)

if not run.validation.valid or not run.validation.decision:
    run.transition(WorkflowState.RECOVERABLE_FAILURE)
    run.transition(WorkflowState.SCORED)
    run.scorecard = score_run(run)
    return run

run.transition(WorkflowState.DECISION_VALIDATED)
run.safety = evaluate_safety(run.validation.decision, run.evidence_package)
```

Approval-sensitive recommendations are staged, not executed:

```python
if decision.next_action in APPROVAL_REQUIRED_ACTIONS:
    staged_payload = build_staged_payload(decision, evidence_package)
    return SafetyResult(
        status=SafetyStatus.APPROVAL_REQUIRED.value,
        approval_required=True,
        staged_payload=staged_payload,
        audit_event={
            "event": "simulated_action_staged",
            "incident_id": evidence_package.incident.incident_id,
            "next_action": decision.next_action.value,
            "executed": False,
        },
    )
```

A good verification pass exercises both the local and container paths:

```bash
uv run triage list
uv run python -m unittest discover -s tests
docker build -t incident-triage-agent:local .
docker run --rm incident-triage-agent:local run checkout-payment-timeout --mock-llm --trace
RUN_DOCKER_E2E=1 uv run python -m unittest tests/test_e2e_grafana_loki.py
```

The live provider E2E should remain opt-in:

```bash
RUN_LIVE_LLM_E2E=1 uv run python -m unittest tests/test_e2e_real_service_live_llm.py
```

Use this only when provider credentials, spend, network dependency, and model variance are acceptable for the validation pass.

## Related

- [README.md](../../../README.md)
- [Incident Triage Agent Requirements](../../brainstorms/2026-06-14-incident-triage-agent-requirements.md)
- [Incident Triage Agent Plan](../../plans/2026-06-14-001-feat-incident-triage-agent-plan.md)
