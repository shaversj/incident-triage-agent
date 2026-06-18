import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import { StaticDecisionClient } from "../src/llm";
import { LokiClient, type LokiLogEntry } from "../src/loki";
import { handleGrafanaWebhook, type WebhookRuntime } from "../src/server";
import { TriageWorkflow } from "../src/workflow";
import {
  assertRecoverableResponse,
  assertRecoverableRun,
  assertValidResponseOutcome,
  assertValidRunOutcome,
} from "./support/outcomes";

test("valid run helper accepts expected outcome", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.86,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });

  assertValidRunOutcome(run, {
    incidentClass: "dependency_outage",
    nextAction: "escalate_owner",
    evidencePrefixes: ["alert:", "log:", "runbook:"],
    citedSources: ["alert", "log", "runbook"],
    citedTiers: ["current_signal", "operational_context", "guidance"],
    safetyStatus: "safe_recommendation",
    approvalRequired: false,
    scorecardChecks: ["state_correctness", "evidence_grounding"],
  });
});

test("valid response helper accepts expected outcome", async () => {
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
    scorecardChecks: ["state_correctness", "evidence_grounding"],
  });
});

test("valid run helper reports expected contract failure", async () => {
  const run = await runWithResponse("checkout-payment-timeout", {
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.86,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  });

  expect(() => assertValidRunOutcome(run, { incidentClass: "bad_deploy" })).toThrow();
});

test("recoverable helpers accept invalid provider output", async () => {
  const run = await runWithStaticText("checkout-payment-timeout", "{not json");
  assertRecoverableRun(run, "JSON");

  const [, response] = await handleGrafanaWebhook(
    payload(),
    "test-secret",
    runtime(new StaticDecisionClient({ "grafana-checkout-api": "{not json" })),
  );
  assertRecoverableResponse(response, "JSON");
});

async function runWithResponse(scenarioName: string, response: object) {
  return runWithStaticText(scenarioName, JSON.stringify(response));
}

async function runWithStaticText(scenarioName: string, text: string) {
  const scenario = loadScenario("fixtures", scenarioName);
  const workflow = new TriageWorkflow(
    loadTools("fixtures"),
    new StaticDecisionClient({ [scenarioName]: text }),
  );
  return workflow.run(scenario);
}

function runtime(llmClient = defaultLlm()): WebhookRuntime {
  return {
    fixturesDir: "fixtures",
    webhookSecret: "test-secret",
    llmClient,
    lokiClient: new FakeLokiClient(),
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

class FakeLokiClient {
  async queryRange(): Promise<LokiLogEntry[]> {
    return [{ timestampNs: "1781622420000000000", line: "payment timeout after 3000ms", labels: { service: "checkout-api" } }];
  }

  toEvidence(entries: LokiLogEntry[]) {
    return LokiClient.toEvidence(entries);
  }
}

function payload(): any {
  return JSON.parse(readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8"));
}
