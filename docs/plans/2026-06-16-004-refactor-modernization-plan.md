---
title: "refactor: Modernize incident triage codebase"
type: refactor
date: 2026-06-16
---

# refactor: Modernize incident triage codebase

## Summary

Modernize the codebase through behavior-preserving refactor passes. The work should first remove local/dead artifacts, then consolidate duplicated Docker E2E and live-probe orchestration, then split oversized modules along existing boundaries without changing the CLI, webhook, evidence, safety, or LLM decision contracts.

---

## Problem Frame

The project has grown from a small fixture CLI into a multi-surface proof of concept: fixture runs, Grafana webhook ingestion, Loki evidence lookup, synthetic service logs, Docker E2E, live MiniMax E2E, and a live demo probe. That growth is healthy, but some code now carries more responsibility than one module should.

The main slowing factors are:

- `src/incident_triage_agent/cli.py` mixes parser setup, command orchestration, mock LLM fixtures, and terminal rendering.
- `src/incident_triage_agent/grafana.py` and `src/incident_triage_agent/llm.py` are large enough that parsing, validation, normalization, and provider transport are harder to review independently.
- `tests/test_e2e_grafana_loki.py`, `tests/test_e2e_real_service_live_llm.py`, and `scripts/run_live_e2e_probe.py` duplicate Compose startup, readiness polling, checkout generation, Grafana payload mutation, and HTTP posting.
- `scripts/seed_loki_logs.py` is now legacy-adjacent because the preferred E2E path generates logs through `services/synthetic_checkout_service.py`.
- Local ignored artifacts exist under `src/incident_triage_agent/`, including `.venv`, `__pycache__`, an IDE file, and an untracked nested `pyproject.toml`. They are not committed, but they slow search and can confuse refactor scope.

Behavior must remain stable unless a later task explicitly approves a functional change.

---

## Requirements

**Behavior preservation**

- R1. Preserve CLI command names, flags, exit codes, stdout/stderr split, and default logging behavior.
- R2. Preserve Grafana webhook request/response behavior, including authentication, resolved-alert handling, invalid JSON handling, Loki missing-context behavior, and response JSON shape.
- R3. Preserve MiniMax adapter behavior, including Anthropic-compatible endpoint shape, local validation, evidence ID checks, secret redaction, and recoverable provider failures.
- R4. Preserve deterministic mock-LLM behavior for default tests and Docker mock E2E.
- R5. Preserve opt-in behavior for Docker E2E and live MiniMax E2E.
- R6. Preserve evidence IDs, source tiers, provenance summary semantics, safety gate semantics, and scorecard meaning.

**Refactor shape**

- R7. Break refactors into small reviewable passes that can land independently.
- R8. Prefer deleting or consolidating code over introducing new abstractions.
- R9. Keep public APIs stable unless a pass explicitly documents a compatibility-preserving adapter.
- R10. Separate framework, dependency, or provider API migrations from behavior-preserving refactors.
- R11. Add characterization tests before moving code that currently has broad responsibility.
- R12. Keep docs aligned with the modernized structure after each pass.

---

## Key Technical Decisions

- KTD1. **Characterize before moving behavior:** The current suite is good, but module extraction should begin by adding focused parity tests for CLI rendering, webhook response shape, and E2E helper behavior so refactors have tight safety rails.
- KTD2. **Extract shared E2E/probe helpers before touching runtime modules:** The clearest duplication is in test/demo orchestration, and consolidating it lowers friction for future E2E scenarios without altering application behavior.
- KTD3. **Split `cli.py` by responsibility, not by command count:** Preserve `incident_triage_agent.cli:main` as the public script entrypoint while moving rendering, mock response fixtures, and client construction into smaller modules.
- KTD4. **Treat `scripts/seed_loki_logs.py` as legacy until proved unused:** Do not delete it first. Mark it as compatibility/deprecated or replace it only after README, tests, and E2E paths no longer rely on it.
- KTD5. **Avoid dependency upgrades during refactor passes:** The code intentionally uses stdlib HTTP servers and `urllib`. Any move to `httpx`, FastAPI, Pydantic, pytest, ruff, or a typed settings library should be a separate migration task with its own compatibility plan.
- KTD6. **Keep generated/local artifacts out of scope for code review:** Remove local ignored environment noise and strengthen ignore patterns if needed, but do not treat those files as product code.

---

## Current Hotspots

| Area | Current behavior | Structural drag | Proposed direction |
| --- | --- | --- | --- |
| `src/incident_triage_agent/cli.py` | CLI parsing, scenario loading, LLM selection, workflow execution, mock decisions, and rendering | Oversized module; hard to change output without touching command orchestration | Extract rendering, mock decisions, and runtime client factories |
| `src/incident_triage_agent/grafana.py` | Normalizes Grafana payloads into raw incidents and Loki query windows | Many small parsing helpers live beside top-level normalization | Group parsing helpers around alert extraction, incident construction, and time/window handling |
| `src/incident_triage_agent/llm.py` | Builds prompt, posts to MiniMax, extracts text, parses and validates decision | Prompt construction, provider transport, and decision parsing share one file | Split prompt, provider adapter, and decision validation while keeping `LLMClient` API stable |
| `src/incident_triage_agent/server.py` | Handles webhook auth, Loki lookup, workflow run, and response rendering | HTTP handler and workflow response serialization are intertwined | Extract response serialization and webhook runtime orchestration helpers |
| E2E tests and live probe | Start Compose, wait for services, generate checkout logs, mutate Grafana payload, post webhook | Duplicated logic across two tests and one script | Add shared test/demo helper module under `tests/support/` or `scripts/support/` |
| `scripts/seed_loki_logs.py` | Pushes static Loki logs directly | Legacy path after synthetic service became preferred | Deprecate or remove after compatibility check |
| Local artifacts under `src/incident_triage_agent/` | Ignored `.venv`, `__pycache__`, IDE file, nested untracked `pyproject.toml` | Confuses scans and modernization diffs | Delete local artifacts and update ignore guidance if needed |

---

## Implementation Units

### U1. Clean Local Artifacts And Dead-Code Candidates

- **Goal:** Remove local-only noise and classify legacy helpers before touching behavior-bearing modules.
- **Current behavior:** The committed package lives under `src/incident_triage_agent/`, but local ignored files also exist there: `.venv`, `__pycache__`, `incident_triage_agent.iml`, and an untracked nested `pyproject.toml`. `scripts/seed_loki_logs.py` still works but is no longer the preferred E2E path.
- **Structural improvement:** Delete local artifacts, confirm `.gitignore` covers them, and either mark `scripts/seed_loki_logs.py` as a compatibility helper or plan its later removal.
- **Files:** `.gitignore`, `AGENTS.md`, `README.md`, `scripts/seed_loki_logs.py`.
- **Patterns to follow:** Preserve the repo-root `pyproject.toml` and `uv.lock` as the only package metadata source.
- **Test scenarios:**
  - Default suite still ignores local cache/environment files.
  - README no longer recommends stale seed-log flow as the primary path.
  - If `seed_loki_logs.py` remains, its existing behavior is covered or explicitly documented as compatibility-only.
- **Validation:** `git status --short`, `rg --files src/incident_triage_agent`, `uv run python -m unittest discover -s tests`, `git diff --check`.

### U2. Add Characterization Tests For Public Behavior

- **Goal:** Strengthen parity checks before moving code.
- **Current behavior:** The suite covers CLI output, Grafana normalization, LLM validation, server responses, Docker E2E, and live probe helpers, but some output shape is asserted only indirectly.
- **Structural improvement:** Add focused tests for CLI rendering snapshots at the semantic-line level, server response keys, prompt invariants, and live-probe sanitized output.
- **Files:** `tests/test_cli.py`, `tests/test_server.py`, `tests/test_llm.py`, `tests/test_live_e2e_probe_script.py`.
- **Patterns to follow:** Use stdlib `unittest`; avoid brittle full-output snapshots where dynamic order or live model wording can vary.
- **Test scenarios:**
  - `render_run` output still includes incident, decision, provenance, safety, and scorecard sections for valid runs.
  - Invalid LLM output still renders provenance and no safety action.
  - Webhook response still includes `incident`, `validation`, `decision`, `evidence`, `provenance`, `safety`, and `scorecard` when valid.
  - Prompt still includes mission boundary, allowed taxonomy, allowed evidence IDs, and source tiers.
- **Validation:** Targeted tests above plus full default suite.

### U3. Consolidate E2E And Demo Probe Orchestration

- **Goal:** Remove duplicated Docker/HTTP orchestration across tests and demo scripts.
- **Current behavior:** `tests/test_e2e_grafana_loki.py`, `tests/test_e2e_real_service_live_llm.py`, and `scripts/run_live_e2e_probe.py` each implement variants of `wait_for_url`, `generate_checkout_incident`, `post_grafana_payload`, and Compose execution.
- **Structural improvement:** Extract shared helpers into a small internal support module while preserving test flags and script CLI behavior.
- **Files:** `tests/test_e2e_grafana_loki.py`, `tests/test_e2e_real_service_live_llm.py`, `tests/test_live_e2e_probe_script.py`, `scripts/run_live_e2e_probe.py`, new `tests/support/live_stack.py` or `scripts/support/live_probe.py`.
- **Patterns to follow:** Keep helpers stdlib-only and keep live provider config validation secret-safe.
- **Test scenarios:**
  - Mock Docker E2E still starts the base stack and uses `--mock-llm`.
  - Live Docker E2E still starts the override stack and skips without live config or flag.
  - Probe still prints clean summary output and cleans up on failure.
  - Shared helper can mutate Grafana `startsAt` without modifying fixture files on disk.
- **Validation:** `uv run python -m unittest tests/test_e2e_grafana_loki.py` with `RUN_DOCKER_E2E=1`, live E2E with `RUN_LIVE_LLM_E2E=1`, and `uv run python scripts/run_live_e2e_probe.py --no-build` when credentials are available.

### U4. Extract CLI Runtime Construction And Rendering

- **Goal:** Shrink `cli.py` while preserving the `triage` entrypoint.
- **Current behavior:** `cli.py` builds parsers, loads fixtures/config, constructs LLM clients, runs workflows, contains mock decisions, and renders terminal output.
- **Structural improvement:** Move terminal rendering to `src/incident_triage_agent/rendering.py`, mock decisions to `src/incident_triage_agent/mock_responses.py`, and LLM/runtime client construction to a small factory module.
- **Files:** `src/incident_triage_agent/cli.py`, new `src/incident_triage_agent/rendering.py`, new `src/incident_triage_agent/mock_responses.py`, optional new `src/incident_triage_agent/runtime.py`, `tests/test_cli.py`.
- **Patterns to follow:** Keep `main(argv)` and `triage = "incident_triage_agent.cli:main"` stable.
- **Test scenarios:**
  - `triage list` output unchanged.
  - `triage run checkout-payment-timeout --mock-llm --trace` output still contains the same semantic sections.
  - Missing credentials still return exit code `2` and name missing config without secrets.
  - Log-level behavior remains unchanged.
- **Validation:** `uv run python -m unittest tests/test_cli.py tests/test_workflow.py tests/test_scoring.py` plus full default suite.

### U5. Split LLM Prompt, Provider, And Decision Validation Boundaries

- **Goal:** Make the LLM boundary easier to audit without changing provider behavior.
- **Current behavior:** `llm.py` contains prompt assembly, Anthropic-compatible MiniMax transport, response text extraction, JSON parsing, and decision validation.
- **Structural improvement:** Split into focused modules such as `prompting.py`, `providers.py`, and `decision_validation.py`, while re-exporting existing public names from `llm.py` during the transition.
- **Files:** `src/incident_triage_agent/llm.py`, new `src/incident_triage_agent/prompting.py`, new `src/incident_triage_agent/providers.py`, new `src/incident_triage_agent/decision_validation.py`, `tests/test_llm.py`.
- **Patterns to follow:** Preserve `LLMClient`, `MiniMaxAnthropicClient`, `StaticLLMClient`, `parse_decision_text`, and `build_decision_prompt` import compatibility.
- **Test scenarios:**
  - Prompt content invariants remain unchanged.
  - Anthropic response text extraction still ignores non-text blocks.
  - Malformed JSON, unknown taxonomy, low confidence, and unknown evidence IDs remain recoverable validation failures.
  - Provider HTTP, URL, timeout, and redaction behavior remain unchanged.
- **Validation:** `uv run python -m unittest tests/test_llm.py tests/test_workflow.py tests/test_server.py`.

### U6. Refactor Grafana Normalization Into Smaller Parsing Stages

- **Goal:** Reduce the mental load in `grafana.py` while preserving normalized incident output.
- **Current behavior:** `normalize_grafana_payload` performs payload validation, answer-field rejection, alert selection, service extraction, time-window calculation, resolved-alert handling, incident payload construction, and Incident creation.
- **Structural improvement:** Extract internal helpers or small dataclasses for alert collection, service labels, time windows, and incident construction. Keep `normalize_grafana_payload` as the public facade.
- **Files:** `src/incident_triage_agent/grafana.py`, `tests/test_grafana.py`, `tests/test_server.py`.
- **Patterns to follow:** Preserve `GrafanaNormalizationResult` and `GrafanaPayloadError` public behavior.
- **Test scenarios:**
  - Active payload normalization remains byte-for-byte equivalent for incident fields that tests assert.
  - Resolved-only payload remains ignored with `resolved_alert`.
  - Answer-like fields remain rejected recursively.
  - Missing service label and invalid time errors remain bounded.
- **Validation:** `uv run python -m unittest tests/test_grafana.py tests/test_server.py tests/test_e2e_grafana_loki.py` with Docker flag when available.

### U7. Extract Webhook Response Serialization

- **Goal:** Make server behavior easier to change and test independently.
- **Current behavior:** `server.py` mixes HTTP handling, webhook orchestration, Loki lookup, workflow execution, and `TriageRun` response serialization.
- **Structural improvement:** Move `run_to_response` and `_support` into `src/incident_triage_agent/responses.py`, and optionally extract Loki evidence gathering into a helper.
- **Files:** `src/incident_triage_agent/server.py`, new `src/incident_triage_agent/responses.py`, `tests/test_server.py`.
- **Patterns to follow:** Keep `handle_grafana_webhook` return type and JSON response shape stable.
- **Test scenarios:**
  - Valid webhook response keys and nested fields stay the same.
  - Invalid LLM result still returns validation errors without decision or safety.
  - Missing Loki evidence still becomes missing context, not a crash.
  - Unauthorized and invalid JSON paths still return existing status codes.
- **Validation:** `uv run python -m unittest tests/test_server.py tests/test_scoring.py`.

### U8. Modernize Synthetic Service Internals Without Changing Endpoints

- **Goal:** Make the synthetic service easier to extend for future incident classes.
- **Current behavior:** `services/synthetic_checkout_service.py` builds one payment-timeout payload inline and handles health/checkout endpoints inside a nested handler class.
- **Structural improvement:** Extract incident log templates and request parsing helpers. Keep `/health`, `/checkout`, `ServiceConfig`, and Loki push payload shape stable.
- **Files:** `services/synthetic_checkout_service.py`, `tests/test_synthetic_checkout_service.py`, `docker-compose.yml`.
- **Patterns to follow:** Keep service stdlib-only until a separate migration chooses a framework.
- **Test scenarios:**
  - `build_loki_payload` still emits service labels queryable by `LokiClient`.
  - Empty checkout request still generates a default checkout ID.
  - Invalid JSON and oversized payloads still return bounded errors.
  - Loki push failures still return `loki_push_failed` without exposing request data.
- **Validation:** `uv run python -m unittest tests/test_synthetic_checkout_service.py tests/test_loki.py`.

### U9. Refresh Docs And Architecture Learnings After Refactor

- **Goal:** Keep docs accurate after modules move.
- **Current behavior:** `README.md`, `AGENTS.md`, and architecture docs name current module responsibilities and commands.
- **Structural improvement:** Update docs to describe the new module boundaries and preserve the key architecture message: workflow owns control flow, LLM owns one bounded judgment.
- **Files:** `README.md`, `AGENTS.md`, `CONCEPTS.md`, `docs/learnings.md`, `docs/solutions/architecture-patterns/bounded-llm-incident-triage-workflow.md`.
- **Patterns to follow:** Keep docs operational rather than turning them into implementation logs.
- **Test scenarios:**
  - Documented commands still run.
  - Docs do not suggest live MiniMax tests are default.
  - Docs do not expose secrets or real provider output beyond sanitized examples.
- **Validation:** Command smoke checks from README, `git diff --check`, and full default suite.

---

## Acceptance Examples

- AE1. **Covers R1, R4, R6.**
  - **Given:** The CLI has been split into smaller modules.
  - **When:** `uv run triage run checkout-payment-timeout --mock-llm --trace` runs.
  - **Then:** It emits the same semantic report sections and evidence IDs as before.

- AE2. **Covers R2, R5, R6.**
  - **Given:** Webhook and Grafana normalization internals have been refactored.
  - **When:** The Docker Grafana/Loki E2E runs.
  - **Then:** The response still includes alert and log evidence, current and operational provenance, and safe recommendation behavior.

- AE3. **Covers R3, R9.**
  - **Given:** LLM code is split into prompt, provider, and validation modules.
  - **When:** Tests import existing names from `incident_triage_agent.llm`.
  - **Then:** Existing imports continue to work and validation outcomes remain unchanged.

- AE4. **Covers R7, R11.**
  - **Given:** A refactor pass changes module structure.
  - **When:** The pass is reviewed.
  - **Then:** It has characterization tests proving the moved behavior stayed stable.

---

## Scope Boundaries

- Do not change the incident class taxonomy or next action taxonomy.
- Do not change prompt semantics except through a separate prompt-quality task.
- Do not replace stdlib HTTP or `urllib` with another library in these passes.
- Do not migrate from `unittest` to `pytest` as part of behavior-preserving refactors.
- Do not upgrade Python, uv, Docker images, Loguru, MiniMax models, or Grafana/Loki images in these passes.
- Do not add production Grafana, production Loki, Slack, tickets, deploy rollback, feature flags, or remediation execution.
- Do not remove `scripts/seed_loki_logs.py` until compatibility and docs references are checked in a dedicated pass.

---

## Separate Migration Candidates

These are worth considering later, but should not be bundled with the refactor plan:

- **HTTP client migration:** Moving from `urllib` to `httpx` or `requests` would affect provider transport, Loki transport, tests, and dependency policy.
- **Web framework migration:** Replacing `http.server` with FastAPI, Starlette, or Flask would change server lifecycle and request handling behavior.
- **Test framework migration:** Moving from `unittest` to `pytest` would rewrite fixtures, skip markers, assertions, and E2E ergonomics.
- **Schema/model validation migration:** Introducing Pydantic or attrs could be valuable, but it changes validation behavior and error surfaces.
- **Provider/model upgrade:** Changing MiniMax model defaults or response schema assumptions should be planned as provider work, not refactor work.
- **Packaging/tooling migration:** Changing Python version requirements, dependency groups, lint/type tools, or Docker base image should be a tooling task.

---

## System-Wide Impact

The modernization should make future incident-class expansion easier. The biggest immediate win is reducing change coupling: adding another live demo scenario should not require copying E2E/probe orchestration, and adjusting prompt/validation should not require scrolling through provider transport code.

The main risk is accidental behavior drift hidden behind cleaner module names. The plan counters that by sequencing characterization tests before extraction and keeping each pass small enough to review on its own.

---

## Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| CLI output changes accidentally | Demo and portfolio commands regress | Add semantic rendering tests before extraction |
| Webhook response shape changes | E2E and future integrations break | Add response-shape assertions before moving serialization |
| LLM validation semantics drift | Invalid provider output may pass or valid output may fail | Preserve existing tests and add import-compatibility checks |
| Shared E2E helper becomes too general | Abstraction hides test intent | Extract only repeated Compose/HTTP primitives first |
| Deleting legacy seed script breaks a user path | Existing docs or habits fail | Deprecate before deleting; remove only after references are gone |
| Local ignored files get mistaken for product code | Refactor scope becomes noisy | Clean artifacts first and verify git status |

---

## Documentation And Parity Checks To Create First

- Add a short `docs/refactor-parity-checklist.md` before implementation if more than one agent or branch will work on the refactor.
- Capture a sanitized CLI output sample for `checkout-payment-timeout --mock-llm --trace` if rendering will move.
- Capture a sanitized webhook response sample for `fixtures/grafana/checkout-payment-timeout-webhook.json` if response serialization will move.
- Keep `docs/examples/live-e2e-response.json` as the live-provider example; refresh it only when response shape intentionally changes.
- Add a README command checklist section only after commands move or helper names change.

---

## Suggested Pass Order

1. U1. Clean local artifacts and classify legacy helpers.
2. U2. Add characterization tests for public behavior.
3. U3. Consolidate duplicated E2E and demo probe orchestration.
4. U4. Extract CLI rendering, mock responses, and runtime construction.
5. U5. Split LLM prompt, provider, and decision validation.
6. U6. Refactor Grafana normalization internals.
7. U7. Extract webhook response serialization.
8. U8. Modernize synthetic service internals.
9. U9. Refresh docs and architecture learnings.

This order starts with low-risk cleanup and test strengthening, then removes duplication, then splits behavior-heavy runtime modules.

---

## Sources And Research

- `src/incident_triage_agent/cli.py` for CLI orchestration, mock decisions, and rendering.
- `src/incident_triage_agent/grafana.py` for Grafana normalization responsibilities.
- `src/incident_triage_agent/llm.py` for prompt/provider/validation coupling.
- `src/incident_triage_agent/server.py` for webhook orchestration and response serialization.
- `services/synthetic_checkout_service.py` for synthetic service endpoint and Loki push behavior.
- `tests/test_e2e_grafana_loki.py`, `tests/test_e2e_real_service_live_llm.py`, and `scripts/run_live_e2e_probe.py` for duplicated E2E/demo orchestration.
- `docs/solutions/architecture-patterns/bounded-llm-incident-triage-workflow.md` for the architectural invariant to preserve.
