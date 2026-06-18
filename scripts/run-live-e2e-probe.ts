import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv } from "../src/config";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeCommand = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.live.yml"];

interface LiveScenario {
  fixture: string;
  endpoint: string;
  idField: "checkout_id" | "incident_id";
  defaultId: string;
  logLabel: string;
}

export const scenarios = {
  "checkout-payment-timeout": {
    fixture: "checkout-payment-timeout-webhook.json",
    endpoint: "/checkout",
    idField: "checkout_id",
    defaultId: "demo-live-checkout-001",
    logLabel: "synthetic checkout logs",
  },
  "capacity-saturation": {
    fixture: "capacity-saturation-webhook.json",
    endpoint: "/capacity",
    idField: "incident_id",
    defaultId: "demo-live-capacity-001",
    logLabel: "synthetic capacity logs",
  },
  "bad-deploy-latency": {
    fixture: "bad-deploy-latency-webhook.json",
    endpoint: "/bad-deploy",
    idField: "incident_id",
    defaultId: "demo-live-bad-deploy-001",
    logLabel: "synthetic bad-deploy logs",
  },
} satisfies Record<string, LiveScenario>;

type ScenarioName = keyof typeof scenarios;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const scenario = scenarios[args.scenario];
  const config = liveConfig();
  validateLiveConfig(config);

  const upCommand = args.noBuild ? ["up", "-d"] : ["up", "-d", "--build"];
  const quietCompose = !args.verboseCompose;

  try {
    emit("Starting live E2E stack...", args.json);
    runCompose(upCommand, { quiet: quietCompose });
    await waitForUrl("http://localhost:3100/ready");
    await waitForUrl("http://localhost:8081/health");

    emit(`Generating ${scenario.logLabel}...`, args.json);
    const requestedId = args.scenario === "checkout-payment-timeout" ? args.checkoutId : args.incidentId;
    const serviceResponse = await generateScenarioLogs(scenario, requestedId);
    const webhookSecret = config.GRAFANA_WEBHOOK_SECRET ?? "local-webhook-secret";

    emit("Posting Grafana webhook and waiting for MiniMax decision...", args.json);
    const response = await postGrafanaPayload(webhookSecret, scenario.fixture);
    const summary = sanitizedSummary(response, serviceResponse);

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printSummary(summary);
    }
    return 0;
  } finally {
    emit("Cleaning up live E2E stack...", args.json);
    runCompose(["down", "-v"], { check: false, quiet: quietCompose });
  }
}

export function liveConfig(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    ...loadDotenv(join(projectRoot, ".env")),
    ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  };
}

export function validateLiveConfig(config: Record<string, string>): void {
  const missing = ["MINIMAX_API_KEY", "MODEL_NAME"].filter((name) => !config[name]);
  if (missing.length > 0) {
    throw new Error(`Missing live MiniMax config: ${missing.join(", ")}.`);
  }

  const placeholders = ["MINIMAX_API_KEY", "MODEL_NAME"].filter((name) => config[name]?.startsWith("replace-with"));
  if (placeholders.length > 0) {
    throw new Error(`Live MiniMax config still has placeholder value(s): ${placeholders.join(", ")}.`);
  }
}

export function sanitizedSummary(response: Record<string, unknown>, serviceResponse: Record<string, unknown>) {
  return {
    checkout_response: serviceResponse,
    service_response: serviceResponse,
    incident: response.incident,
    validation: response.validation,
    decision: response.decision,
    provenance: response.provenance,
    safety: response.safety,
    scorecard: response.scorecard,
  };
}

function parseArgs(argv: string[]) {
  let scenario: ScenarioName = "checkout-payment-timeout";
  let checkoutId = "demo-live-checkout-001";
  let incidentId: string | undefined;
  let noBuild = false;
  let json = false;
  let verboseCompose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") {
      const value = argv[++index];
      if (!isScenarioName(value)) {
        throw new Error(`--scenario must be one of ${Object.keys(scenarios).join(", ")}.`);
      }
      scenario = value;
    } else if (arg === "--checkout-id") {
      checkoutId = requiredValue(argv[++index], "--checkout-id");
    } else if (arg === "--incident-id") {
      incidentId = requiredValue(argv[++index], "--incident-id");
    } else if (arg === "--no-build") {
      noBuild = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--verbose-compose") {
      verboseCompose = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { scenario, checkoutId, incidentId, noBuild, json, verboseCompose };
}

function isScenarioName(value: string | undefined): value is ScenarioName {
  return value !== undefined && value in scenarios;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function emit(message: string, jsonMode: boolean): void {
  const stream = jsonMode ? process.stderr : process.stdout;
  stream.write(`${message}\n`);
}

function runCompose(
  args: string[],
  options: { check?: boolean; quiet: boolean },
): void {
  const result = spawnSync(composeCommand[0] ?? "docker", [...composeCommand.slice(1), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if ((options.check ?? true) && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker compose failed with status ${result.status}`);
  }
}

async function waitForUrl(url: string, timeoutSeconds = 90): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) {
        return;
      }
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function generateScenarioLogs(
  scenario: LiveScenario,
  incidentId: string | undefined,
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://localhost:8081${scenario.endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [scenario.idField]: incidentId ?? scenario.defaultId }),
    signal: AbortSignal.timeout(20_000),
  });
  return await response.json() as Record<string, unknown>;
}

async function postGrafanaPayload(
  webhookSecret: string,
  fixtureName: string,
): Promise<Record<string, unknown>> {
  const payload = JSON.parse(readFileSync(join(projectRoot, "fixtures/grafana", fixtureName), "utf8")) as {
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
    signal: AbortSignal.timeout(120_000),
  });
  return await response.json() as Record<string, unknown>;
}

function printSummary(summary: ReturnType<typeof sanitizedSummary>): void {
  const decision = objectValue(summary.decision);
  const validation = objectValue(summary.validation);
  const safety = objectValue(summary.safety);
  const provenance = objectValue(summary.provenance);

  console.log("Live E2E probe complete");
  console.log(`- validation: ${validation.valid ? "valid" : "invalid"}`);
  console.log(`- incident_class: ${decision.incident_class ?? "none"}`);
  console.log(`- next_action: ${decision.next_action ?? "none"}`);
  console.log(`- confidence: ${decision.confidence ?? "none"}`);
  console.log(`- evidence_ids: ${formatList(decision.evidence_ids)}`);
  console.log(`- cited_tiers: ${formatList(provenance.cited_tiers)}`);
  console.log(`- safety: ${safety.status ?? "none"}`);
  console.log(`- approval_required: ${String(safety.approval_required ?? false)}`);

  const caveats = arrayValue(decision.caveats);
  if (caveats.length > 0) {
    console.log("Caveats:");
    for (const caveat of caveats) {
      console.log(`- ${String(caveat)}`);
    }
  }

  const verificationPlan = arrayValue(decision.verification_plan);
  if (verificationPlan.length > 0) {
    console.log("Verification plan:");
    for (const step of verificationPlan) {
      console.log(`- ${String(step)}`);
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatList(value: unknown): string {
  const items = arrayValue(value);
  return items.length > 0 ? items.map(String).join(", ") : "none";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`Live E2E probe failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
