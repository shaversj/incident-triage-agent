import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { StaticDecisionClient } from "../src/llm";
import { LokiClient, type LokiLogEntry } from "../src/loki";
import { handleGrafanaWebhook, type WebhookRuntime } from "../src/server";

test("webhook rejects invalid secret", async () => {
  const [status, response] = await handleGrafanaWebhook(payload(), "wrong-secret", runtime());

  expect(status).toBe(401);
  expect(response.error).toBe("unauthorized");
});

test("valid webhook returns triage JSON with Loki evidence", async () => {
  const loki = new FakeLokiClient();

  const [status, response] = await handleGrafanaWebhook(payload(), "test-secret", runtime(loki));

  expect(status).toBe(200);
  expect(response.status).toBe("ok");
  expect((response.incident as any).service).toBe("checkout-api");
  expect((response.decision as any).incident_class).toBe("dependency_outage");
  expect((response.decision as any).evidence_ids).toContain("log:0");
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
    runtime(new FakeLokiClient(), new StaticDecisionClient({ "grafana-checkout-api": "{not json" })),
  );

  expect(status).toBe(200);
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

class FakeLokiClient {
  lastQuery?: Record<string, unknown>;

  async queryRange(
    labels: Record<string, string>,
    startNs: number,
    endNs: number,
    options: { limit?: number; direction?: "forward" | "backward" },
  ): Promise<LokiLogEntry[]> {
    this.lastQuery = { labels, startNs, endNs, limit: options.limit, direction: options.direction };
    return [{ timestampNs: "1781622420000000000", line: "payment timeout after 3000ms", labels }];
  }

  toEvidence(entries: LokiLogEntry[]) {
    return LokiClient.toEvidence(entries);
  }
}

function runtime(lokiClient?: FakeLokiClient, llmClient = defaultLlm()): WebhookRuntime {
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
