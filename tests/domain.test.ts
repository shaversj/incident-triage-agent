import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  FixtureError,
  listScenarios,
  loadScenario,
  parseIncidentClass,
  parseNextAction,
  sourceTiers,
} from "../src/domain";

test("loadScenario parses raw fixture and expected metadata", () => {
  const scenario = loadScenario("fixtures", "checkout-payment-timeout");

  expect(scenario.incident.incidentId).toBe("INC-2026-014");
  expect(scenario.expected.incidentClass).toBe("dependency_outage");
  expect(scenario.expected.allowedNextActions).toContain("escalate_owner");
});

test("fixture with prohibited answer fields is rejected", () => {
  const fixtures = mkdtempSync(join(tmpdir(), "incident-triage-fixtures-"));
  mkdirSync(join(fixtures, "scenarios"));
  writeFileSync(
    join(fixtures, "scenarios", "bad.json"),
    JSON.stringify({
      incident: {
        incident_id: "INC-test",
        title: "Bad fixture",
        severity: "SEV4",
        status: "active",
        started_at: "2026-06-14T00:00:00Z",
        service: "checkout-api",
        symptoms: [],
        alerts: [],
        suspected_causes: ["answer leak"],
      },
      expected: {
        incident_class: "unknown",
        allowed_next_actions: ["ask_human"],
      },
    }),
  );

  expect(() => loadScenario(fixtures, "bad")).toThrow(FixtureError);
  expect(() => loadScenario(fixtures, "bad")).toThrow("prohibited answer fields");
});

test("listScenarios returns fixture names", () => {
  const names = listScenarios("fixtures");

  expect(names).toContain("checkout-payment-timeout");
  expect(names).toContain("bad-deploy-latency");
  expect(names).toContain("capacity-saturation");
  expect(names).toContain("noisy-alert");
});

test("taxonomy rejects unknown values", () => {
  expect(() => parseIncidentClass("mystery")).toThrow("Incident class");
  expect(() => parseNextAction("do_anything")).toThrow("Next action");
});

test("source tier values are stable strings", () => {
  expect(sourceTiers).toEqual([
    "current_signal",
    "operational_context",
    "guidance",
    "historical_context",
  ]);
});
