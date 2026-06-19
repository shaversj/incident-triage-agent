import { expect, test } from "vitest";
import { loadScenario } from "../src/domain";
import { EvidencePackage, loadTools, type Evidence } from "../src/evidence";

test("service lookup returns owner and escalation context", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const package_ = loadTools("fixtures").buildEvidencePackage(scenario);

  const service = package_.byId().get("service:checkout-api");

  expect(service?.source).toBe("service");
  expect(service?.sourceTier).toBe("operational_context");
  expect(service?.summary).toContain("Checkout Platform");
  expect(service?.detail).toContain("checkout-platform-oncall");
});

test("runbook lookup returns guidance without answer fields", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const package_ = loadTools("fixtures").buildEvidencePackage(scenario);

  const runbook = package_.byId().get("runbook:dependency-outage");

  expect(runbook?.source).toBe("runbook");
  expect(runbook?.sourceTier).toBe("guidance");
  expect(runbook?.summary).toContain("Dependency Outage Runbook");
  expect(runbook?.detail).not.toContain("incident_class");
  expect(runbook?.detail).not.toContain("next_action");
});

test("prior incident lookup returns stable evidence ID", () => {
  const scenario = loadScenario("fixtures", "bad-deploy-latency");
  const package_ = loadTools("fixtures").buildEvidencePackage(scenario);

  const prior = package_.byId().get("prior:INC-2025-144");

  expect(prior?.source).toBe("prior_incident");
  expect(prior?.sourceTier).toBe("historical_context");
  expect(prior?.summary).toContain("Retry rollout");
});

test("tool sources receive expected tiers", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const evidence = loadTools("fixtures").buildEvidencePackage(scenario).byId();

  expect(evidence.get("alert:0")?.sourceTier).toBe("current_signal");
  expect(evidence.get("symptom:0")?.sourceTier).toBe("current_signal");
  expect(evidence.get("verification:0")?.sourceTier).toBe("current_signal");
  expect(evidence.get("deploy:0")?.sourceTier).toBe("operational_context");
  expect(evidence.get("log:0")?.sourceTier).toBe("operational_context");
  expect(evidence.get("service:checkout-api")?.sourceTier).toBe("operational_context");
});

test("missing runbook is missing context, not a crash", () => {
  const scenario = loadScenario("fixtures", "noisy-alert");
  const package_ = loadTools("fixtures").buildEvidencePackage(scenario);

  expect(package_.missingContext).toContain("runbook");
  expect(package_.ids().has("runbook:dependency-outage")).toBe(false);
});

test("evidence package is deterministic", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const tools = loadTools("fixtures");

  expect(toPlainObject(tools.buildEvidencePackage(scenario))).toEqual(
    toPlainObject(tools.buildEvidencePackage(scenario)),
  );
});

test("evidence package records workflow-authored investigation steps", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const package_ = loadTools("fixtures").buildEvidencePackage(scenario);

  expect(package_.investigationSteps.map((step) => step.kind)).toEqual([
    "inspect_alerts",
    "inspect_symptoms",
    "inspect_deploys",
    "inspect_logs",
    "inspect_service_owner",
    "inspect_runbooks",
    "inspect_prior_incidents",
    "inspect_verification_signals",
  ]);
  expect(package_.investigationSteps.find((step) => step.kind === "inspect_logs")).toMatchObject({
    status: "found",
    evidenceIds: expect.arrayContaining(["log:0"]),
  });
  expect(package_.investigationSteps.every((step) => !step.purpose.includes("LLM"))).toBe(true);
});

test("investigation steps expose missing and skipped evidence lookups", () => {
  const scenario = loadScenario("fixtures", "noisy-alert");
  const incident = { ...scenario.incident, runbookRefs: [], priorIncidentRefs: [], verificationSignals: [] };
  const package_ = loadTools("fixtures").buildEvidencePackageFromIncident("noisy-alert", incident, { logEvidence: [] });

  expect(package_.investigationSteps.find((step) => step.kind === "inspect_logs")).toMatchObject({
    status: "not_found",
    evidenceIds: [],
  });
  expect(package_.investigationSteps.find((step) => step.kind === "inspect_runbooks")).toMatchObject({
    status: "skipped",
    evidenceIds: [],
  });
  expect(package_.investigationSteps.find((step) => step.kind === "inspect_prior_incidents")).toMatchObject({
    status: "skipped",
    evidenceIds: [],
  });
  expect(package_.investigationSteps.find((step) => step.kind === "inspect_verification_signals")).toMatchObject({
    status: "not_found",
    evidenceIds: [],
  });
});

test("external evidence package combines incident and supplied log context", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const logs: Evidence[] = [{
    evidenceId: "log:0",
    source: "log",
    sourceTier: "operational_context",
    summary: "payment timeout after 3000ms",
    detail: "payment timeout after 3000ms",
  }];

  const package_ = loadTools("fixtures").buildEvidencePackageFromIncident(
    "grafana-checkout-api",
    scenario.incident,
    { logEvidence: logs },
  );

  const evidence = package_.byId();
  expect(evidence.get("alert:0")?.sourceTier).toBe("current_signal");
  expect(evidence.get("log:0")?.sourceTier).toBe("operational_context");
  expect(evidence.get("runbook:dependency-outage")?.sourceTier).toBe("guidance");
  expect(evidence.get("service:checkout-api")?.sourceTier).toBe("operational_context");
  expect(package_.missingContext).not.toContain("logs");
});

test("bad deploy evidence falls back to deploy fixture when incident has no recent changes", () => {
  const scenario = loadScenario("fixtures", "noisy-alert");
  const incident = { ...scenario.incident, service: "checkout-api", recentChanges: [] };

  const package_ = loadTools("fixtures").buildEvidencePackageFromIncident("grafana-bad-deploy-latency", incident);

  const deploy = package_.byId().get("deploy:0");
  expect(deploy?.source).toBe("deploy");
  expect(deploy?.sourceTier).toBe("operational_context");
  expect(deploy?.summary).toContain("checkout-api change at 2026-06-16T16:10:00Z");
  expect(deploy?.detail).toContain("v2.19.0");
});

test("provenance summary reports available and cited tiers", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");
  const package_ = new EvidencePackage(
    scenario.name,
    scenario.incident,
    [
      { evidenceId: "alert:0", source: "alert", sourceTier: "current_signal", summary: "High latency", detail: "" },
      { evidenceId: "prior:INC-1", source: "prior_incident", sourceTier: "historical_context", summary: "Similar issue", detail: "" },
    ],
    ["runbook"],
  );

  const summary = package_.provenanceSummary(["prior:INC-1"]);

  expect(summary.availableTiers).toEqual(["current_signal", "historical_context"]);
  expect(summary.citedTiers).toEqual(["historical_context"]);
  expect(summary.citedSources).toEqual(["prior_incident"]);
  expect(summary.missingContext).toEqual(["runbook"]);
  expect(summary.historicalOnly).toBe(true);
  expect(summary.hasCurrentOrOperationalSupport).toBe(false);
});

function toPlainObject(package_: EvidencePackage): object {
  return {
    scenarioName: package_.scenarioName,
    incident: package_.incident,
    evidence: package_.evidence,
    missingContext: package_.missingContext,
    investigationSteps: package_.investigationSteps,
  };
}
