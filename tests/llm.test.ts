import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { loadTools } from "../src/evidence";
import {
  FlueDecisionClient,
  StaticDecisionClient,
  parseFlueRunOutput,
  parseDecisionText,
  runIncidentTriageSkill,
  validateDecisionPayload,
  validateTriagePayload,
} from "../src/llm";
import type { AppConfig } from "../src/config";
import { noopLogger } from "../src/logger";

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

test("expanded triage payload validates explanation and bounded decision", () => {
  const result = validateTriagePayload({
    analysis: {
      hypotheses: [{
        label: "payment timeout pattern",
        status: "supported",
        supporting_evidence_ids: ["alert:1", "log:0"],
        contradicting_evidence_ids: ["deploy:0"],
      }],
    },
    finding_summary: "Payment timeout evidence points upstream.",
    recommendation: {
      rationale: "Escalate the owner because timeout evidence points to the payment dependency.",
      evidence_ids: ["alert:1", "log:0"],
    },
    decision: {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
      caveats: ["Recent deploy is weaker than timeout evidence."],
      verification_plan: ["Watch payment timeout rate."],
    },
  }, evidencePackage());

  expect(result.decision?.incidentClass).toBe("dependency_outage");
  expect(result.explanationValidation?.status).toBe("valid");
  expect(result.explanation?.hypotheses?.[0]?.supportingEvidenceIds).toEqual(["alert:1", "log:0"]);
  expect(result.explanation?.findingSummary).toContain("Payment timeout");
  expect(result.explanation?.recommendation?.evidenceIds).toEqual(["alert:1", "log:0"]);
});

test("valid decision with malformed explanation is accepted with warnings", () => {
  const result = validateTriagePayload({
    analysis: {
      hypotheses: [{
        label: "payment timeout pattern",
        status: "supported",
        supporting_evidence_ids: ["unknown:0"],
        contradicting_evidence_ids: [],
      }],
    },
    finding_summary: "",
    recommendation: {
      next_action: "escalate_owner",
      rationale: "Escalate based on timeout evidence.",
      evidence_ids: ["alert:1"],
    },
    decision: {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
      caveats: [],
      verification_plan: ["Watch payment timeout rate."],
    },
  }, evidencePackage());

  expect(result.decision?.incidentClass).toBe("dependency_outage");
  expect(result.explanationValidation?.status).toBe("degraded");
  expect(result.explanationValidation?.warnings.join(" ")).toContain("unknown evidence IDs");
  expect(result.explanationValidation?.warnings.join(" ")).toContain("must not include next_action");
  expect(result.explanation?.hypotheses).toBeUndefined();
});

test("explanation warns on unsupported deploy timing and dependency owner claims", () => {
  const package_ = evidencePackage();
  const staleDeployPackage = loadTools("fixtures").buildEvidencePackageFromIncident(
    package_.scenarioName,
    { ...package_.incident, startedAt: "2026-06-16T14:07:00Z" },
  );
  const result = validateTriagePayload({
    analysis: {
      hypotheses: [{
        label: "payment gateway owner should investigate",
        status: "supported",
        supporting_evidence_ids: ["alert:1", "log:0"],
        contradicting_evidence_ids: ["deploy:0"],
      }],
    },
    finding_summary: "The checkout-api deploy happened nineteen minutes before the incident, but payment gateway evidence is stronger.",
    recommendation: {
      rationale: "Escalate to the payment gateway owner.",
      evidence_ids: ["alert:1", "log:0"],
    },
    decision: {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
      caveats: [],
      verification_plan: ["Watch payment timeout rate."],
    },
  }, staleDeployPackage);

  expect(result.decision?.incidentClass).toBe("dependency_outage");
  expect(result.explanationValidation?.status).toBe("degraded");
  expect(result.explanationValidation?.warnings.join(" ")).toContain("deploy timing");
  expect(result.explanationValidation?.warnings.join(" ")).toContain("payment-gateway ownership");
});

test("legacy decision-only payload is accepted with unavailable explanation state", () => {
  const result = validateTriagePayload({
    incident_class: "dependency_outage",
    next_action: "escalate_owner",
    confidence: 0.88,
    evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
    caveats: ["Recent deploy is weaker than timeout evidence."],
    verification_plan: ["Watch payment timeout rate."],
  }, evidencePackage());

  expect(result.decision?.incidentClass).toBe("dependency_outage");
  expect(result.explanation).toBeUndefined();
  expect(result.explanationValidation?.status).toBe("not_available");
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

test("Flue decision client redacts provider secrets from errors", async () => {
  const client = new FlueDecisionClient(appConfig(), async () => {
    throw new Error("provider rejected secret-key");
  });

  const result = await client.decide(evidencePackage());

  expect(result.valid).toBe(false);
  expect(result.errors[0]).toContain("<redacted>");
  expect(result.errors[0]).not.toContain("secret-key");
});

test("runIncidentTriageSkill parses successful flue run JSON output", async () => {
  const result = await runIncidentTriageSkill(evidencePackage(), appConfig(), noopLogger, async () => ({
    exitCode: 0,
    stderr: "run id: test-run\n",
    stdout: JSON.stringify({
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:0"],
      caveats: [],
      verification_plan: ["Watch latency."],
    }),
  }));

  expect(result).toMatchObject({ incident_class: "dependency_outage" });
});

test("runIncidentTriageSkill reports non-secret flue run failures", async () => {
  await expect(runIncidentTriageSkill(evidencePackage(), appConfig(), noopLogger, async () => ({
    exitCode: 1,
    stderr: "failed with secret-key",
    stdout: "",
  }))).rejects.toThrow("<redacted>");
});

test("runIncidentTriageSkill still accepts an injected executor as third argument", async () => {
  const result = await runIncidentTriageSkill(evidencePackage(), appConfig(), async () => ({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:0"],
      caveats: [],
      verification_plan: ["Watch latency."],
    }),
  }));

  expect(result).toMatchObject({ next_action: "escalate_owner" });
});

test("Flue decision client passes logger to injected skill runner", async () => {
  const debugMessages: string[] = [];
  const logger = {
    debug: (_bindings: unknown, message?: string) => {
      if (message) {
        debugMessages.push(message);
      }
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const client = new FlueDecisionClient(appConfig(), async (_package_, _config, receivedLogger) => {
    receivedLogger.debug({ component: "flue" }, "debug boundary visible");
    return {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:0"],
      caveats: [],
      verification_plan: ["Watch latency."],
    };
  }, logger);

  const result = await client.decide(evidencePackage());

  expect(result.valid).toBe(true);
  expect(debugMessages).toEqual(["debug boundary visible"]);
});

test("parseFlueRunOutput accepts JSON after build output", () => {
  expect(parseFlueRunOutput("built project\n{\"incident_class\":\"dependency_outage\"}")).toEqual({
    incident_class: "dependency_outage",
  });
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
