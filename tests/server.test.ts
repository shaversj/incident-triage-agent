import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { StaticDecisionClient } from "../src/llm";
import { RecordedLokiClient } from "../src/recorded-observability";
import { handleGrafanaWebhook, type WebhookRuntime } from "../src/server";

test("webhook rejects invalid secret", async () => {
  const [status, response] = await handleGrafanaWebhook(payload(), "wrong-secret", runtime());

  expect(status).toBe(401);
  expect(response.error).toBe("unauthorized");
});

test("valid webhook returns triage JSON with Loki evidence", async () => {
  const loki = RecordedLokiClient.fromFixture("checkout-payment-timeout");

  const [status, response] = await handleGrafanaWebhook(payload(), "test-secret", runtime(loki));

  expect(status).toBe(200);
  expect(response.status).toBe("ok");
  expect(response.run_status).toBe("completed");
  expect((response.incident as any).service).toBe("checkout-api");
  expect((response.investigation as any).summary).toContain("investigation step");
  expect((response.investigation as any).steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "inspect_logs", status: "found" }),
  ]));
  expect((response.decision as any).incident_class).toBe("dependency_outage");
  expect((response.decision as any).evidence_ids).toContain("log:0");
  expect((response.explanation_validation as any).status).toBe("not_available");
  expect((response.safety as any).status).toBe("safe_recommendation");
  expect((response.provenance as any).available_tiers).toContain("current_signal");
  expect((response.provenance as any).available_tiers).toContain("operational_context");
  expect(loki.lastQuery?.labels).toEqual({ service: "checkout-api" });
  expect(loki.lastQuery?.direction).toBe("forward");
});

test("invalid LLM response is recoverable without safety action", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload(),
    "test-secret",
    runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      new StaticDecisionClient({ "grafana-checkout-api": "{not json" }),
    ),
  );

  expect(status).toBe(200);
  expect(response.run_status).toBe("recoverable_failure");
  expect((response.validation as any).valid).toBe(false);
  expect(response).not.toHaveProperty("decision");
  expect(response).not.toHaveProperty("safety");
});

test("resolved webhook is ignored", async () => {
  const body = payload();
  body.status = "resolved";
  for (const alert of body.alerts) {
    alert.status = "resolved";
  }

  const [status, response] = await handleGrafanaWebhook(body, "test-secret", runtime());

  expect(status).toBe(202);
  expect(response.status).toBe("ignored");
  expect(response.reason).toBe("resolved_alert");
});

function runtime(lokiClient?: RecordedLokiClient, llmClient = defaultLlm()): WebhookRuntime {
  const runtime: WebhookRuntime = {
    fixturesDir: "fixtures",
    webhookSecret: "test-secret",
    llmClient,
    lokiLimit: 20,
  };
  if (lokiClient) {
    runtime.lokiClient = lokiClient;
  }
  return runtime;
}

function defaultLlm() {
  return new StaticDecisionClient({
    "grafana-checkout-api": JSON.stringify({
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.87,
      evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
      caveats: ["Synthetic integration path."],
      verification_plan: ["Watch payment timeout rate."],
    }),
  });
}

function payload(): any {
  return JSON.parse(readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8"));
}
