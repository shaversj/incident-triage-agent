import { describe, expect, test } from "vitest";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadDotenv } from "../src/config";
import { incidentClasses, nextActions } from "../src/domain";
import { assertValidResponseOutcome } from "./support/outcomes";

const liveScenarioEnv = "LIVE_E2E_SCENARIOS";
const runLiveE2E = process.env.RUN_LIVE_LLM_E2E === "1";
const showAgentLogs = process.env.LIVE_E2E_SHOW_AGENT_LOGS === "1";

const scenarios = {
  "checkout-payment-timeout": {
    fixture: "checkout-payment-timeout-webhook.json",
    endpoint: "/checkout",
    request: { checkout_id: "live-e2e-checkout-001" },
    service: "checkout-api",
    evidencePrefixes: ["alert:", "log:"],
  },
  "capacity-saturation": {
    fixture: "capacity-saturation-webhook.json",
    endpoint: "/capacity",
    request: { incident_id: "live-e2e-capacity-001" },
    service: "search-api",
    evidencePrefixes: ["alert:", "log:"],
  },
  "bad-deploy-latency": {
    fixture: "bad-deploy-latency-webhook.json",
    endpoint: "/bad-deploy",
    request: { incident_id: "live-e2e-bad-deploy-001" },
    service: "checkout-api",
    evidencePrefixes: ["alert:", "deploy:", "log:"],
  },
};

type ScenarioName = keyof typeof scenarios;

test("empty live scenario selector skips explicitly", () => {
  expect(() => selectedScenarios("")).toThrow("no live E2E scenarios selected");
});

describe.skipIf(!runLiveE2E)("Real service live LLM Docker E2E", () => {
  test("real service logs and live LLM decision reach agent", async () => {
    assertDockerAvailable();
    const selected = selectedScenarios(process.env[liveScenarioEnv] ?? "checkout-payment-timeout");
    const config = liveConfigOrThrow();
    let agentLogs: ChildProcess | undefined;

    runCompose(["up", "-d", "--build"]);
    try {
      if (showAgentLogs) {
        agentLogs = followComposeLogs("agent");
      }
      await waitForUrl("http://localhost:3100/ready");
      await waitForUrl("http://localhost:8081/health");

      for (const [name, scenario] of Object.entries(selected)) {
        const serviceResponse = await generateScenarioLogs(scenario.endpoint, scenario.request);
        expect(serviceResponse).toMatchObject({ status: "accepted", service: scenario.service });

        const response = await postGrafanaPayload(config.GRAFANA_WEBHOOK_SECRET ?? "local-webhook-secret", scenario.fixture);
        expect((response.incident as any).service).toBe(scenario.service);
        assertValidResponseOutcome(response, {
          evidencePrefixes: scenario.evidencePrefixes,
          availableTiers: ["current_signal", "operational_context"],
          citedTiers: ["current_signal", "operational_context"],
          requireSafety: true,
        });
        expect(incidentClasses).toContain((response.decision as any).incident_class);
        expect(nextActions).toContain((response.decision as any).next_action);
        expect(name).toBeTruthy();
      }
    } finally {
      stopProcess(agentLogs);
      runCompose(["down", "-v"], false);
    }
  }, 240_000);
});

function selectedScenarios(raw: string): Partial<typeof scenarios> {
  const requested = raw.split(",").map((name) => name.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new Error(`no live E2E scenarios selected; set ${liveScenarioEnv}`);
  }
  if (requested.length === 1 && requested[0] === "all") {
    return scenarios;
  }

  const unknown = requested.filter((name) => !(name in scenarios));
  if (unknown.length > 0) {
    throw new Error(`unknown live E2E scenario(s): ${unknown.join(", ")}`);
  }
  return Object.fromEntries(requested.map((name) => [name, scenarios[name as ScenarioName]])) as Partial<typeof scenarios>;
}

function liveConfigOrThrow(): Record<string, string> {
  const config = {
    ...loadDotenv(".env"),
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  };
  const missing = ["MINIMAX_API_KEY", "MODEL_NAME"].filter((name) => !config[name]);
  if (missing.length > 0) {
    throw new Error(`missing live MiniMax config: ${missing.join(", ")}`);
  }
  if (config.MINIMAX_API_KEY?.startsWith("replace-with")) {
    throw new Error("MINIMAX_API_KEY is still a placeholder");
  }
  if (config.MODEL_NAME?.startsWith("replace-with")) {
    throw new Error("MODEL_NAME is still a placeholder");
  }
  config.GRAFANA_WEBHOOK_SECRET ??= "local-webhook-secret";
  return config;
}

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
    signal: AbortSignal.timeout(90_000),
  });
  return await response.json() as Record<string, any>;
}

async function waitForUrl(url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
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
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.live.yml", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (check && result.status !== 0) {
    throw new Error(`docker compose failed with status ${result.status}`);
  }
}

function followComposeLogs(service: string): ChildProcess {
  return spawn("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.live.yml", "logs", "-f", service], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

function stopProcess(process_: ChildProcess | undefined): void {
  if (process_ && !process_.killed) {
    process_.kill("SIGTERM");
  }
}

function assertDockerAvailable(): void {
  const result = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("docker is not installed");
  }
}
