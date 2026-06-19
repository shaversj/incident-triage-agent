import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { TriageWorkflow } from "../src/workflow";

test("valid dependency scenario reaches verification ready and scored", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.84,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Monitor timeout rate."],
  });

  expect(run.states).toContain("verification_ready");
  expect(run.states).toContain("scored");
  expect(run.runStatus).toBe("completed");
  expect(run.runId).toBe("triage-run:checkout-payment-timeout");
  expect(run.investigation?.summary).toContain("investigation step");
  expect(run.investigation?.steps.some((step) => step.kind === "inspect_logs" && step.status === "found")).toBe(true);
});

test("invalid LLM output reaches recoverable failure and scorecard", async () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({ "checkout-payment-timeout": "{not json" }),
  );

  const run = await workflow.run(scenario);

  expect(run.states).toContain("recoverable_failure");
  expect(run.states).toContain("scored");
  expect(run.runStatus).toBe("recoverable_failure");
  expect(run.scorecard).toBeDefined();
});

test("valid decision with degraded explanation still reaches safety and scoring", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    analysis: {
      hypotheses: [{
        label: "payment timeout pattern",
        status: "supported",
        supporting_evidence_ids: ["missing:0"],
        contradicting_evidence_ids: [],
      }],
    },
    finding_summary: "Payment timeout evidence points upstream.",
    recommendation: {
      rationale: "Escalate because payment timeout evidence points to a dependency.",
      evidence_ids: ["alert:1"],
    },
    decision: {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.84,
      evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
      caveats: [],
      verification_plan: ["Monitor timeout rate."],
    },
  });

  expect(run.states).toContain("verification_ready");
  expect(run.safety?.status).toBe("safe_recommendation");
  expect(run.runStatus).toBe("completed");
  expect(run.explanationValidation?.status).toBe("degraded");
  expect(run.explanationValidation?.warnings.join(" ")).toContain("unknown evidence IDs");
});

test("missing critical context moves to human input", async () => {
  const run = await runWithResponse("noisy-alert", {
    incident_class: "capacity_saturation",
    next_action: "apply_runbook_step_with_approval",
    confidence: 0.8,
    evidence_ids: ["alert:0", "log:0", "verification:0"],
    caveats: ["No runbook evidence was found."],
    verification_plan: ["Check latency."],
  });

  expect(run.states).toContain("human_input_needed");
});

async function runWithResponse(scenarioName: string, response: object) {
  const scenario = loadScenario("fixtures", scenarioName);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({ [scenarioName]: JSON.stringify(response) }),
  );
  return workflow.run(scenario);
}
