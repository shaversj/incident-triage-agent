import { rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultApprovalStorePath, getApproval } from "../src/approval-store";
import { loadConfig } from "../src/config";
import { FlueDecisionClient, StaticDecisionClient, type LLMDecisionClient } from "../src/llm";
import { createLogger, type TriageLogger } from "../src/logger";
import { mockDecisionForName } from "../src/mock-decisions";
import { loadRecordedLogs, RecordedLokiClient } from "../src/recorded-observability";
import { handleGrafanaWebhook, startWebhookServer, type WebhookRuntime } from "../src/server";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const demoWebhookSecret = "approval-demo-secret";

const approvalDemoScenarios = {
  "bad-deploy-latency": {
    webhookFixture: "bad-deploy-latency-webhook.json",
    logFixture: "bad-deploy-latency",
    grafanaScenario: "grafana-bad-deploy-latency",
  },
  "capacity-saturation": {
    webhookFixture: "capacity-saturation-webhook.json",
    logFixture: "capacity-saturation",
    grafanaScenario: "grafana-search-api",
  },
} satisfies Record<string, ApprovalDemoScenario>;

type ScenarioName = keyof typeof approvalDemoScenarios;

interface ApprovalDemoScenario {
  webhookFixture: string;
  logFixture: string;
  grafanaScenario: string;
}

interface ParsedArgs {
  scenario: ScenarioName;
  live: boolean;
  once: boolean;
  json: boolean;
  keepStore: boolean;
  host: string;
  port: number;
  fixturesDir: string;
  approvalStorePath: string;
  logLevel: string;
}

interface ApprovalDemoResult {
  scenario: ScenarioName;
  mode: "mock" | "live";
  statusCode: number;
  approvalStorePath: string;
  approvalId?: string;
  approvalStatus?: string;
  approvalConsoleUrl: string;
  response: Record<string, unknown>;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const logger = createLogger(args.logLevel);
  const result = await seedApprovalDemo(args, logger);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(resultToJson(result), null, 2)}\n`);
  } else {
    printResult(result, args.once);
  }

  if (args.once) {
    return result.statusCode >= 200 && result.statusCode < 300 ? 0 : 1;
  }

  const runtime = await buildRuntime(args, logger);
  const server = startWebhookServer({
    host: args.host,
    port: args.port,
    logger,
    runtime,
  });
  await server.ready;
  process.stdout.write(`Approval console: ${result.approvalConsoleUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop the demo server.\n");
  await server.closed;
  return 0;
}

export async function seedApprovalDemo(
  args: ParsedArgs,
  logger: TriageLogger,
): Promise<ApprovalDemoResult> {
  if (!args.keepStore) {
    rmSync(args.approvalStorePath, { force: true });
  }

  const scenario = approvalDemoScenarios[args.scenario];
  const runtime = await buildRuntime(args, logger);
  const [statusCode, response] = await handleGrafanaWebhook(
    payload(args.fixturesDir, scenario.webhookFixture),
    demoWebhookSecret,
    runtime,
  );
  const approvalRequest = objectValue(objectValue(response.mitigation_control).approval_request);
  const approvalId = stringValue(approvalRequest.approval_id);
  const approval = approvalId ? getApproval(args.approvalStorePath, approvalId) : undefined;

  const result: ApprovalDemoResult = {
    scenario: args.scenario,
    mode: args.live ? "live" : "mock",
    statusCode,
    approvalStorePath: args.approvalStorePath,
    approvalConsoleUrl: `http://${args.host}:${args.port}/approvals`,
    response,
  };
  if (approvalId) {
    result.approvalId = approvalId;
  }
  if (approval?.status) {
    result.approvalStatus = approval.status;
  }
  return result;
}

async function buildRuntime(args: ParsedArgs, logger: TriageLogger): Promise<WebhookRuntime> {
  const scenario = approvalDemoScenarios[args.scenario];
  const llmClient = await buildLlmClient(args, logger, scenario);
  return {
    fixturesDir: args.fixturesDir,
    webhookSecret: demoWebhookSecret,
    llmClient,
    lokiClient: new RecordedLokiClient(loadRecordedLogs(scenario.logFixture, args.fixturesDir)),
    lokiLimit: 20,
    approvalStorePath: args.approvalStorePath,
  };
}

async function buildLlmClient(
  args: ParsedArgs,
  logger: TriageLogger,
  scenario: ApprovalDemoScenario,
): Promise<LLMDecisionClient> {
  if (args.live) {
    return new FlueDecisionClient(loadConfig(join(projectRoot, ".env")), undefined, logger);
  }
  return new StaticDecisionClient({
    [scenario.grafanaScenario]: JSON.stringify(mockDecisionForName(scenario.grafanaScenario)),
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  let scenario: ScenarioName = "bad-deploy-latency";
  let live = false;
  let once = false;
  let json = false;
  let keepStore = false;
  let host = "127.0.0.1";
  let port = 8080;
  let fixturesDir = join(projectRoot, "fixtures");
  let approvalStorePath = defaultApprovalStorePath;
  let logLevel = "info";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") {
      const value = requiredValue(argv[++index], "--scenario");
      if (!isScenarioName(value)) {
        throw new Error(`--scenario must be one of ${Object.keys(approvalDemoScenarios).join(", ")}.`);
      }
      scenario = value;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--keep-store") {
      keepStore = true;
    } else if (arg === "--host") {
      host = requiredValue(argv[++index], "--host");
    } else if (arg === "--port") {
      port = parsePort(requiredValue(argv[++index], "--port"));
    } else if (arg === "--fixtures-dir") {
      fixturesDir = requiredValue(argv[++index], "--fixtures-dir");
    } else if (arg === "--approval-store-path") {
      approvalStorePath = requiredValue(argv[++index], "--approval-store-path");
    } else if (arg === "--log-level") {
      logLevel = requiredValue(argv[++index], "--log-level");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { scenario, live, once, json, keepStore, host, port, fixturesDir, approvalStorePath, logLevel };
}

function printResult(result: ApprovalDemoResult, once: boolean): void {
  process.stdout.write("Approval UI demo seeded\n");
  process.stdout.write(`- scenario: ${result.scenario}\n`);
  process.stdout.write(`- mode: ${result.mode}\n`);
  process.stdout.write(`- status_code: ${result.statusCode}\n`);
  process.stdout.write(`- approval_store: ${result.approvalStorePath}\n`);
  process.stdout.write(`- approval_id: ${result.approvalId ?? "none"}\n`);
  process.stdout.write(`- approval_status: ${result.approvalStatus ?? "none"}\n`);
  process.stdout.write(`- approval_console: ${result.approvalConsoleUrl}\n`);
  if (!result.approvalId && result.mode === "live") {
    process.stdout.write("- note: live model output did not create an approval request for this run.\n");
  }
  if (once) {
    process.stdout.write("- server: not started (--once)\n");
  }
}

function resultToJson(result: ApprovalDemoResult): Record<string, unknown> {
  const json: Record<string, unknown> = {
    scenario: result.scenario,
    mode: result.mode,
    status_code: result.statusCode,
    approval_store: result.approvalStorePath,
    approval_console: result.approvalConsoleUrl,
  };
  if (result.approvalId) {
    json.approval_id = result.approvalId;
  }
  if (result.approvalStatus) {
    json.approval_status = result.approvalStatus;
  }
  return json;
}

function payload(fixturesDir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, "grafana", name), "utf8")) as unknown;
}

function isScenarioName(value: string): value is ScenarioName {
  return value in approvalDemoScenarios;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error("--port must be a non-negative integer.");
  }
  return port;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function printUsage(): void {
  process.stdout.write("Usage: npm run approval-demo -- [--scenario bad-deploy-latency] [--live] [--port 8080] [--approval-store-path .triage/approvals.json]\n");
  process.stdout.write("       npm run approval-demo -- --once --json\n");
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`Approval demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
