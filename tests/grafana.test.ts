import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeGrafanaPayload } from "../src/grafana";

test("Grafana payload normalizes to raw incident without answer fields", () => {
  const normalized = normalizeGrafanaPayload(payload());

  expect(normalized.scenarioName).toBe("grafana-checkout-api");
  expect(normalized.incident.incidentId).toBe("GRAFANA-checkout-latency-001");
  expect(normalized.incident.service).toBe("checkout-api");
  expect(normalized.incident.status).toBe("active");
  expect(normalized.incident.alerts).toContain("checkout-api HighLatency");
  expect(normalized.incident.runbookRefs).toEqual(["dependency-outage"]);
  expect(normalized.lokiQueryLabels).toEqual({ service: "checkout-api" });
  expect(normalized.ignored).toBe(false);
});

test("resolved Grafana payload is ignored before triage", () => {
  const body = payload();
  body.status = "resolved";
  for (const alert of body.alerts) {
    alert.status = "resolved";
  }

  const normalized = normalizeGrafanaPayload(body);

  expect(normalized.ignored).toBe(true);
  expect(normalized.ignoredReason).toBe("resolved_alert");
  expect(normalized.incident.status).toBe("resolved");
});

test("Grafana payload rejects answer-like fields", () => {
  const body = payload();
  body.alerts[0].suspected_causes = ["bad deploy"];

  expect(() => normalizeGrafanaPayload(body)).toThrow("prohibited answer fields");
});

function payload(): any {
  return JSON.parse(readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8"));
}
