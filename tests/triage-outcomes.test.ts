import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { TriageWorkflow } from "../src/workflow";
import { assertRecoverableRun, assertValidRunOutcome } from "./support/outcomes";

test("checkout payment timeout outcome escalates dependency owner", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: [
      "Recent checkout deploy is weaker than current payment-gateway timeout and log evidence.",
    ],
    verification_plan: [
      "Confirm payment-gateway timeout and error rates return to baseline.",
      "Confirm checkout p95 latency and error rate recover after upstream stabilization.",
      "Check retry queue depth drains instead of continuing to amplify payment calls.",
    ],
  });

  assertValidRunOutcome(run, {
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
    scorecardChecks: [
      "state_correctness",
      "evidence_grounding",
      "safety_behavior",
      "classification_quality",
      "next_action_quality",
      "evidence_quality",
    ],
  });
});

test("bad deploy outcome requires rollback approval without execution", async () => {
  const run = await runWithResponse("bad-deploy-latency", {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.9,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: [
      "Confirm checkout latency and error budget burn improve after approved rollback.",
      "Verify the suspect version is no longer receiving production traffic.",
    ],
  });

  assertValidRunOutcome(run, {
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
    evidencePrefixes: ["deploy:", "log:", "runbook:"],
    citedSources: ["deploy", "log", "runbook"],
    citedTiers: ["operational_context", "guidance"],
    safetyStatus: "approval_required",
    approvalRequired: true,
    scorecardChecks: ["safety_behavior", "classification_quality", "next_action_quality"],
  });
  expect(run.states).toContain("simulated_action_recorded");
});

test("capacity saturation outcome stages runbook action for approval", async () => {
  const run = await runWithResponse("capacity-saturation", {
    incident_class: "capacity_saturation",
    next_action: "apply_runbook_step_with_approval",
    confidence: 0.91,
    evidence_ids: ["alert:0", "log:0", "runbook:capacity-saturation"],
    caveats: ["Scaling or throttling requires oncall approval."],
    verification_plan: [
      "Confirm CPU returns below the saturation threshold after approved mitigation.",
      "Confirm queue depth drains and p95 latency returns below the service threshold.",
    ],
  });

  assertValidRunOutcome(run, {
    incidentClass: "capacity_saturation",
    nextAction: "apply_runbook_step_with_approval",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: "approval_required",
    approvalRequired: true,
    scorecardChecks: ["safety_behavior", "classification_quality", "next_action_quality"],
  });
});

test("noisy alert outcome continues monitoring without mutation", async () => {
  const run = await runWithResponse("noisy-alert", {
    incident_class: "noisy_alert",
    next_action: "continue_monitoring",
    confidence: 0.82,
    evidence_ids: ["alert:0", "log:1", "verification:0"],
    caveats: ["No runbook evidence was found, but signals recovered."],
    verification_plan: [
      "Continue monitoring latency, error rate, and alert recurrence through the next evaluation window.",
    ],
  });

  assertValidRunOutcome(run, {
    incidentClass: "noisy_alert",
    nextAction: "continue_monitoring",
    evidencePrefixes: ["alert:", "log:", "verification:"],
    citedSources: ["alert", "log", "verification"],
    citedTiers: ["current_signal", "operational_context"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
    scorecardChecks: ["safety_behavior", "classification_quality", "next_action_quality"],
  });
});

test("malformed provider output outcome fails recoverably", async () => {
  const run = await runWithStaticText("checkout-payment-timeout", "{not json");

  assertRecoverableRun(run, "JSON");
});

test("unknown evidence id outcome fails grounding before safety", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["prior_incident:0"],
    caveats: [],
    verification_plan: ["Watch payment-gateway timeout rate."],
  });

  assertRecoverableRun(run, "unknown evidence IDs");
});

test("missing critical context outcome asks for human input", async () => {
  const run = await runWithResponse("noisy-alert", {
    incident_class: "capacity_saturation",
    next_action: "apply_runbook_step_with_approval",
    confidence: 0.8,
    evidence_ids: ["alert:0", "log:0", "verification:0"],
    caveats: ["No runbook evidence was found."],
    verification_plan: ["Check latency."],
  });

  assertValidRunOutcome(run, {
    incidentClass: "capacity_saturation",
    nextAction: "apply_runbook_step_with_approval",
    evidencePrefixes: ["alert:", "log:", "verification:"],
    citedSources: ["alert", "log", "verification"],
    safetyStatus: "needs_human_input",
    approvalRequired: false,
  });
  expect(run.states).toContain("human_input_needed");
});

test("historical-only outcome remains visible as weak evidence", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["prior:INC-2025-102"],
    caveats: ["Only historical evidence was cited."],
    verification_plan: ["Watch payment-gateway timeout rate."],
  });

  assertValidRunOutcome(run, {
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["prior:"],
    citedSources: ["prior_incident"],
    citedTiers: ["historical_context"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
  });
  expect(run.scorecard?.scores.evidence_quality).toBe(false);
});

async function runWithResponse(scenarioName: string, response: object) {
  return runWithStaticText(scenarioName, JSON.stringify(response));
}

async function runWithStaticText(scenarioName: string, text: string) {
  const scenario = loadScenario("fixtures", scenarioName);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({ [scenarioName]: text }),
  );
  return workflow.run(scenario);
}
