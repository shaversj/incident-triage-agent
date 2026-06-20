# AGENTS.md

## Project Overview

This repo is a TypeScript proof of concept for a bounded LLM-assisted incident triage agent.

The important architectural idea is that the workflow owns control flow, factual investigation steps, and safety, while the LLM owns evidence-grounded explanation plus one bounded judgment. Raw incident facts are converted into an evidence package, the local `incident-triage` skill returns an explanation layer and nested bounded decision from a fixed taxonomy through MiniMax, local validation checks the result, policy gates risky actions, and the CLI/server emit provenance plus scorecard output.

Core flow:

```text
raw incident data -> evidence package + investigation trace
  -> incident-triage skill -> structured result validation
  -> explanation validation -> evidence citation validation
  -> safety gate -> operator output -> scorecard
```

The `incident-triage` skill should make its bounded judgment by following a human SRE-style investigation order: current signal, impact, recent changes, dependency-vs-local evidence, evidence quality, missing context, bounded next action, and verification.

Primary TypeScript code lives in `src/`:

- `cli.ts`: command-line interface.
- `config.ts`: `.env` loading for MiniMax and webhook config.
- `domain.ts`: taxonomy, fixture loading, and raw incident validation.
- `evidence.ts`: deterministic SRE context tools and evidence package construction.
- `grafana.ts`: Grafana webhook payload normalization into raw incidents.
- `loki.ts`: bounded Loki query client and log evidence conversion.
- `llm.ts`: Flue-backed MiniMax decision adapter and decision validation.
- `policy.ts`: safety gate and simulated approval handling.
- `recorded-observability.ts`: recorded Loki-shaped log replay for local demos and integration tests.
- `scoring.ts`: deterministic eval scorecard.
- `server.ts`: local Grafana webhook server and JSON response rendering.
- `workflow.ts`: triage state machine.
- `workflows/incident-triage.ts`: discovered Flue workflow boundary for the local `incident-triage` skill.

## Quick Start

Use Node.js 22 or newer.

```bash
npm install
npm test
npm run typecheck
npm run list
npm run triage -- run checkout-payment-timeout --mock-llm --trace
```

Create a local `.env` from `.env.example` for live MiniMax and webhook tests. The real `.env` is ignored by git and must stay untracked.

Run the real MiniMax path:

```bash
npm run triage -- run checkout-payment-timeout --trace
```

Run the webhook server locally with mock LLM output:

```bash
npm run serve -- --mock-llm
```

Run the recorded observability demo:

```bash
npm run demo
npm run demo -- --scenario capacity-saturation
npm run demo-live
```

Useful verification before handing off changes:

```bash
npm test
npm run evals
npm run typecheck
git diff --check
```

## Hard Constraints

- Never commit `.env`, API keys, provider secrets, or real credentials.
- Do not print secret values in CLI output, test failures, logs, docs, or exceptions.
- Keep fixtures raw. Scenario incident data must not contain `suspected_causes`, `recommended_actions`, or `requires_approval`.
- Keep Grafana webhook ingestion raw. Alert labels and annotations may become facts, but they must not become suspected causes, recommended actions, or eval expectations.
- Keep bad-deploy webhook evidence raw. Deployment facts belong in deploy evidence fixtures or real deploy sources, not rollback hints inside Grafana annotations.
- Keep Loki lookup bounded by service labels, time window, and result limit before prompt assembly.
- Keep webhook secrets out of output and logs. Use `X-Webhook-Secret` only as an auth boundary, never as evidence.
- Do not let LLM output drive workflow state until local validation passes.
- Treat workflow-authored investigation steps as factual trace data. Do not let the LLM claim it called tools or gathered evidence.
- Treat LLM-authored hypotheses, finding summaries, and recommendation rationales as non-authoritative explanation. They can be dropped or degraded without blocking a valid bounded decision.
- Do not let `recommendation` introduce its own action field. The only action that can drive safety is `decision.next_action`.
- Keep the incident class taxonomy bounded to `dependency_outage`, `bad_deploy`, `capacity_saturation`, `noisy_alert`, `insufficient_context`, and `unknown`.
- Keep the next action taxonomy bounded to `escalate_owner`, `request_rollback_approval`, `apply_runbook_step_with_approval`, `continue_monitoring`, `ask_human`, and `gather_more_context`.
- Approval-sensitive actions must be staged and audited, not executed.
- The scorecard must remain deterministic. Do not use the LLM to grade its own run.
- Outcome tests should assert the operator-facing contract: bounded decisions, evidence citations, investigation envelope, explanation validation, provenance support, safety behavior, and recoverable failure handling.
- Preserve stable evidence IDs when changing mock tools or fixtures.
- Tests must not require real MiniMax credentials or network access.
- Recorded observability tests should replay Grafana webhook payloads and Loki-shaped logs through real handler and workflow code.
- The default suite must not start Docker, Grafana, Loki, or a synthetic service.
- Flue evals must remain separate from the default test suite. Use them for prompt, skill, and model behavior drift, not for deterministic safety enforcement.
- Live Flue/MiniMax evals must require `RUN_LIVE_FLUE_EVALS=1`.
- Eval expectations must live in eval cases, not in raw incident fixtures or Grafana payloads.
- Judge-based evals may score explanation quality, but schema validity, citation validity, provenance, and safety gates must remain deterministic assertions.
- Recorded log fixtures may contain timestamps, labels, and raw log lines, but must not contain expected classes, next actions, rollback hints, or eval expectations.
- Use `npm test`, `npm run typecheck`, and `npm run triage -- ...` for local verification.
- Use Docker only for local image packaging unless a future plan reintroduces a connector smoke test.
- Use the Anthropic-compatible MiniMax endpoint through the adapter boundary. Do not scatter direct provider calls through workflow code.
- Keep the CLI trace as a product surface: it should distinguish raw facts, gathered evidence, LLM output, validation, safety gating, and scorecard results.
- Keep diagnostic logs on stderr so stdout remains usable for the triage report.
- When changing library, SDK, API, CLI, framework, or cloud-service usage, fetch current docs with `ctx7` first as described by the repo instructions.

## Testing Convention

- Write tests that call actual functions, HTTP handlers, scripts, or recorded-input replay paths and verify returned behavior.
- Use realistic payload fixtures from `fixtures/` for incident, Grafana, runbook, deploy, service, and prior-incident data.
- Prefer focused integration or outcome tests over many narrow object-shape tests.
- Verify parsing, validation, error handling, request/response contracts, evidence citations, provenance, safety behavior, and recoverable failure modes.
- When mocking, mock only unstable external boundaries such as the LLM provider, Loki transport, Docker availability, or live credentials; keep the parser, workflow, policy, scoring, and response-rendering paths real.
- Do not add tests that only instantiate local objects and assert the values they were constructed with.
- Avoid brittle hardcoded string checks unless the string is a public contract, a stable evidence ID, a safety/security guarantee, or a required operator-facing message.
- Live-provider tests must remain opt-in, but when enabled they should fail or skip explicitly instead of silently passing without exercising a scenario.
- More tests are not automatically better. Bias toward fewer tests that prove meaningful behavior across real code paths.

## Topic Docs

- [README.md](README.md): project walkthrough, commands, scenarios, decision contract, and testing notes.
- [docs/learnings.md](docs/learnings.md): running teaching checklist and session learnings.
- [CONCEPTS.md](CONCEPTS.md): shared domain vocabulary.
- [docs/solutions/](docs/solutions/): searchable solution learnings from past problems and decisions.
- [.agents/skills/incident-triage/SKILL.md](.agents/skills/incident-triage/SKILL.md): incident-triage skill boundary discovered by Flue.
- [fixtures/scenarios/](fixtures/scenarios/): raw incident scenarios.
- [fixtures/runbooks/](fixtures/runbooks/): runbook grounding context.
- [fixtures/deploys/deploys.json](fixtures/deploys/deploys.json): mock deploy facts used by webhook evidence construction.
- [fixtures/services/services.json](fixtures/services/services.json): mock service ownership metadata.
- [fixtures/prior_incidents/prior-incidents.json](fixtures/prior_incidents/prior-incidents.json): mock prior incident context.
- [fixtures/grafana/](fixtures/grafana/): synthetic Grafana webhook payloads.
- [fixtures/logs/](fixtures/logs/): recorded Loki-shaped log fixtures for local demos and integration tests.
- [evals/](evals/): Flue eval suites for deterministic contracts, opt-in live drift checks, and explanation-quality scoring.
- [tests/support/outcomes.ts](tests/support/outcomes.ts): shared outcome assertions for workflow, webhook, recorded integration, and live-provider tests.
- [tests/observability-integration.test.ts](tests/observability-integration.test.ts): recorded Grafana/Loki-shaped integration matrix.
- [scripts/run-recorded-triage-demo.ts](scripts/run-recorded-triage-demo.ts): one-command recorded observability demo.
- [docs/examples/recorded-demo-response.json](docs/examples/recorded-demo-response.json): sanitized example of recorded observability demo output.
