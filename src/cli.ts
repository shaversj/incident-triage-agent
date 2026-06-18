import { loadConfig, loadWebhookConfig } from "./config";
import { type Scenario, listScenarios, loadScenario } from "./domain";
import { loadTools } from "./evidence";
import { FlueDecisionClient, StaticDecisionClient } from "./llm";
import { createLogger, type TriageLogger } from "./logger";
import { mockDecisionForScenario, mockDecisionResponses } from "./mock-decisions";
import { LokiClient } from "./loki";
import { startWebhookServer } from "./server";
import type { SafetyResult } from "./policy";
import type { TriageRun } from "./workflow";
import { TriageWorkflow } from "./workflow";

const logLevels = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  const logger = createLogger(parsed.logLevel);

  if (parsed.help || !parsed.command) {
    printUsage();
    return 0;
  }

  if (parsed.command === "list") {
    for (const name of listScenarios(parsed.fixturesDir)) {
      console.log(name);
    }
    return 0;
  }

  if (parsed.command === "run") {
    if (!parsed.scenario) {
      console.error("Scenario is required.");
      return 2;
    }

    logger.info({ component: "cli", scenario: parsed.scenario }, "Starting triage run");
    let scenario: Scenario;
    try {
      scenario = loadScenario(parsed.fixturesDir, parsed.scenario);
    } catch (error) {
      console.error(`Fixture error: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }

    const tools = loadTools(parsed.fixturesDir);
    let llmClient;
    try {
      llmClient = parsed.mockLlm
        ? new StaticDecisionClient({ [scenario.name]: JSON.stringify(mockDecisionForScenario(scenario)) })
        : await liveDecisionClient(logger);
    } catch (error) {
      console.error(`Runtime error: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }

    const workflow = new TriageWorkflow(tools, llmClient, logger);
    const run = await workflow.run(scenario);
    renderRun(run, parsed.trace);
    logger.info({ component: "cli", scenario: parsed.scenario }, "Triage run complete");
    return 0;
  }

  if (parsed.command === "serve") {
    let llmClient;
    let webhookConfig;
    try {
      webhookConfig = loadWebhookConfig(".env");
      llmClient = parsed.mockLlm
        ? new StaticDecisionClient(mockDecisionResponses())
        : await liveDecisionClient(logger);
    } catch (error) {
      console.error(`Runtime error: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }

    const server = startWebhookServer({
      host: parsed.host,
      port: parsed.port,
      logger,
      runtime: {
        fixturesDir: parsed.fixturesDir,
        webhookSecret: webhookConfig.grafanaWebhookSecret,
        llmClient,
        lokiClient: new LokiClient(webhookConfig.lokiBaseUrl),
        lokiLimit: webhookConfig.lokiLimit,
      },
    });
    logger.info({
      component: "cli",
      host: parsed.host,
      port: parsed.port,
      mockLlm: parsed.mockLlm,
    }, "Starting webhook server");
    await server.ready;
    logger.info({ component: "cli", host: parsed.host, port: parsed.port }, "Webhook server ready");
    await server.closed;
    return 0;
  }

  console.error(`Unknown command: ${parsed.command}`);
  return 2;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let logLevel = "info";
  let fixturesDir = "fixtures";
  let host = "127.0.0.1";
  let port = 8080;
  let mockLlm = false;
  let trace = false;
  let help = false;

  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--mock-llm") {
      mockLlm = true;
    } else if (arg === "--trace") {
      trace = true;
    } else if (arg === "--log-level") {
      const value = args[++index];
      if (!value || !logLevels.has(value.toLowerCase())) {
        throw new Error("--log-level must be one of trace, debug, info, warn, error, fatal.");
      }
      logLevel = value.toLowerCase();
    } else if (arg === "--fixtures-dir") {
      const value = args[++index];
      if (!value) {
        throw new Error("--fixtures-dir requires a value.");
      }
      fixturesDir = value;
    } else if (arg === "--host") {
      const value = args[++index];
      if (!value) {
        throw new Error("--host requires a value.");
      }
      host = value;
    } else if (arg === "--port") {
      const value = args[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--port must be a positive integer.");
      }
      port = parsed;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    scenario: positional[1],
    fixturesDir,
    host,
    port,
    help,
    logLevel,
    mockLlm,
    trace,
  };
}

interface ParsedArgs {
  command: string | undefined;
  scenario: string | undefined;
  fixturesDir: string;
  host: string;
  port: number;
  help: boolean;
  logLevel: string;
  mockLlm: boolean;
  trace: boolean;
}

function printUsage(): void {
  console.log("Usage: npm run triage -- [--log-level info] <list|run|serve>");
  console.log("       npm run triage -- run <scenario> [--mock-llm] [--trace] [--fixtures-dir fixtures]");
  console.log("       npm run triage -- serve [--mock-llm] [--host 127.0.0.1] [--port 8080]");
}

async function liveDecisionClient(logger: TriageLogger): Promise<FlueDecisionClient> {
  const config = loadConfig(".env");
  return new FlueDecisionClient(config, undefined, logger);
}

export function renderRun(run: TriageRun, trace: boolean): void {
  console.log(`Incident: ${run.scenario.incident.incidentId} - ${run.scenario.incident.title}`);
  console.log(`Scenario: ${run.scenario.name}`);
  console.log(`Service: ${run.scenario.incident.service}`);

  if (trace) {
    console.log("\nState trace:");
    for (const state of run.states) {
      console.log(`- ${state}`);
    }

    if (run.evidencePackage) {
      console.log("\nEvidence:");
      for (const item of run.evidencePackage.evidence) {
        console.log(`- ${item.evidenceId} [${item.source}/${item.sourceTier}] ${item.summary}`);
      }
      if (run.evidencePackage.missingContext.length > 0) {
        console.log(`- missing: ${run.evidencePackage.missingContext.join(", ")}`);
      }
    }
  }

  if (run.validation?.decision) {
    const decision = run.validation.decision;
    console.log("\nLLM decision:");
    console.log(`- incident_class: ${decision.incidentClass}`);
    console.log(`- next_action: ${decision.nextAction}`);
    console.log(`- confidence: ${decision.confidence.toFixed(2)}`);
    console.log(`- evidence_ids: ${formatValue(decision.evidenceIds)}`);
    if (decision.caveats.length > 0) {
      console.log(`- caveats: ${decision.caveats.join("; ")}`);
    }
    if (decision.verificationPlan.length > 0) {
      console.log("- verification_plan:");
      for (const step of decision.verificationPlan) {
        console.log(`  - ${step}`);
      }
    }
  } else if (run.validation) {
    console.log("\nLLM decision: invalid");
    for (const error of run.validation.errors) {
      console.log(`- ${error}`);
    }
  }

  renderProvenance(run);
  renderSafety(run.safety);

  if (run.scorecard) {
    console.log("\nScorecard:");
    for (const [name, passed] of Object.entries(run.scorecard.scores)) {
      console.log(`- ${name}: ${passed ? "pass" : "fail"}`);
    }
    for (const note of run.scorecard.notes) {
      console.log(`- note: ${note}`);
    }
  }
}

function renderProvenance(run: TriageRun): void {
  if (!run.evidencePackage) {
    return;
  }
  const summary = run.evidencePackage.provenanceSummary(run.validation?.decision?.evidenceIds ?? []);
  console.log("\nProvenance:");
  console.log(`- available_tiers: ${formatValue(summary.availableTiers)}`);
  console.log(`- cited_tiers: ${formatValue(summary.citedTiers)}`);
  console.log(`- cited_sources: ${formatValue(summary.citedSources)}`);
  console.log(`- support: ${summary.hasCurrentOrOperationalSupport ? "current_or_operational" : "weak_or_historical"}`);
  if (summary.missingContext.length > 0) {
    console.log(`- missing_context: ${summary.missingContext.join(", ")}`);
  }
}

function renderSafety(safety: SafetyResult | undefined): void {
  if (!safety) {
    return;
  }
  console.log("\nSafety gate:");
  console.log(`- status: ${safety.status}`);
  console.log(`- approval_required: ${formatBoolean(safety.approvalRequired)}`);
  console.log(`- reason: ${safety.reason}`);
  if (safety.stagedPayload) {
    console.log("- staged_payload:");
    for (const [key, value] of Object.entries(safety.stagedPayload)) {
      console.log(`  - ${key}: ${formatValue(value)}`);
    }
  }
  if (safety.auditEvent) {
    console.log("- audit_event:");
    for (const [key, value] of Object.entries(safety.auditEvent)) {
      console.log(`  - ${key}: ${formatValue(value)}`);
    }
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") {
    return formatBoolean(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(String).join(", ") : "none";
  }
  return String(value);
}

function formatBoolean(value: boolean): string {
  return value ? "true" : "false";
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
