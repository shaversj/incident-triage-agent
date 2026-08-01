import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config";
import { FlueDecisionClient, StaticDecisionClient } from "../src/llm";
import { signGrafanaWebhookBody } from "../src/grafana";
import { createLogger } from "../src/logger";
import { mockDecisionForName } from "../src/mock-decisions";
import { InMemoryTriageRunPersistenceStore } from "../src/persistence";
import { loadRecordedLogs, RecordedLokiClient } from "../src/recorded-observability";
import { handleGrafanaWebhook, startWebhookServer } from "../src/server";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const recordedTriageSecret = "recorded-triage-secret";

interface RecordedScenario {
  webhookFixture: string;
  logFixture: string;
  grafanaScenario: string;
}

interface InputSummary {
  source: string;
  alerts: string[];
  service: string;
  severity: string;
  started_at: string;
  log_records: number;
}

export const scenarios = {
  "checkout-payment-timeout": {
    webhookFixture: "checkout-payment-timeout-webhook.json",
    logFixture: "checkout-payment-timeout",
    grafanaScenario: "grafana-checkout-api",
  },
  "capacity-saturation": {
    webhookFixture: "capacity-saturation-webhook.json",
    logFixture: "capacity-saturation",
    grafanaScenario: "grafana-search-api",
  },
  "bad-deploy-latency": {
    webhookFixture: "bad-deploy-latency-webhook.json",
    logFixture: "bad-deploy-latency",
    grafanaScenario: "grafana-bad-deploy-latency",
  },
} satisfies Record<string, RecordedScenario>;

type ScenarioName = keyof typeof scenarios;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const scenario = scenarios[args.scenario];
  const logger = createLogger(args.logLevel);

  try {
    if (args.readOnlyCanary) {
      const summary = await runReadOnlyCanary(args, scenario, logger);
      if (args.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        printSummary(summary);
        process.stdout.write("\nCANARY\n");
        for (const [key, value] of Object.entries(summary.canary)) {
          process.stdout.write(`- ${key}: ${String(value)}\n`);
        }
      }
      return summary.canary.passed ? 0 : 1;
    }

    const webhookPayload = payload(scenario.webhookFixture);
    const recordedLogs = loadRecordedLogs(scenario.logFixture, join(projectRoot, "fixtures"));
    const llmClient = args.live
      ? new FlueDecisionClient(loadConfig(join(projectRoot, ".env")), undefined, logger)
      : new StaticDecisionClient({
        [scenario.grafanaScenario]: JSON.stringify(mockDecisionForName(scenario.grafanaScenario)),
      });
    const [status, response] = await handleGrafanaWebhook(
      webhookPayload,
      recordedTriageSecret,
      {
        fixturesDir: join(projectRoot, "fixtures"),
        webhookSecret: recordedTriageSecret,
        llmClient,
        lokiClient: new RecordedLokiClient(recordedLogs),
        lokiLimit: 20,
      },
    );
    const summary = sanitizedSummary(
      args.scenario,
      args.live ? "live" : "mock",
      status,
      response,
      summarizeInput(webhookPayload, recordedLogs.length),
    );

    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printSummary(summary);
    }
    return status >= 200 && status < 300 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Recorded triage run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function sanitizedSummary(
  scenarioName: ScenarioName,
  mode: "mock" | "live",
  statusCode: number,
  response: Record<string, unknown>,
  inputSummary: InputSummary = emptyInputSummary(),
) {
  return {
    scenario: scenarioName,
    mode,
    status_code: statusCode,
    input: inputSummary,
    incident: response.incident,
    run_id: response.run_id,
    run_status: response.run_status,
    investigation: response.investigation,
    validation: response.validation,
    explanation_validation: response.explanation_validation,
    analysis: response.analysis,
    finding_summary: response.finding_summary,
    recommendation: response.recommendation,
    decision: response.decision,
    provenance: response.provenance,
    safety: response.safety,
    mitigation_control: response.mitigation_control,
    scorecard: response.scorecard,
  };
}

function parseArgs(argv: string[]) {
  let scenario: ScenarioName = "checkout-payment-timeout";
  let scenarioProvided = false;
  let live = false;
  let json = false;
  let readOnlyCanary = false;
  let logLevel = "info";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") {
      const value = argv[++index];
      if (!isScenarioName(value)) {
        throw new Error(`--scenario must be one of ${Object.keys(scenarios).join(", ")}.`);
      }
      scenario = value;
      scenarioProvided = true;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--read-only-canary") {
      readOnlyCanary = true;
    } else if (arg === "--log-level") {
      logLevel = requiredValue(argv[++index], "--log-level");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (readOnlyCanary && !scenarioProvided) {
    scenario = "bad-deploy-latency";
  }

  return { scenario, live, json, readOnlyCanary, logLevel };
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

function payload(name: string): unknown {
  return JSON.parse(readFileSync(join(projectRoot, "fixtures", "grafana", name), "utf8")) as unknown;
}

function payloadText(name: string): string {
  return readFileSync(join(projectRoot, "fixtures", "grafana", name), "utf8");
}

async function runReadOnlyCanary(
  args: ReturnType<typeof parseArgs>,
  scenario: RecordedScenario,
  logger: ReturnType<typeof createLogger>,
) {
  const rawBody = payloadText(scenario.webhookFixture);
  const webhookPayload = JSON.parse(rawBody) as unknown;
  const recordedLogs = loadRecordedLogs(scenario.logFixture, join(projectRoot, "fixtures"));
  const runStore = new InMemoryTriageRunPersistenceStore();
  const llmClient = args.live
    ? new FlueDecisionClient(loadConfig(join(projectRoot, ".env")), undefined, logger)
    : new StaticDecisionClient({
      [scenario.grafanaScenario]: JSON.stringify(mockDecisionForName(scenario.grafanaScenario)),
    });
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    logger,
    runtime: {
      fixturesDir: join(projectRoot, "fixtures"),
      webhookSecret: recordedTriageSecret,
      llmClient,
      lokiClient: new RecordedLokiClient(recordedLogs),
      lokiLimit: 20,
      mode: "read_only",
      runStore,
    },
  });
  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const timestamp = unixTimestamp(new Date());
    const first = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, timestamp),
      body: rawBody,
    });
    const response = await first.json() as Record<string, unknown>;
    const replay = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, timestamp),
      body: rawBody,
    });
    const approvals = await fetch(`${baseUrl}/api/approvals`);
    const summary = sanitizedSummary(
      args.scenario,
      args.live ? "live" : "mock",
      first.status,
      response,
      summarizeInput(webhookPayload, recordedLogs.length),
    );
    const runId = typeof response.run_id === "string" ? response.run_id : "";
    const safety = objectValue(response.safety);
    const mitigation = objectValue(response.mitigation_control);
    const persistedRun = Boolean(runStore.runs.get(runId));
    const persistedEvidenceSnapshot = Boolean(runStore.evidenceSnapshots.get(runId));
    const replayRejected = replay.status === 409;
    const approvalRoutesDisabled = approvals.status === 404;
    const approvalArtifactsAbsent = safety.staged_payload === undefined &&
      mitigation.staged_action === undefined &&
      mitigation.approval_request === undefined;
    const canary = {
      passed: first.ok && persistedRun && persistedEvidenceSnapshot && replayRejected && approvalRoutesDisabled && approvalArtifactsAbsent,
      read_only_mode: true,
      persisted_run: persistedRun,
      persisted_evidence_snapshot: persistedEvidenceSnapshot,
      replay_rejected: replayRejected,
      approval_routes_disabled: approvalRoutesDisabled,
      approval_artifacts_absent: approvalArtifactsAbsent,
    };
    return {
      ...summary,
      canary,
    };
  } finally {
    await server.close();
  }
}

function serverUrl(server: ReturnType<typeof startWebhookServer>["server"]): string {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function signedGrafanaHeaders(rawBody: string, timestamp: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Grafana-Alerting-Signature": signGrafanaWebhookBody(rawBody, recordedTriageSecret, timestamp),
    "X-Grafana-Alerting-Timestamp": timestamp,
  };
}

function unixTimestamp(date: Date): string {
  return `${Math.floor(date.getTime() / 1000)}`;
}

function summarizeInput(webhookPayload: unknown, logRecords: number): InputSummary {
  const payloadObject = objectValue(webhookPayload);
  const alerts = arrayValue(payloadObject.alerts)
    .map((alert) => {
      const labels = objectValue(objectValue(alert).labels);
      return typeof labels.alertname === "string" ? labels.alertname : undefined;
    })
    .filter((alertName): alertName is string => Boolean(alertName));
  const commonLabels = objectValue(payloadObject.commonLabels);
  const groupLabels = objectValue(payloadObject.groupLabels);
  const firstAlert = objectValue(arrayValue(payloadObject.alerts)[0]);

  return {
    source: "recorded Grafana webhook + recorded Loki-shaped logs",
    alerts,
    service: stringValue(commonLabels.service) ?? stringValue(groupLabels.service) ?? "unknown",
    severity: normalizeSeverity(stringValue(commonLabels.severity)),
    started_at: stringValue(firstAlert.startsAt) ?? "unknown",
    log_records: logRecords,
  };
}

function printSummary(summary: ReturnType<typeof sanitizedSummary>): void {
  const decision = objectValue(summary.decision);
  const validation = objectValue(summary.validation);
  const explanationValidation = objectValue(summary.explanation_validation);
  const safety = objectValue(summary.safety);
  const mitigationControl = objectValue(summary.mitigation_control);
  const provenance = objectValue(summary.provenance);
  const recommendation = objectValue(summary.recommendation);
  const input = objectValue(summary.input);

  process.stdout.write("Recorded triage run complete\n");
  process.stdout.write(`- scenario: ${summary.scenario}\n`);
  process.stdout.write(`- mode: ${summary.mode}\n`);
  process.stdout.write("\nINPUT\n");
  process.stdout.write(`- source: ${input.source ?? "unknown"}\n`);
  process.stdout.write(`- alerts: ${formatList(input.alerts)}\n`);
  process.stdout.write(`- service: ${input.service ?? "unknown"}\n`);
  process.stdout.write(`- severity: ${input.severity ?? "unknown"}\n`);
  process.stdout.write(`- started_at: ${input.started_at ?? "unknown"}\n`);
  process.stdout.write(`- log_records: ${String(input.log_records ?? 0)}\n`);

  process.stdout.write("\nRUN\n");
  process.stdout.write(`- run_status: ${summary.run_status ?? "none"}\n`);
  process.stdout.write(`- validation: ${validation.valid ? "valid" : "invalid"}\n`);
  process.stdout.write(`- explanation_validation: ${explanationValidation.status ?? "none"}\n`);
  for (const warning of arrayValue(explanationValidation.warnings)) {
    process.stdout.write(`- explanation_warning: ${String(warning)}\n`);
  }

  process.stdout.write("\nFINDING\n");
  process.stdout.write(`- finding_summary: ${summary.finding_summary ?? "none"}\n`);
  process.stdout.write(`- recommendation_rationale: ${recommendation.rationale ?? "not provided by model"}\n`);

  process.stdout.write("\nDECISION\n");
  process.stdout.write(`- incident_class: ${decision.incident_class ?? "none"}\n`);
  process.stdout.write(`- next_action: ${decision.next_action ?? "none"}\n`);
  process.stdout.write(`- confidence: ${decision.confidence ?? "none"}\n`);
  process.stdout.write(`- evidence_ids: ${formatList(decision.evidence_ids)}\n`);
  process.stdout.write(`- cited_tiers: ${formatList(provenance.cited_tiers)}\n`);

  process.stdout.write("\nSAFETY\n");
  process.stdout.write(`- safety: ${safety.status ?? "none"}\n`);
  process.stdout.write(`- approval_required: ${String(safety.approval_required ?? false)}\n`);

  process.stdout.write("\nMITIGATION CONTROL PLANE\n");
  process.stdout.write(`- status: ${mitigationControl.status ?? "none"}\n`);
  process.stdout.write(`- approval_required: ${String(mitigationControl.approval_required ?? false)}\n`);
  process.stdout.write(`- catalog_id: ${objectValue(mitigationControl.catalog_match).catalog_id ?? "none"}\n`);
  process.stdout.write(`- runbook_id: ${objectValue(mitigationControl.catalog_match).runbook_id ?? "none"}\n`);
  process.stdout.write(`- verification: ${objectValue(mitigationControl.verification).status ?? "none"}\n`);
  process.stdout.write(`- staged_executed: ${String(objectValue(mitigationControl.staged_action).executed ?? false)}\n`);
  const approvalRequest = objectValue(mitigationControl.approval_request);
  if (Object.keys(approvalRequest).length > 0) {
    process.stdout.write(`- approval_id: ${approvalRequest.approval_id ?? "none"}\n`);
    process.stdout.write(`- approval_status: ${approvalRequest.status ?? "none"}\n`);
    process.stdout.write(`- approve_command: ${approvalRequest.approve_command ?? "none"}\n`);
  }

  const caveats = arrayValue(decision.caveats);
  if (caveats.length > 0) {
    process.stdout.write("\nCAVEATS\n");
    for (const caveat of caveats) {
      process.stdout.write(`- ${String(caveat)}\n`);
    }
  }

  const verificationPlan = arrayValue(decision.verification_plan);
  if (verificationPlan.length > 0) {
    process.stdout.write("\nVERIFICATION PLAN\n");
    for (const step of verificationPlan) {
      process.stdout.write(`- ${String(step)}\n`);
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeSeverity(value: string | undefined): string {
  return value ? value.toUpperCase() : "unknown";
}

function emptyInputSummary(): InputSummary {
  return {
    source: "unknown",
    alerts: [],
    service: "unknown",
    severity: "unknown",
    started_at: "unknown",
    log_records: 0,
  };
}

function formatList(value: unknown): string {
  const items = arrayValue(value);
  return items.length > 0 ? items.map(String).join(", ") : "none";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
