import { expect, test } from "vitest";
import { sanitizedSummary, validateLiveConfig } from "../scripts/run-live-e2e-probe";

test("sanitizedSummary keeps only safe operator fields", () => {
  const response = {
    incident: { incident_id: "GRAFANA-checkout-latency-001" },
    run_id: "triage-run:grafana-checkout-api",
    run_status: "completed",
    investigation: { summary: "Collected evidence.", steps: [] },
    validation: { valid: true, errors: [] },
    explanation_validation: { status: "valid", warnings: [] },
    finding_summary: "Checkout latency points upstream.",
    recommendation: { rationale: "Escalate the owner.", evidence_ids: ["alert:1"] },
    decision: {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.92,
      evidence_ids: ["alert:1", "log:0"],
    },
    provenance: { cited_tiers: ["current_signal", "operational_context"] },
    safety: { status: "safe_recommendation", approval_required: false },
    scorecard: { scores: { state_correctness: true } },
    evidence: [{ detail: "raw evidence detail" }],
    states: ["received"],
  };
  const serviceResponse = { status: "accepted", log_count: 3 };

  const summary = sanitizedSummary(response, serviceResponse);

  expect(summary.checkout_response).toBe(serviceResponse);
  expect(summary.run_status).toBe("completed");
  expect(summary.finding_summary).toBe("Checkout latency points upstream.");
  expect((summary.recommendation as Record<string, unknown>).rationale).toBe("Escalate the owner.");
  expect((summary.decision as Record<string, unknown>).incident_class).toBe("dependency_outage");
  expect(summary).not.toHaveProperty("evidence");
  expect(summary).not.toHaveProperty("states");
});

test("validateLiveConfig rejects missing required provider values", () => {
  expect(() => validateLiveConfig({ MODEL_NAME: "MiniMax-M2.7" })).toThrow("MINIMAX_API_KEY");
});

test("validateLiveConfig rejects placeholder values without printing secret", () => {
  expect(() => validateLiveConfig({
    MINIMAX_API_KEY: "replace-with-your-minimax-api-key",
    MODEL_NAME: "MiniMax-M2.7",
  })).toThrow("placeholder");
});

test("validateLiveConfig accepts required provider values", () => {
  expect(() => validateLiveConfig({
    MINIMAX_API_KEY: "test-key",
    MODEL_NAME: "MiniMax-M2.7",
  })).not.toThrow();
});
