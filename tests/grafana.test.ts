import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeGrafanaPayload, signGrafanaWebhookBody, verifyGrafanaWebhookHmac } from "../src/grafana";

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

test("Grafana HMAC verification accepts fresh raw-body signature", () => {
  const rawBody = JSON.stringify(payload());
  const now = new Date("2026-08-01T12:00:00.000Z");
  const timestamp = unixTimestamp(now);
  const signature = signGrafanaWebhookBody(rawBody, "secret", timestamp);

  expect(() => verifyGrafanaWebhookHmac({
    rawBody,
    secret: "secret",
    signature,
    timestamp,
    now,
  })).not.toThrow();
});

test("Grafana HMAC verification rejects invalid signature and stale timestamp", () => {
  const rawBody = JSON.stringify(payload());
  const now = new Date("2026-08-01T12:00:00.000Z");
  const timestamp = unixTimestamp(now);
  const staleTimestamp = unixTimestamp(new Date("2026-08-01T11:00:00.000Z"));

  expect(() => verifyGrafanaWebhookHmac({
    rawBody,
    secret: "secret",
    signature: "bad",
    timestamp,
    now,
  })).toThrow("Invalid Grafana HMAC signature");

  expect(() => verifyGrafanaWebhookHmac({
    rawBody,
    secret: "secret",
    signature: signGrafanaWebhookBody(rawBody, "secret", staleTimestamp),
    timestamp: staleTimestamp,
    now,
  })).toThrow("stale");
});

function payload(): any {
  return JSON.parse(readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8"));
}

function unixTimestamp(date: Date): string {
  return `${Math.floor(date.getTime() / 1000)}`;
}
