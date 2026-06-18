import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import {
  FlueDecisionClient,
  StaticDecisionClient,
  parseDecisionText,
  validateDecisionPayload,
} from "../src/llm";
import type { AppConfig } from "../src/config";

test("valid decision payload parses into bounded decision", () => {
  const package_ = evidencePackage();

  const result = parseDecisionText(JSON.stringify({
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: ["Recent deploy is weaker than timeout evidence."],
    verification_plan: ["Watch payment timeout rate."],
  }), package_);

  expect(result.valid).toBe(true);
  expect(result.decision?.incidentClass).toBe("dependency_outage");
  expect(result.decision?.nextAction).toBe("escalate_owner");
});

test("malformed JSON is rejected as recoverable validation failure", () => {
  const result = parseDecisionText("{not json", evidencePackage());

  expect(result.valid).toBe(false);
  expect(result.errors[0]).toContain("JSON");
});

test("unknown evidence IDs fail before safety policy", () => {
  expect(() => validateDecisionPayload({
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["prior_incident:0"],
    caveats: [],
    verification_plan: ["Watch payment timeout rate."],
  }, evidencePackage())).toThrow("unknown evidence IDs");
});

test("low confidence fails closed", () => {
  expect(() => validateDecisionPayload({
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.2,
    evidence_ids: ["alert:0"],
    caveats: [],
    verification_plan: [],
  }, evidencePackage())).toThrow("too low");
});

test("static decision client returns configured scenario response", async () => {
  const package_ = evidencePackage();
  const client = new StaticDecisionClient({
    "checkout-payment-timeout": JSON.stringify({
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:0"],
      caveats: [],
      verification_plan: ["Watch latency."],
    }),
  });

  const result = await client.decide(package_);

  expect(result.valid).toBe(true);
  expect(result.decision?.incidentClass).toBe("dependency_outage");
});

test("Flue decision client validates injected skill runner output", async () => {
  const client = new FlueDecisionClient(appConfig(), async () => ({
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:0"],
    caveats: [],
    verification_plan: ["Watch latency."],
  }));

  const result = await client.decide(evidencePackage());

  expect(result.valid).toBe(true);
  expect(result.decision?.evidenceIds).toEqual(["alert:0"]);
});

function evidencePackage() {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  return loadTools("fixtures").buildEvidencePackage(scenario);
}

function appConfig(): AppConfig {
  return {
    minimaxApiKey: "secret-key",
    modelName: "MiniMax-M2.7",
    minimaxBaseUrl: "https://api.minimax.io",
    redacted: {
      MINIMAX_API_KEY: "<redacted>",
      MODEL_NAME: "MiniMax-M2.7",
      MINIMAX_BASE_URL: "https://api.minimax.io",
    },
  };
}
