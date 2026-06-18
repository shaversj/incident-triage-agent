import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertValidResponseOutcome } from "./support/outcomes";

const runDockerE2E = process.env.RUN_DOCKER_E2E === "1";

const scenarios = [
  {
    name: "checkout-payment-timeout",
    fixture: "checkout-payment-timeout-webhook.json",
    endpoint: "/checkout",
    request: { checkout_id: "e2e-checkout-001" },
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
    fixture: "capacity-saturation-webhook.json",
    endpoint: "/capacity",
    request: { incident_id: "e2e-capacity-001" },
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
    fixture: "bad-deploy-latency-webhook.json",
    endpoint: "/bad-deploy",
    request: { incident_id: "e2e-bad-deploy-001" },
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

describe.skipIf(!runDockerE2E)("Grafana/Loki Docker E2E", () => {
  test("Grafana payloads and Loki logs reach agent for scenario matrix", async () => {
    assertDockerAvailable();
    runCompose(["up", "-d", "--build"]);
    try {
      await waitForUrl("http://localhost:3100/ready");
      await waitForUrl("http://localhost:8081/health");

      for (const scenario of scenarios) {
        const serviceResponse = await generateScenarioLogs(scenario.endpoint, scenario.request);
        expect(serviceResponse).toMatchObject({
          status: "accepted",
          service: scenario.service,
        });
        expect(Number(serviceResponse.log_count)).toBeGreaterThanOrEqual(2);

        const response = await postGrafanaPayload("local-webhook-secret", scenario.fixture);
        expect((response.incident as any).service).toBe(scenario.service);
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
      }
    } finally {
      runCompose(["down", "-v"], false);
    }
  }, 180_000);
});

async function generateScenarioLogs(endpoint: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`http://localhost:8081${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return await response.json() as Record<string, any>;
}

async function postGrafanaPayload(webhookSecret: string, fixtureName: string): Promise<Record<string, any>> {
  const payload = JSON.parse(readFileSync(`fixtures/grafana/${fixtureName}`, "utf8")) as {
    alerts: Array<Record<string, unknown>>;
  };
  const now = new Date().toISOString();
  for (const alert of payload.alerts) {
    alert.startsAt = now;
  }
  const response = await fetch("http://localhost:8080/webhooks/grafana", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": webhookSecret,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  return await response.json() as Record<string, any>;
}

function logEvidence(response: Record<string, any>): string[] {
  return (response.evidence ?? [])
    .filter((item: Record<string, unknown>) => item.source === "log")
    .map((item: Record<string, unknown>) => String(item.summary ?? ""));
}

async function waitForUrl(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function runCompose(args: string[], check = true): void {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (check && result.status !== 0) {
    throw new Error(`docker compose failed with status ${result.status}`);
  }
}

function assertDockerAvailable(): void {
  const result = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("docker is not installed");
  }
}
