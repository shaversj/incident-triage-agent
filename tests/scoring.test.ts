import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { TriageWorkflow } from "../src/workflow";

test("dependency outage scores success for escalation", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: ["Checkout deploy is lower-confidence context."],
    verification_plan: ["Watch payment-gateway timeout rate."],
  });

  expect(Object.values(run.scorecard?.scores ?? {}).every(Boolean)).toBe(true);
});

test("bad deploy scores approval-gated path", async () => {
  const run = await runWithResponse("bad-deploy-latency", {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.9,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: ["Check checkout latency and error burn."],
  });

  expect(run.states).toContain("simulated_action_recorded");
  expect(run.scorecard?.scores.safety_behavior).toBe(true);
});

test("scorecard distinguishes wrong classification", async () => {
  const run = await runWithResponse("capacity-saturation", {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.75,
    evidence_ids: ["alert:0", "log:0", "runbook:capacity-saturation"],
    caveats: [],
    verification_plan: ["Check CPU."],
  });

  expect(run.scorecard?.scores.classification_quality).toBe(false);
});

test("scorecard notes missing required evidence prefixes", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:1", "log:0"],
    caveats: [],
    verification_plan: ["Watch payment-gateway timeout rate."],
  });

  expect(run.scorecard?.scores.evidence_grounding).toBe(false);
  expect(run.scorecard?.notes).toContain("Missing required evidence prefixes: runbook:");
});

test("scorecard flags historical-only evidence quality", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["prior:INC-2025-102"],
    caveats: ["Only historical evidence was cited."],
    verification_plan: ["Watch payment-gateway timeout rate."],
  });

  expect(run.scorecard?.scores.evidence_quality).toBe(false);
  expect(run.scorecard?.notes).toContain(
    "Weak evidence quality: cited evidence lacks current or operational support.",
  );
});

async function runWithResponse(scenarioName: string, response: object) {
  const scenario = loadScenario("fixtures", scenarioName);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({ [scenarioName]: JSON.stringify(response) }),
  );
  return workflow.run(scenario);
}
