import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { StaticDecisionClient } from "../src/llm";
import { mockDecisionForName } from "../src/mock-decisions";
import { RecordedLokiClient } from "../src/recorded-observability";
import { handleGrafanaWebhook, type WebhookRuntime } from "../src/server";
import { assertIgnoredResponse, assertRecoverableResponse, assertValidResponseOutcome } from "./support/outcomes";

const scenarios = [
  {
    name: "checkout-payment-timeout",
    webhookFixture: "checkout-payment-timeout-webhook.json",
    logFixture: "checkout-payment-timeout",
    grafanaScenario: "grafana-checkout-api",
    service: "checkout-api",
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
    logContains: "payment timeout",
  },
  {
    name: "capacity-saturation",
    webhookFixture: "capacity-saturation-webhook.json",
    logFixture: "capacity-saturation",
    grafanaScenario: "grafana-search-api",
    service: "search-api",
    incidentClass: "capacity_saturation",
    nextAction: "apply_runbook_step_with_approval",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    safetyStatus: "approval_required",
    approvalRequired: true,
    logContains: "queue_depth",
  },
  {
    name: "bad-deploy-latency",
    webhookFixture: "bad-deploy-latency-webhook.json",
    logFixture: "bad-deploy-latency",
    grafanaScenario: "grafana-bad-deploy-latency",
    service: "checkout-api",
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
    evidencePrefixes: ["alert:", "deploy:", "log:", "runbook:"],
    citedSources: ["alert", "deploy", "log", "runbook"],
    safetyStatus: "approval_required",
    approvalRequired: true,
    logContains: "v2.19.0",
  },
];

test.each(scenarios)("recorded observability replay handles $name", async (scenario) => {
  const lokiClient = RecordedLokiClient.fromFixture(scenario.logFixture);
  const [status, response] = await handleGrafanaWebhook(
    payload(scenario.webhookFixture),
    "test-secret",
    runtime(scenario.grafanaScenario, lokiClient),
  );

  expect(status).toBe(200);
  expect((response.incident as any).service).toBe(scenario.service);
  expect(lokiClient.lastQuery?.labels).toEqual({ service: scenario.service });
  assertValidResponseOutcome(response, {
    incidentClass: scenario.incidentClass,
    nextAction: scenario.nextAction,
    evidencePrefixes: scenario.evidencePrefixes,
    citedSources: scenario.citedSources,
    availableTiers: ["current_signal", "operational_context", "guidance"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: scenario.safetyStatus,
    approvalRequired: scenario.approvalRequired,
  });
  expect(logEvidence(response).some((summary) => summary.includes(scenario.logContains))).toBe(true);
});

test("recorded observability replay preserves missing log context", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload("checkout-payment-timeout-webhook.json"),
    "test-secret",
    {
      fixturesDir: "fixtures",
      webhookSecret: "test-secret",
      llmClient: new StaticDecisionClient({
        "grafana-checkout-api": JSON.stringify({
          incident_class: "dependency_outage",
          next_action: "escalate_owner",
          confidence: 0.81,
          evidence_ids: ["alert:0", "runbook:dependency-outage"],
          caveats: ["Recorded log fixture is empty for this alert window."],
          verification_plan: ["Keep watching timeout rate."],
        }),
      }),
      lokiClient: RecordedLokiClient.fromFixture("empty"),
      lokiLimit: 20,
    },
  );

  expect(status).toBe(200);
  assertValidResponseOutcome(response, {
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["alert:", "runbook:"],
    citedTiers: ["current_signal", "guidance"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
  });
  expect((response.provenance as any).missing_context).toContain("logs");
});

test("recorded observability replay ignores resolved alerts before triage", async () => {
  const body = payload("checkout-payment-timeout-webhook.json");
  body.status = "resolved";
  for (const alert of body.alerts) {
    alert.status = "resolved";
  }

  const [status, response] = await handleGrafanaWebhook(
    body,
    "test-secret",
    runtime("grafana-checkout-api", RecordedLokiClient.fromFixture("checkout-payment-timeout")),
  );

  assertIgnoredResponse(status, response, "resolved_alert");
});

test("recorded observability replay keeps invalid LLM output recoverable", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload("checkout-payment-timeout-webhook.json"),
    "test-secret",
    {
      fixturesDir: "fixtures",
      webhookSecret: "test-secret",
      llmClient: new StaticDecisionClient({ "grafana-checkout-api": "{not json" }),
      lokiClient: RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      lokiLimit: 20,
    },
  );

  expect(status).toBe(200);
  assertRecoverableResponse(response, "JSON");
});

function runtime(grafanaScenario: string, lokiClient: RecordedLokiClient): WebhookRuntime {
  const llmClient = new StaticDecisionClient({
    [grafanaScenario]: JSON.stringify(mockDecisionForName(grafanaScenario)),
  });
  return {
    fixturesDir: "fixtures",
    webhookSecret: "test-secret",
    llmClient,
    lokiClient,
    lokiLimit: 20,
  };
}

function payload(name: string): any {
  return JSON.parse(readFileSync(`fixtures/grafana/${name}`, "utf8"));
}

function logEvidence(response: Record<string, any>): string[] {
  return (response.evidence ?? [])
    .filter((item: Record<string, unknown>) => item.source === "log")
    .map((item: Record<string, unknown>) => String(item.summary ?? ""));
}
