import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { sanitizedSummary } from "../scripts/run-recorded-triage";

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
  const summary = sanitizedSummary("checkout-payment-timeout", "mock", 200, response, {
    source: "recorded Grafana webhook + recorded Loki-shaped logs",
    alerts: ["checkout-api HighLatency", "payment-gateway ElevatedErrors"],
    service: "checkout-api",
    severity: "SEV2",
    started_at: "2026-06-16T14:07:00Z",
    log_records: 3,
  });

  expect(summary.scenario).toBe("checkout-payment-timeout");
  expect(summary.mode).toBe("mock");
  expect(summary.status_code).toBe(200);
  expect(summary.input).toEqual({
    source: "recorded Grafana webhook + recorded Loki-shaped logs",
    alerts: ["checkout-api HighLatency", "payment-gateway ElevatedErrors"],
    service: "checkout-api",
    severity: "SEV2",
    started_at: "2026-06-16T14:07:00Z",
    log_records: 3,
  });
  expect(summary.run_status).toBe("completed");
  expect(summary.finding_summary).toBe("Checkout latency points upstream.");
  expect((summary.recommendation as Record<string, unknown>).rationale).toBe("Escalate the owner.");
  expect((summary.decision as Record<string, unknown>).incident_class).toBe("dependency_outage");
  expect(summary).not.toHaveProperty("evidence");
  expect(summary).not.toHaveProperty("states");
});

test("recorded triage output groups input separately from run decision and safety", () => {
  const result = spawnSync("npm", ["run", "triage:recorded"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("\nINPUT\n");
  expect(result.stdout).toContain("- source: recorded Grafana webhook + recorded Loki-shaped logs");
  expect(result.stdout).toContain("\nRUN\n");
  expect(result.stdout).toContain("- explanation_validation: valid");
  expect(result.stdout).toContain("\nFINDING\n");
  expect(result.stdout).toContain("\nDECISION\n");
  expect(result.stdout).toContain("\nSAFETY\n");
  expect(result.stdout.indexOf("\nINPUT\n")).toBeLessThan(result.stdout.indexOf("\nRUN\n"));
});
