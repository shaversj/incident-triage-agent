import { loadConfig } from "./config";
import { type Scenario, listScenarios, loadScenario } from "./domain";
import { loadTools } from "./evidence";
import { FlueDecisionClient, StaticDecisionClient } from "./llm";
import { createLogger } from "./logger";
import type { SafetyResult } from "./policy";
import type { TriageRun } from "./workflow";
import { TriageWorkflow } from "./workflow";

const logLevels = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
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
        ? new StaticDecisionClient({ [scenario.name]: JSON.stringify(mockDecisionFor(scenario)) })
        : await liveDecisionClient();
    } catch (error) {
      console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }

    const workflow = new TriageWorkflow(tools, llmClient, logger);
    const run = await workflow.run(scenario);
    renderRun(run, parsed.trace);
    logger.info({ component: "cli", scenario: parsed.scenario }, "Triage run complete");
    return 0;
  }

  if (parsed.command === "serve") {
    console.error("The TypeScript webhook server is not implemented yet.");
    return 2;
  }

  console.error(`Unknown command: ${parsed.command}`);
  return 2;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let logLevel = "info";
  let fixturesDir = "fixtures";
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
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    scenario: positional[1],
    fixturesDir,
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
  help: boolean;
  logLevel: string;
  mockLlm: boolean;
  trace: boolean;
}

function printUsage(): void {
  console.log("Usage: bun run triage [--log-level info] <list|run|serve>");
  console.log("       bun run triage run <scenario> [--mock-llm] [--trace] [--fixtures-dir fixtures]");
}

async function liveDecisionClient(): Promise<FlueDecisionClient> {
  const config = loadConfig(".env");
  let runIncidentTriageSkill;
  try {
    ({ runIncidentTriageSkill } = await import("./flue/incident-triage-workflow"));
  } catch (error) {
    throw new Error(
      `Flue runtime could not be loaded by the Bun CLI: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return new FlueDecisionClient(config, runIncidentTriageSkill);
}

function mockDecisionFor(scenario: Scenario): object {
  const decisions: Record<string, object> = {
    "checkout-payment-timeout": {
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.88,
      evidence_ids: ["alert:1", "log:0", "runbook:dependency-outage"],
      caveats: ["Recent checkout deploy is lower-confidence context than payment timeout evidence."],
      verification_plan: ["Track payment-gateway timeout rate.", "Confirm checkout latency returns below SLO."],
    },
    "bad-deploy-latency": {
      incident_class: "bad_deploy",
      next_action: "request_rollback_approval",
      confidence: 0.9,
      evidence_ids: ["deploy:0", "log:0", "runbook:bad-deploy"],
      caveats: ["Rollback requires human approval."],
      verification_plan: ["Check checkout latency.", "Check error budget burn."],
    },
    "capacity-saturation": {
      incident_class: "capacity_saturation",
      next_action: "apply_runbook_step_with_approval",
      confidence: 0.83,
      evidence_ids: ["alert:0", "log:0", "runbook:capacity-saturation"],
      caveats: ["Scaling or throttling action requires approval."],
      verification_plan: ["Check CPU.", "Check queue depth.", "Check p95 latency."],
    },
    "noisy-alert": {
      incident_class: "noisy_alert",
      next_action: "continue_monitoring",
      confidence: 0.78,
      evidence_ids: ["alert:0", "log:1", "verification:0"],
      caveats: ["No runbook was matched, but recovery signals are healthy."],
      verification_plan: ["Continue monitoring latency and error rate."],
    },
  };
  return decisions[scenario.name] ?? {
    incident_class: "unknown",
    next_action: "ask_human",
    confidence: 0.7,
    evidence_ids: [],
    caveats: ["No canned mock decision exists for this scenario."],
    verification_plan: [],
  };
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
