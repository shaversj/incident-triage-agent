import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { StaticDecisionClient } from "../src/llm";
import { RecordedLokiClient } from "../src/recorded-observability";
import { handleGrafanaWebhook, type WebhookRuntime } from "../src/server";
import {
  assertIgnoredResponse,
  assertRecoverableResponse,
  assertValidResponseOutcome,
} from "./support/outcomes";

test("active webhook outcome includes alert log provenance and safety", async () => {
  const [status, response] = await handleGrafanaWebhook(payload(), "test-secret", runtime());

  expect(status).toBe(200);
  assertValidResponseOutcome(response, {
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    availableTiers: ["current_signal", "operational_context", "guidance"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
    scorecardChecks: ["state_correctness", "evidence_grounding", "safety_behavior", "evidence_quality"],
  });
});

test("resolved webhook outcome is ignored without decision or safety", async () => {
  const body = payload();
  body.status = "resolved";
  for (const alert of body.alerts) {
    alert.status = "resolved";
  }

  const [status, response] = await handleGrafanaWebhook(body, "test-secret", runtime());

  assertIgnoredResponse(status, response, "resolved_alert");
});

test("missing Loki logs outcome preserves missing context", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload(),
    "test-secret",
    runtime(
      new StaticDecisionClient({
        "grafana-checkout-api": JSON.stringify({
          incident_class: "dependency_outage",
          next_action: "escalate_owner",
          confidence: 0.81,
          evidence_ids: ["alert:0", "runbook:dependency-outage"],
          caveats: ["Loki returned no logs for the alert window."],
          verification_plan: ["Keep watching timeout rate."],
        }),
      }),
      RecordedLokiClient.fromFixture("empty"),
    ),
  );

  expect(status).toBe(200);
  assertValidResponseOutcome(response, {
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["alert:", "runbook:"],
    availableTiers: ["current_signal", "operational_context", "guidance"],
    citedTiers: ["current_signal", "guidance"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
  });
  expect((response.provenance as any).missing_context).toContain("logs");
});

test("invalid webhook decision outcome is recoverable", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload(),
    "test-secret",
    runtime(new StaticDecisionClient({ "grafana-checkout-api": "{not json" })),
  );

  expect(status).toBe(200);
  assertRecoverableResponse(response, "JSON");
});

test("capacity webhook outcome requires approval with current and guidance evidence", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload("capacity-saturation-webhook.json"),
    "test-secret",
    runtime(
      new StaticDecisionClient({
        "grafana-search-api": JSON.stringify({
          incident_class: "capacity_saturation",
          next_action: "apply_runbook_step_with_approval",
          confidence: 0.84,
          evidence_ids: ["alert:0", "log:0", "runbook:capacity-saturation"],
          caveats: ["Scaling or throttling changes require approval."],
          verification_plan: ["Check CPU utilization.", "Check queue depth."],
        }),
      }),
      RecordedLokiClient.fromFixture("capacity-saturation"),
    ),
  );

  expect(status).toBe(200);
  expect((response.incident as any).service).toBe("search-api");
  assertValidResponseOutcome(response, {
    incidentClass: "capacity_saturation",
    nextAction: "apply_runbook_step_with_approval",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    availableTiers: ["current_signal", "operational_context", "guidance"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: "approval_required",
    approvalRequired: true,
  });
});

test("bad deploy webhook outcome cites raw deploy evidence", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload("bad-deploy-latency-webhook.json"),
    "test-secret",
    runtime(
      new StaticDecisionClient({
        "grafana-bad-deploy-latency": JSON.stringify({
          incident_class: "bad_deploy",
          next_action: "request_rollback_approval",
          confidence: 0.86,
          evidence_ids: ["alert:0", "deploy:0", "log:0", "runbook:bad-deploy"],
          caveats: ["Rollback requires human approval."],
          verification_plan: ["Check checkout p95 latency.", "Check checkout error budget burn."],
        }),
      }),
      RecordedLokiClient.fromFixture("bad-deploy-latency"),
    ),
  );

  expect(status).toBe(200);
  expect(response.scenario).toBe("grafana-bad-deploy-latency");
  assertValidResponseOutcome(response, {
    incidentClass: "bad_deploy",
    nextAction: "request_rollback_approval",
    evidencePrefixes: ["alert:", "deploy:", "log:", "runbook:"],
    citedSources: ["alert", "deploy", "log", "runbook"],
    availableTiers: ["current_signal", "operational_context", "guidance"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: "approval_required",
    approvalRequired: true,
  });
});

function runtime(llmClient = defaultLlm(), lokiClient: RecordedLokiClient = RecordedLokiClient.fromFixture("checkout-payment-timeout")): WebhookRuntime {
  return {
    fixturesDir: "fixtures",
    webhookSecret: "test-secret",
    llmClient,
    lokiClient,
    lokiLimit: 20,
  };
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

function payload(name = "checkout-payment-timeout-webhook.json"): any {
  return JSON.parse(readFileSync(`fixtures/grafana/${name}`, "utf8"));
}
