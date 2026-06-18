import type { Scenario } from "./domain";

export function mockDecisionForScenario(scenario: Scenario): object {
  return mockDecisionForName(scenario.name);
}

export function mockDecisionForName(name: string): object {
  const decisions: Record<string, object> = {
    "checkout-payment-timeout": checkoutDependencyDecision(),
    "grafana-checkout-api": checkoutDependencyDecision(),
    "bad-deploy-latency": badDeployDecision(),
    "grafana-bad-deploy-latency": badDeployDecision(),
    "capacity-saturation": capacityDecision(),
    "grafana-search-api": capacityDecision(),
    "noisy-alert": {
      incident_class: "noisy_alert",
      next_action: "continue_monitoring",
      confidence: 0.78,
      evidence_ids: ["alert:0", "log:1", "verification:0"],
      caveats: ["No runbook was matched, but recovery signals are healthy."],
      verification_plan: ["Continue monitoring latency and error rate."],
    },
  };
  return decisions[name] ?? {
    incident_class: "unknown",
    next_action: "ask_human",
    confidence: 0.7,
    evidence_ids: [],
    caveats: ["No canned mock decision exists for this scenario."],
    verification_plan: [],
  };
}

export function mockDecisionResponses(): Record<string, string> {
  return Object.fromEntries(
    [
      "checkout-payment-timeout",
      "grafana-checkout-api",
      "bad-deploy-latency",
      "grafana-bad-deploy-latency",
      "capacity-saturation",
      "grafana-search-api",
      "noisy-alert",
    ].map((name) => [name, JSON.stringify(mockDecisionForName(name))]),
  );
}

function checkoutDependencyDecision(): object {
  return {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: ["Recent checkout deploy is lower-confidence context than payment timeout evidence."],
    verification_plan: ["Track payment-gateway timeout rate.", "Confirm checkout latency returns below SLO."],
  };
}

function badDeployDecision(): object {
  return {
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
    confidence: 0.9,
    evidence_ids: ["alert:0", "deploy:0", "log:0", "runbook:bad-deploy"],
    caveats: ["Rollback requires human approval."],
    verification_plan: ["Check checkout latency.", "Check error budget burn."],
  };
}

function capacityDecision(): object {
  return {
    incident_class: "capacity_saturation",
    next_action: "apply_runbook_step_with_approval",
    confidence: 0.83,
    evidence_ids: ["alert:0", "log:0", "runbook:capacity-saturation"],
    caveats: ["Scaling or throttling action requires approval."],
    verification_plan: ["Check CPU.", "Check queue depth.", "Check p95 latency."],
  };
}
