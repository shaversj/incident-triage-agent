import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { parseDecisionText } from "../src/llm";
import { evaluateMitigationControl } from "../src/mitigation-control";

test("bad deploy rollback maps to approval mitigation with dry-run and audit", () => {
  const package_ = packageFor("bad-deploy-latency");
  const decision = decisionFor(package_, {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.86,
    evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: [],
    verification_plan: ["Check latency after rollback."],
  });

  const mitigation = evaluateMitigationControl(decision, package_);

  expect(mitigation.status).toBe("approval_required");
  expect(mitigation.catalogMatch?.catalogId).toBe("rollback-approval");
  expect(mitigation.approvalRequired).toBe(true);
  expect(mitigation.dryRun?.executed).toBe(false);
  expect(mitigation.stagedAction?.executed).toBe(false);
  expect(mitigation.auditEvent?.executed).toBe(false);
  expect(mitigation.verification?.status).toBe("still_unhealthy");
});

test("capacity mitigation requires runbook evidence before staging", () => {
  const package_ = packageFor("noisy-alert");
  const decision = decisionFor(package_, {
    incident_class: "capacity_saturation",
    next_action: "apply_runbook_step_with_approval",
    confidence: 0.81,
    evidence_ids: ["alert:0", "log:0", "verification:0"],
    caveats: [],
    verification_plan: ["Check latency."],
  });

  const mitigation = evaluateMitigationControl(decision, package_);

  expect(mitigation.status).toBe("blocked");
  expect(mitigation.approvalRequired).toBe(false);
  expect(mitigation.stagedAction).toBeUndefined();
  expect(mitigation.reason).toContain("runbook");
});

test("non-mutating monitoring remains recommendation-only without staged action", () => {
  const package_ = packageFor("noisy-alert");
  const decision = decisionFor(package_, {
    incident_class: "noisy_alert",
    next_action: "continue_monitoring",
    confidence: 0.82,
    evidence_ids: ["alert:0", "log:1", "verification:0"],
    caveats: [],
    verification_plan: ["Continue monitoring latency."],
  });

  const mitigation = evaluateMitigationControl(decision, package_);

  expect(mitigation.status).toBe("recommendation_only");
  expect(mitigation.catalogMatch).toBeUndefined();
  expect(mitigation.approvalRequired).toBe(false);
  expect(mitigation.stagedAction).toBeUndefined();
  expect(mitigation.verification?.status).toBe("recovered");
});

function packageFor(name: string) {
  return loadTools("fixtures").buildEvidencePackage(loadScenario("fixtures", name));
}

function decisionFor(package_: ReturnType<typeof packageFor>, payload: object) {
  const validation = parseDecisionText(JSON.stringify(payload), package_);
  if (!validation.decision) {
    throw new Error(`invalid test decision: ${validation.errors.join(", ")}`);
  }
  return validation.decision;
}
