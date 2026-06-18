# Learnings

This is the running teaching document for the incident triage agent project. Use it to check whether the human understands the problem, the solution, the design branches, the edge cases, and why this architecture matters.

## Session: 2026-06-14

Artifacts created:

- `docs/brainstorms/2026-06-14-incident-triage-agent-requirements.md`
- `docs/plans/2026-06-14-001-feat-incident-triage-agent-plan.md`

## Understanding Checklist

### 1. Problem Understanding

- [ ] Explain the core problem in one sentence: we want to prove an LLM can make useful incident-triage decisions from incident-related data when the surrounding system controls context, state, validation, safety, and evaluation.
- [ ] Explain why this is not "build an incident chatbot."
- [ ] Explain why the PoC uses mock incident data instead of real production integrations.
- [ ] Explain why raw incident data is more valuable for this PoC than pre-enriched data with suspected causes and recommended actions.
- [ ] Explain why the input fixtures must not contain `suspected_causes`, `recommended_actions`, or `requires_approval`.
- [ ] Explain why the first surface is a CLI instead of a web UI.
- [ ] Explain why production execution is out of scope.
- [ ] Explain why a single polished scenario is not enough to prove the architecture.
- [ ] Explain the main failure modes this project is trying to expose: bad LLM reasoning, missing context, invalid output, unsafe recommendations, hardcoded scenario logic, and secret leakage.

### 2. Branches Considered

- [ ] Explain the difference between an interview portfolio artifact and an architecture PoC.
- [ ] Explain why the project shifted away from interview-specific packaging.
- [ ] Explain why the first version uses a single workflow instead of a multi-agent system.
- [ ] Explain why the workflow uses a fixed global taxonomy instead of freeform decisions.
- [ ] Explain why team-defined classifications were deferred.
- [ ] Explain why multiple runnable scenarios were chosen over one scenario plus hidden eval fixtures.
- [ ] Explain why MiniMax is behind an adapter boundary instead of being called directly from workflow code.
- [ ] Explain why the plan uses the Anthropic-compatible MiniMax endpoint instead of the OpenAI-compatible endpoint.
- [ ] Explain why provider-side structured output is not treated as the safety mechanism.

### 3. Solution Understanding

- [ ] Draw the core flow from memory: raw fixture -> mock tools -> evidence package -> MiniMax decision -> local validation -> safety gate -> verification plan -> scorecard.
- [ ] Explain what the state machine does and why state transitions are part of the architecture proof.
- [ ] Explain the difference between fixture facts, gathered evidence, LLM output, validation result, safety decision, audit event, and scorecard.
- [ ] Explain what the LLM is allowed to decide.
- [ ] Explain what the deterministic workflow owns.
- [ ] Explain why the workflow validates the LLM response before state transitions.
- [ ] Explain why the scorecard should be deterministic and not graded by the LLM.
- [ ] Explain how runbooks are used: grounding and policy context, not answer leakage.
- [ ] Explain why approval-sensitive actions are staged and audited rather than executed.
- [ ] Explain why missing non-critical context can produce caveats, but missing critical context should ask for human input.

### 4. Design Decisions

- [ ] Explain why Python CLI was selected for the greenfield MVP.
- [ ] Explain what `MINIMAX_API_KEY` and `MODEL_NAME` do and why they live in `.env`.
- [ ] Explain why `.env.example` exists and why the real `.env` must be ignored.
- [ ] Explain why the MiniMax adapter must handle Anthropic-style content blocks.
- [ ] Explain why response extraction and schema validation are separate concerns.
- [ ] Explain why the global taxonomy must be present in the plan, not only in the requirements document.
- [ ] Explain why fixture validation should reject answer-like fields.
- [ ] Explain why each mock tool should return stable evidence IDs.
- [ ] Explain why the CLI trace is part of the product surface, not just debug output.

### 5. Edge Cases

- [ ] What happens if MiniMax returns malformed JSON?
- [ ] What happens if MiniMax returns a class or action outside the taxonomy?
- [ ] What happens if MiniMax returns low confidence?
- [ ] What happens if the provider response has no usable text block?
- [ ] What happens if the scenario has no matching runbook?
- [ ] What happens if verification signals are missing?
- [ ] What happens if a rollback-like action is recommended?
- [ ] What happens if config is missing?
- [ ] What happens if config errors could accidentally expose secrets?
- [ ] What happens if an eval scenario accidentally includes a suspected cause in raw fixture data?

### 6. Broader Context

- [ ] Explain how this PoC fits the SRE AI operating loop: detect, diagnose, recommend, approve, verify, learn.
- [ ] Explain why SRE principles act as the control system for AI-assisted operations.
- [ ] Explain why the architecture delays real actuation.
- [ ] Explain why evidence grounding matters more than fluent incident prose.
- [ ] Explain why eval scorecards matter for trust and iteration.
- [ ] Explain why a successful run is not enough; failed and ambiguous runs must be legible too.
- [ ] Explain how this PoC could later expand toward real observability tools.
- [ ] Explain what changes if team-specific classifications are added later.
- [ ] Explain why this project matters beyond the demo: it tests a reusable pattern for governed LLM-assisted operations.

## Core Mental Model

The LLM is not the system. The workflow is the system.

The LLM contributes a bounded judgment: classify the incident and choose a next action from a fixed vocabulary. The surrounding software gathers context, builds the evidence package, validates the LLM output, applies safety rules, stages approval-sensitive work, and scores the run.

That distinction matters because incident response is high-context and risk-sensitive. If the LLM owns control flow directly, a fluent but wrong answer can become operationally dangerous. If the workflow owns control flow, the LLM becomes a reasoning component inside a governed system.

## Why The Problem Exists

Incident triage is not just "read alert, guess cause." Operators usually need to assemble context from alerts, logs, deploys, runbooks, owners, prior incidents, and verification signals. That context-gathering work is repetitive, time-sensitive, and easy to do inconsistently under pressure.

LLMs are useful here because they can reason across a bundle of evidence. They are risky here because they can hallucinate, overstate confidence, or recommend unsafe actions. The project exists in that tension: use the LLM for judgment, but use deterministic architecture for boundaries.

The proof of concept must therefore answer a sharper question than "can an LLM summarize an incident?" It must answer: can a controlled workflow feed raw incident context to an LLM, constrain the decision, verify the output, and make the result inspectable enough to trust or reject?

## Why The Chosen Solution Fits

The chosen architecture keeps the demo small without making it fake.

- Raw fixtures prove the system can infer from evidence instead of echoing pre-written suspected causes.
- Mock tools preserve the shape of real operational integrations without needing production access.
- A state machine makes progress, pauses, failures, and safety gates visible.
- A fixed taxonomy prevents freeform LLM output from becoming control flow.
- Local validation protects the workflow from malformed or unsupported provider output.
- A simulated approval gate demonstrates governance without creating real blast radius.
- Scorecards turn every run into a learning artifact.

The design is intentionally not production automation. That restraint is part of the architecture. A good SRE AI system earns autonomy through evidence; it does not start there.

## Implementation Shape To Understand

The plan breaks the work into seven units:

- Project scaffold and configuration.
- Domain model and fixture schema.
- Mock operational tools and evidence package.
- MiniMax Anthropic adapter and decision validation.
- Stateful triage workflow and safety policy.
- Eval scorecards and scenario suite.
- CLI trace output and README walkthrough.

The dependency order matters. Config and domain models come first because they define contracts. Mock tools come before the LLM because the prompt needs an evidence package. The LLM adapter comes before workflow integration because provider behavior must be isolated. Scoring comes after workflow because scorecards need terminal states and decisions to evaluate.

## Drill-Down Questions

Use these to test depth, not memorization.

- Why is a bounded taxonomy safer than freeform action selection?
- Why is raw fixture validation a safety feature?
- Why should eval expectations live outside the raw incident facts?
- Why does the provider adapter return provider metadata and parsed decision data?
- Why does the workflow need a recoverable failure state?
- Why is "continue with caveats" different from "ask human"?
- Why should missing verification signals block readiness?
- Why does a staged audit payload matter if no real action is executed?
- Why is the CLI trace a product surface?
- Why does this architecture make future real integrations easier?

## Current Confidence

- Requirements clarity: high.
- Architecture direction: high.
- MiniMax endpoint choice: confirmed as Anthropic-compatible.
- Implementation stack: selected as Python CLI for the MVP.
- Production-readiness: intentionally out of scope.
- Main remaining risk: implementation must preserve the separation between raw facts, derived evidence, LLM decisions, deterministic validation, and eval metadata.

## Implementation Learnings: 2026-06-14

The first implementation pass proved the architecture can run end to end:

- Raw scenario fixtures load through typed domain models.
- Mock operational tools turn fixture facts into stable evidence IDs.
- MiniMax is called through the Anthropic-compatible endpoint using `X-Api-Key`.
- The LLM decision is parsed locally and checked against the global taxonomy.
- The workflow moves through explicit states and fails closed on invalid output.
- Approval-sensitive actions produce staged payloads and simulated audit events.
- Scorecards make the outcome inspectable across multiple scenarios.

### What The Human Should Understand From Implementation

- [ ] Why the provider adapter uses `X-Api-Key` for the Anthropic-compatible MiniMax endpoint.
- [ ] Why live provider responses can be semantically correct but still differ in shape from the prompt.
- [ ] Why validation normalizes harmless shape variation, such as a single string where a string list was requested.
- [ ] Why validation still rejects unsupported taxonomy values, unknown evidence IDs, malformed JSON, and low confidence.
- [ ] Why the state machine must append terminal states before scoring.
- [ ] Why mock scenarios and fake LLM responses are useful even when the real MiniMax path works.
- [ ] Why real MiniMax calls should not be required for the default test suite.
- [ ] Why CLI output polish matters: the trace is part of the architecture proof, not an afterthought.

### Provider Boundary Lesson

The live MiniMax call originally returned the right incident class and next action, but gave `caveats` and `verification_plan` as strings instead of arrays. That was not a reasoning failure. It was a response-shape mismatch.

The fix was not to trust the provider more. The fix was to make the prompt clearer and make local validation normalize the harmless case while preserving hard boundaries. This is a useful general rule for LLM systems: be strict about semantic control fields, but tolerant about presentation-shaped variation when it can be safely normalized.

### Test And Verification Lessons

- Unit tests protect the local contracts: config loading, fixture validation, evidence packaging, decision validation, safety policy, workflow states, scoring, and CLI output.
- Mock CLI runs prove all scenarios are runnable without network calls.
- A live MiniMax run proves the provider adapter works with the real `.env` configuration.
- The noisy-alert live run is especially useful because it shows missing runbook context can coexist with a safe `continue_monitoring` recommendation.

## Agent Handoff Learnings: 2026-06-14

The repo now includes `AGENTS.md` as the fast orientation document for future agent sessions.

- [ ] Explain why agent instructions are part of the architecture, not just repo housekeeping.
- [ ] Explain why future agents need the bounded taxonomy, secret-handling rules, and raw-fixture constraint in one obvious place.
- [ ] Explain why `AGENTS.md` points to deeper topic docs instead of duplicating every planning detail.

### Why This Matters

Agent handoff files reduce accidental drift. This project is especially sensitive to drift because a small convenience change, such as adding suspected causes into fixtures or letting provider output skip validation, can quietly invalidate the proof of concept. `AGENTS.md` keeps the next contributor focused on the same central rule: the workflow controls the system, and the LLM contributes one validated bounded judgment.

## Tooling Learnings: 2026-06-14

The project now uses npm, Node.js, TypeScript, and Docker as the active runtime path.

- [ ] Explain why `npm run triage -- ...` should be the same operator path used locally and inside Docker.
- [ ] Explain why Docker should call the same TypeScript CLI entrypoint as local development.
- [ ] Explain why `.env` is excluded from both git and Docker build context.
- [ ] Explain why tests still run without real MiniMax credentials.

### Why This Matters

Tooling should reinforce the architecture instead of creating a second way for it to behave. Using the same TypeScript CLI locally and inside Docker means local runs, tests, and container demos exercise the same package entrypoint. Excluding `.env` from the image build context keeps credentials out of the artifact while still allowing real provider calls with `docker run --env-file .env`.

## Compound Learning: 2026-06-14

The architecture has been captured as a reusable solution learning in `docs/solutions/architecture-patterns/bounded-llm-incident-triage-workflow.md`, and the first project vocabulary seed now lives in `CONCEPTS.md`.

- [ ] Explain why `docs/solutions/` is different from `docs/learnings.md`: the former is a searchable durable solution store, while the latter is the running teaching checklist for this session.
- [ ] Explain why `CONCEPTS.md` defines domain terms without implementation file paths or current enum values.
- [ ] Explain why documenting this as an architecture pattern helps future work avoid collapsing model reasoning, workflow control, safety policy, and evaluation into one blob.

## Logging Learnings: 2026-06-15

The CLI now uses Pino for detailed step-by-step diagnostics.

- [ ] Explain why logs go to stderr while the triage report stays on stdout.
- [ ] Explain why package logging is disabled by default and enabled by the CLI setup path.
- [ ] Explain why default `INFO` logs are limited to high-level milestones while detailed step diagnostics require `--log-level DEBUG`.
- [ ] Explain why logs should describe workflow phases, evidence counts, validation outcomes, safety decisions, and scorecard results without leaking secrets.

### Why This Matters

Incident triage tools need observability for their own reasoning path. The trace explains the run to a human reader, while logs help debug the system boundary by boundary: CLI setup, fixture loading, evidence gathering, LLM request or mock response, validation, policy gating, scoring, and rendering. Keeping those logs on stderr preserves stdout as a stable report surface for demos, scripts, and tests.

## Prompt Contract Learnings: 2026-06-15

The decision prompt now lists exact allowed evidence IDs and tells the model to copy them without renaming or reformatting.

- [ ] Explain why prompt guidance is the first fix for near-miss evidence citations.
- [ ] Explain why strict validation still matters even with a clearer prompt.
- [ ] Explain why the prompt includes a positive allowed-ID list instead of relying only on examples.
- [ ] Explain why we chose not to normalize aliases like `prior_incident:0` for now.

### Why This Matters

The model can infer plausible ID patterns that are not part of the contract. Listing exact allowed IDs reduces that tendency while preserving the validator's role as the authority. This keeps the PoC honest: model output must match the evidence package, and near-misses remain visible instead of being silently accepted.

## Evidence Provenance Implementation: 2026-06-16

The architecture now includes source tiering plus deterministic provenance output.

- [ ] Explain why citing a valid evidence ID is necessary but not sufficient for trustworthy incident triage.
- [ ] Explain why live/current signals should carry more weight than prior incidents.
- [ ] Explain why source tiers should be assigned by the workflow, not generated by the LLM.
- [ ] Explain why provenance should be computed deterministically instead of added as another model output field.
- [ ] Explain why historical context can support a recommendation but should not be the only basis for a confident concrete classification.
- [ ] Explain why invalid LLM output can still have useful available-evidence provenance.

## Node/TypeScript/Flue Redesign: 2026-06-18

The project is being ported to a Node and TypeScript runtime with Flue as the skill boundary and Pino as the logging target.

- [ ] Explain why this is a migration, not a behavior rewrite.
- [ ] Explain why the TypeScript runtime should preserve the same bounded workflow contract before adding new agentic behavior.
- [ ] Explain why Flue belongs at the skill boundary, while workflow state, validation, safety, and scoring remain deterministic application code.
- [ ] Explain why the Flue runtime import is isolated from ordinary validation tests.
- [ ] Explain why moving from Bun to Node removes the `node:sqlite` runtime blocker for Flue.
- [ ] Explain why Flue `SKILL.md` imports still need a Flue-aware packaging/runtime path.
- [ ] Explain why scorecards should evaluate outcome behavior, not exact prose from the LLM.
- [ ] Explain why the workflow must append the `scored` state before computing the scorecard.

### Why This Matters

The state-ordering issue is a small but important example of behavior parity. A scorecard that checks terminal workflow state must see the terminal state before it runs; otherwise the implementation can do the right work but grade itself incorrectly. This is why the migration uses focused outcome tests around the real workflow functions instead of only testing local object construction.

Flue 1.0 beta exposed a useful runtime lesson: `@flue/runtime/node` depends on Node's `node:sqlite`, so Bun was the wrong live runtime for this project. Moving TypeScript execution to Node removes that specific blocker. The remaining live-integration question is how the Node app should package and execute imported `SKILL.md` files through Flue's intended runtime/build surface.

## Grafana/Loki TypeScript Parity: 2026-06-18

The TypeScript runtime now has the same first-class external payload path as the Python runtime: Grafana webhook payloads normalize into raw incidents, Loki log lines become operational evidence, and the webhook handler returns decision, provenance, safety, and scorecard JSON.

- [ ] Explain why Grafana payload normalization must still reject answer-like fields.
- [ ] Explain why resolved alerts should be ignored before evidence gathering or LLM calls.
- [ ] Explain why Loki logs enter the system as evidence with stable `log:N` IDs.
- [ ] Explain why webhook scenarios may omit fixture eval expectations while still being scored for grounding, safety, state, and evidence quality.
- [ ] Explain why live Docker/Grafana/Loki/LLM testing is a separate step from handler-level parity tests.

### Why This Matters

The handler-level tests use real Grafana fixture payloads and Loki-shaped responses without requiring Docker or a networked LLM. That keeps the default suite fast while still exercising the important contracts: request validation, alert status handling, log evidence conversion, workflow execution, provenance output, and safe failure for invalid model output.
- [ ] Explain why this work happened before Grafana ingestion or larger playbook systems.

### Why This Matters

Evidence grounding is not only about whether a cited ID exists. It is also about whether the cited evidence is strong enough for the recommendation being made. Source tiering gives the workflow a vocabulary for that distinction, and provenance output gives the operator a compact explanation of the recommendation's trust basis. The scorecard now separates weak evidence quality from malformed output and unknown evidence IDs, which makes failure modes easier to interpret.

## Grafana And Loki Integration Planning: 2026-06-16

The next architectural step is a local integration path that accepts Grafana-shaped alert payloads, enriches them with Loki log evidence, and runs the existing triage workflow without using production systems.

- [ ] Explain why this is an ingestion problem before it is an E2E testing problem.
- [ ] Explain why Grafana alert payloads should be treated as raw facts, not as recommendations.
- [ ] Explain why Loki logs become operational evidence rather than a second source of decisions.
- [ ] Explain why production Grafana, real service logs, and real remediation remain out of scope for the default E2E.
- [ ] Explain why the default E2E should use a mock LLM even though the project supports live MiniMax calls.
- [ ] Explain why eval expectations must stay outside Grafana webhook payloads.
- [ ] Explain why a synchronous webhook response is enough for the PoC, while queues and async workers can wait.
- [ ] Explain why a recorded Grafana default webhook payload may be a better first E2E step than relying on Grafana scheduler timing.

### Why This Matters

The project is moving from static mock fixtures toward real observability shapes. That matters because the architecture should prove it can consume alerts and logs the way an SRE tool would, while still preserving the central safety rule: the workflow controls context, validation, safety, and evaluation, and the LLM contributes one bounded judgment.

## Grafana And Loki Integration Implementation: 2026-06-16

The implementation added a local webhook path, Grafana payload normalization, Loki log lookup, external evidence-package construction, JSON triage responses, and an opt-in Docker E2E test.

- [ ] Explain why `Scenario.expected` is optional for webhook runs but still required for fixture eval scenarios.
- [ ] Explain why fixture scorecards keep `classification_quality` and `next_action_quality`, while external webhook runs omit those expectation-dependent checks.
- [ ] Explain why the webhook server authenticates with `X-Webhook-Secret` before parsing payload content.
- [ ] Explain why Grafana resolved-only notifications are ignored instead of starting a new active triage.
- [ ] Explain why Loki failures become missing context instead of endpoint crashes.
- [ ] Explain why the Docker E2E is opt-in and the default unit suite still avoids containers and real network dependencies.
- [ ] Explain why the Compose path uses synthetic Grafana/Loki data rather than production Grafana Cloud or private logs.

### Why This Matters

The project now proves two surfaces with one architecture: fixture CLI runs for deterministic architecture demos and webhook ingestion for observability-shaped inputs. The important design win is reuse. The webhook path does not get a special, looser decision flow; it still builds evidence, calls the bounded LLM adapter, validates the result, applies safety policy, and reports provenance.

## Real Service And Live LLM E2E Planning: 2026-06-16

The next planned increment strengthens the E2E path by replacing seeded logs with logs generated by a real local synthetic service and replacing the mock LLM with an opt-in live MiniMax call.

- [ ] Explain why the synthetic service should generate logs from real requests instead of relying on a seeding script.
- [ ] Explain why the service can push directly to Loki for this increment instead of adding a log collector.
- [ ] Explain why the live MiniMax E2E must be opt-in and separate from the default deterministic suite.
- [ ] Explain why live-provider tests should assert bounded validation, evidence citations, provenance, and safety before asserting exact class/action.
- [ ] Explain why `.env` can be used at runtime but must not enter Docker image layers, logs, docs, or fixtures.
- [ ] Explain why this still is not production automation even though it uses a real LLM call.

### Why This Matters

This is the point where the PoC starts testing the whole loop under live conditions. That makes the proof stronger, but it also introduces provider variance, network dependency, credential handling, and cost. Keeping the path opt-in preserves fast local development while still allowing a deeper architecture proof when the environment is ready.

## Real Service And Live LLM E2E Implementation: 2026-06-16

The implementation added a small synthetic checkout service and split E2E validation into two explicit tiers: real service plus mock LLM, and real service plus live MiniMax.

- [ ] Explain why the synthetic checkout service is still mock data even though it is a real running HTTP service.
- [ ] Explain how the service-generated Loki labels let the existing `LokiClient` work without a special test-only code path.
- [ ] Explain why `docker-compose.yml` keeps `--mock-llm` and `docker-compose.live.yml` removes it.
- [ ] Explain why the live E2E skips by default and checks `RUN_LIVE_LLM_E2E=1`.
- [ ] Explain why the live E2E asserts valid schema, bounded taxonomy, alert/log citations, provenance, and safety rather than exact MiniMax prose.
- [ ] Explain why invalid LLM output should produce a recoverable workflow response without any safety action.

### Why This Matters

This gives the project a better architecture proof without making daily development fragile. The real-service/mock-LLM path proves the local observability loop deterministically. The live-service/live-LLM path proves the provider boundary when deliberately enabled. Those are different kinds of confidence, and keeping them separate is what makes the test suite useful instead of noisy.

## Live Demo Probe And Example Response: 2026-06-16

The project now has a one-command live demo probe plus a sanitized saved response example.

- [ ] Explain why a demo probe is different from a test: it optimizes for human inspection of the architecture path, not only assertions.
- [ ] Explain why the probe prints a sanitized summary instead of raw provider or prompt data.
- [ ] Explain how the saved example helps reviewers understand evidence citations, provenance, safety, and scorecard output without spending live provider credits.
- [ ] Explain why the probe must always clean up the Compose stack, including failure cases.

### Why This Matters

The E2E tests prove the behavior. The demo probe makes the behavior easy to show. That distinction matters for portfolio-quality engineering: a good project should be verifiable by tests and legible to a human who wants to understand the system quickly.

## Modernization Planning: 2026-06-16

The modernization plan is intentionally behavior-preserving. It treats refactoring as a sequence of small, reviewable passes rather than one broad rewrite.

- [ ] Explain why characterization tests should come before moving code out of oversized modules.
- [ ] Explain why duplicated E2E/probe orchestration is a better first refactor target than the LLM prompt itself.
- [ ] Explain why CLI, LLM, Grafana, and server modules can become large because responsibilities accumulate, not because any one function is obviously broken.
- [ ] Explain why dependency upgrades, HTTP framework changes, and test framework migrations should be split from behavior-preserving refactors.
- [ ] Explain why retired runtime artifacts are cleanup work, not product code.
- [ ] Explain how each pass proves behavior stayed stable: focused parity tests first, then full default suite, then opt-in Docker/live checks only when relevant.

### Why This Matters

Modernization is safest when it narrows the future change surface without changing what users can observe. The useful mental model is: first freeze behavior with tests, then move code, then delete duplication. That gives the project a cleaner architecture without losing the evidence trail that makes the incident-triage agent trustworthy.

## Outcome-Based Test Suite Planning: 2026-06-17

The next testing plan adds a contract layer that checks the operator-facing triage outcome instead of the model's exact prose or the workflow's internal implementation path.

- [ ] Explain why outcome tests are useful before broad refactors or future agent-selected tool flows.
- [ ] Explain the difference between unit tests, deterministic scorecards, Docker E2E tests, live provider E2E tests, and outcome tests.
- [ ] Explain why a "good" triage outcome includes evidence citations, provenance support, safety behavior, and recoverable failure handling.
- [ ] Explain why live MiniMax tests should assert broad contracts instead of exact caveat or verification-plan wording.
- [ ] Explain why outcome helpers should compose existing workflow, response, provenance, safety, and scorecard surfaces instead of becoming a second evaluator.
- [ ] Explain why default outcome tests must stay deterministic and avoid Docker, MiniMax credentials, and network access.

### Why This Matters

Outcome tests answer the question a reviewer or operator cares about: did the system produce a bounded, grounded, safe recommendation, or did it fail closed in a legible way? That is different from asking whether one function parsed JSON correctly or whether one live model response used the same words as last time. This layer gives the project stronger refactor safety while preserving the core architecture rule: the workflow controls the system, and the LLM contributes one validated bounded judgment.

## Observability Scenario Matrix Planning: 2026-06-17

The next test expansion should add capacity saturation to the Grafana/Loki E2E path, then add bad deploy with a raw deploy evidence source.

- [ ] Explain why fixture outcome coverage and observability E2E coverage answer different questions.
- [ ] Explain why capacity saturation is the best next E2E scenario: it exercises current alerts, operational logs, runbook guidance, and approval-gated safety.
- [ ] Explain why live MiniMax scenario expansion must stay opt-in and selectable.
- [ ] Explain why bad deploy needs a raw deploy evidence source instead of putting rollback hints in Grafana annotations.
- [ ] Explain why scenario fixtures should provide facts while test code owns expected outcomes.
- [ ] Explain why adding more scenarios should reuse outcome assertions instead of adding one-off E2E checks.

### Why This Matters

More scenarios make the architecture proof stronger only if they preserve the same boundaries. Capacity saturation is valuable because it proves the local observability path can handle a different service, different log shape, and approval-sensitive safety result. Bad deploy is valuable because it proves the workflow can combine alert, log, deploy, and runbook evidence without letting Grafana annotations become recommendations. The important discipline is not to chase breadth by weakening inputs. Grafana, Loki, and deploy evidence should still provide facts; the workflow, model validation, safety gate, provenance, and scorecard still decide whether the outcome is usable.

## Observability Scenario Matrix Implementation: 2026-06-17

The implementation expanded the local observability path from one checkout webhook to a small deterministic matrix: checkout dependency outage, search capacity saturation, and checkout bad deploy.

- [ ] Explain why the deterministic Docker E2E can assert exact classes and actions while the live MiniMax E2E should stay selectable and contract-based.
- [ ] Explain why bad deploy needed `fixtures/deploys/deploys.json`: Grafana supplied alert facts, Loki supplied runtime log facts, and deploy evidence supplied change facts.
- [ ] Explain why the bad-deploy webhook uses a neutral `scenario` label only for deterministic mock routing, not as an incident-class answer.
- [ ] Explain why `/capacity` and `/bad-deploy` endpoints generate real Loki log records but still remain synthetic, local, and non-remediating.
- [ ] Explain why approval-required outcomes must include staged audit payloads and must not execute rollback, scaling, or throttling.
- [ ] Explain why the live test defaults to checkout and requires `LIVE_E2E_SCENARIOS` for broader provider-backed coverage.

### Why This Matters

This turns the integration proof from a happy-path checkout demo into a bounded scenario matrix. The design still teaches the right habit: sources provide facts, the prompt asks for one bounded decision, validation checks the response, safety gates approval-sensitive actions, and outcome tests prove the operator-facing contract.

## Node, TypeScript, And Flue Redesign Planning: 2026-06-18

The redesign plan moves the project from Python to a Node/TypeScript stack and uses Flue for one bounded `incident-triage` skill call. The core behavior does not expand: deterministic code still owns evidence, state, validation, provenance, safety, and scoring.

- [ ] Explain why this is a runtime and architecture migration, not a product expansion.
- [ ] Explain why one `incident-triage` skill is the right next step before multi-step autonomous tool selection.
- [ ] Explain why Flue should own skill invocation and typed result handling, while TypeScript modules keep safety policy and scorecards deterministic.
- [ ] Explain why parity/outcome tests should be ported before deleting the Python implementation.
- [ ] Explain why Pino logs should stay on stderr and report output should stay on stdout.
- [ ] Explain why live MiniMax and Docker E2E paths must remain opt-in after the migration.

### Why This Matters

The useful part of Flue is not that it makes the system more magical. It gives the project a clean skill boundary: domain reasoning lives in an incident-triage skill, while application code keeps authority over state, validation, and safety. That is the same architecture lesson as before, expressed in a more agent-native stack.

## TypeScript Live Runtime Planning: 2026-06-18

The next plan promotes TypeScript from parity scaffold to the live/demo runtime. The important lesson is sequencing: prove TypeScript live MiniMax, HTTP server, Docker, demo probe, and E2E parity before deleting Python paths.

- [ ] Explain why runtime migration is not complete until the strongest demo path uses the new runtime.
- [ ] Explain why the live MiniMax path should go through the same decision adapter and Flue skill boundary as tests.
- [ ] Explain why the HTTP server should wrap the already-tested webhook handler instead of reimplementing triage logic.
- [ ] Explain why Docker E2E, live E2E, and demo probe orchestration should share helpers where possible.
- [ ] Explain why docs should replace Python commands only when equivalent TypeScript commands exist.
- [ ] Explain why Python deletion belongs after parity tests, not at the beginning of the migration.

### Why This Matters

A proof of concept is most convincing when the architecture a reader studies is the same architecture the demo runs. Keeping Python as the live surface after TypeScript owns the workflow creates two truths. Promoting TypeScript end to end removes that split while preserving the safety lesson: the LLM reasons, but code controls the system.

## TypeScript Live Runtime Implementation: 2026-06-18

The implementation promoted TypeScript to the active live/demo runtime, with MiniMax execution through Flue, a real HTTP webhook server, a TypeScript synthetic service, Docker Compose parity, a live demo probe, and TypeScript outcome/E2E tests.

- [ ] Explain why the Flue call belongs behind the `LLMDecisionClient` boundary instead of inside workflow state transitions.
- [ ] Explain why the Flue workflow lives directly in `src/workflows/incident-triage.ts`: `src/` is the recommended Flue source root for new projects, and the workflow file itself should be the discovered entrypoint.
- [ ] Explain why `.flue/` would be useful for embedding Flue inside a larger app, but would stop Flue from discovering `src/workflows/`.
- [ ] Explain why the HTTP server wraps the tested webhook handler instead of owning triage logic.
- [ ] Explain why the synthetic service is a real local service but still mock incident data.
- [ ] Explain why MiniMax's Anthropic-compatible Flue provider base is `/anthropic`, allowing the Anthropic-compatible client layer to reach `/v1/messages`.
- [ ] Explain why response serialization matters: public webhook JSON uses stable operator-facing field names such as `approval_required`.
- [ ] Explain why outcome tests were ported before removing the old runtime.
- [ ] Explain why Docker E2E and live MiniMax E2E remain opt-in even after the TypeScript migration.
- [ ] Explain why deleting the retired runtime reduces ambiguity rather than removing useful functionality.

### Why This Matters

The project now has one active story: TypeScript code owns orchestration and safety, Flue owns the skill invocation boundary, MiniMax supplies one bounded judgment, and Docker proves the same path under a realistic local observability loop. That makes the PoC easier to inspect because there is no second implementation quietly carrying the demo.

## Flue Debug Logging: 2026-06-18

The Flue child process now streams stdout and stderr into the normal Pino logger at debug level while still returning captured output to the validator.

- [ ] Explain why normal operator output should stay clean at `info` level.
- [ ] Explain why Flue internals belong behind `--log-level debug` instead of being printed unconditionally.
- [ ] Explain why the CLI logger must be passed into the live `FlueDecisionClient`; otherwise the child workflow can run correctly but remain invisible.
- [ ] Explain why debug logging happens at the process boundary: that is where Flue stdout, stderr, exit code, and captured JSON all meet.
- [ ] Explain why secret redaction still applies before Flue process output is logged.
- [ ] Explain why this is observability, not workflow behavior: validation, safety, provenance, and scorecard semantics remain unchanged.

### Why This Matters

Debug logging should help a human understand the architecture without changing the architecture. In this project, `info` logs show the stable incident-triage lifecycle, and `debug` logs expose the lower-level Flue execution path when needed. That separation keeps demos readable while still making integration issues diagnosable.

## TypeScript Modernization Planning: 2026-06-18

The modernization plan after the TypeScript live-runtime migration focuses on small behavior-preserving refactor passes rather than another architecture rewrite.

- [ ] Explain why characterization tests should come before moving broad modules like CLI, server, Grafana parsing, and LLM boundaries.
- [ ] Explain why duplicated Docker/live E2E/probe orchestration is the best first structural cleanup target.
- [ ] Explain why large files are not automatically bad; the useful split is by responsibility and public contract.
- [ ] Explain why `normalizeGrafanaPayload`, `handleGrafanaWebhook`, `runToResponse`, `FlueDecisionClient`, and `validateDecisionPayload` should remain stable facades during refactors.
- [ ] Explain why framework changes, dependency upgrades, BullMQ conversion, prompt optimization, and provider upgrades are separate migration tasks.
- [ ] Explain why historical Python/Bun-era plans should remain historical while active docs should clearly point to TypeScript, npm, Docker, Flue, and Vitest.

### Why This Matters

Modernization is not a license to churn working code. The right move is to make future changes cheaper while preserving the operator contract: bounded decisions, evidence citations, provenance, safety, scorecard, and opt-in live-provider behavior. The plan protects that contract first, then cleans structure in reviewable passes.

## Human Investigation Skill Planning: 2026-06-18

The next skill prompt improvement should make the model reason more like an on-call SRE while preserving the same bounded output contract.

- [ ] Explain why human-style investigation order belongs inside the skill instructions, not in new workflow state yet.
- [ ] Explain the investigation loop: current signal, impact, recent changes, dependency-vs-local evidence, evidence quality, missing context, safe next action, and verification.
- [ ] Explain why temporal correlation from deploy evidence is weaker than logs or verification signals unless corroborated.
- [ ] Explain why runbooks guide response and prior incidents support analogy, but neither should be treated as primary proof.
- [ ] Explain why the output schema should stay unchanged even though the reasoning instructions improve.
- [ ] Explain why future agent-selected read-only tools should be a separate architecture step after the one-shot skill is stronger.

### Why This Matters

The project gets better when the model's reasoning process resembles real SRE triage, but it stays trustworthy because the application still validates the result. This is the balance to preserve: make the skill smarter about investigation without letting it become the system of record or the safety mechanism.

## Human Investigation Skill Implementation: 2026-06-18

The incident-triage skill now explicitly tells the LLM to investigate like an on-call SRE before returning the same six-field structured result.

- [ ] Explain why the skill now starts from current signal and impact instead of jumping straight to a cause label.
- [ ] Explain why recent changes are compared against the incident timeline but are not treated as proof without corroborating logs or verification signals.
- [ ] Explain why "dependency-vs-local evidence" matters: it forces the model to compare dependency outage, bad deploy, capacity saturation, noisy alert, insufficient context, and unknown before choosing.
- [ ] Explain why the output schema did not change: better reasoning instructions should still feed the same validator, evidence citation checker, safety gate, and renderer.
- [ ] Explain why the skill says not to call tools or create tickets: the workflow supplies evidence, and this PoC recommends bounded next actions rather than taking operational authority.
- [ ] Explain why verification plans should include concrete recovery checks that a human can use to confirm or falsify the recommendation.
- [ ] Explain why the skill contract test is intentionally prompt-facing: it protects the domain reasoning boundary without asserting brittle provider wording.

### Why This Matters

This is the smallest useful step toward more agentic incident investigation. The prompt now has a recognizable human triage path, but the architecture is still deterministic where it needs to be: code gathers evidence, validates citations, applies safety, and reports provenance. That keeps the PoC educational and trustworthy while making the LLM's contribution more realistic.
