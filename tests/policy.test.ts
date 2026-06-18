import { expect, test } from "bun:test";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { parseDecisionText } from "../src/llm";
import { evaluateSafety } from "../src/policy";

test("bad deploy rollback is staged for approval without execution", () => {
  const package_ = packageFor("bad-deploy-latency");
  const validation = parseDecisionText(JSON.stringify({
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.86,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: ["Check latency after rollback."],
  }), package_);

  expect(validation.decision).toBeDefined();
  const safety = evaluateSafety(validation.decision!, package_);

  expect(safety.status).toBe("approval_required");
  expect(safety.approvalRequired).toBe(true);
  expect(safety.stagedPayload?.executed).toBe(false);
  expect(safety.auditEvent?.executed).toBe(false);
});

test("runbook action without runbook needs human input", () => {
  const package_ = packageFor("noisy-alert");
  const validation = parseDecisionText(JSON.stringify({
    incident_class: "capacity_saturation",
    next_action: "apply_runbook_step_with_approval",
    confidence: 0.81,
    evidence_ids: ["alert:0", "log:0", "verification:0"],
    caveats: [],
    verification_plan: ["Check latency."],
  }), package_);

  expect(validation.decision).toBeDefined();
  const safety = evaluateSafety(validation.decision!, package_);

  expect(safety.status).toBe("needs_human_input");
  expect(safety.reason).toContain("Runbook");
});

function packageFor(name: string) {
  return loadTools("fixtures").buildEvidencePackage(loadScenario("fixtures", name));
}
