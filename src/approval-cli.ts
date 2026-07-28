import { loadMitigationCatalog } from "./mitigation-control";

const approvalDecisions = ["approve", "reject"] as const;

type ApprovalDecision = (typeof approvalDecisions)[number];

interface ParsedApprovalArgs {
  decision: ApprovalDecision | undefined;
  catalogId: string | undefined;
  fixturesDir: string;
  incidentId: string;
  service: string;
  json: boolean;
  help: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || !args.decision || !args.catalogId) {
    printUsage();
    return args.help ? 0 : 2;
  }

  const catalogEntry = loadMitigationCatalog(args.fixturesDir)
    .find((entry) => entry.catalogId === args.catalogId);
  if (!catalogEntry) {
    console.error(`Unknown mitigation catalog id: ${args.catalogId}`);
    return 2;
  }

  const record = {
    approval_id: `approval:${args.incidentId}:${catalogEntry.catalogId}`,
    status: args.decision === "approve" ? "human_approved" : "human_rejected",
    catalog_id: catalogEntry.catalogId,
    runbook_id: catalogEntry.runbookId,
    incident_id: args.incidentId,
    service: args.service,
    action_intent: catalogEntry.actionIntent,
    executed: false,
    execution_note: "Human approval decision recorded for simulation only; no mitigation was executed.",
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }

  process.stdout.write("Approval decision recorded\n");
  process.stdout.write(`- approval_id: ${record.approval_id}\n`);
  process.stdout.write(`- status: ${record.status}\n`);
  process.stdout.write(`- catalog_id: ${record.catalog_id}\n`);
  process.stdout.write(`- runbook_id: ${record.runbook_id}\n`);
  process.stdout.write(`- executed: ${String(record.executed)}\n`);
  process.stdout.write(`- note: ${record.execution_note}\n`);
  return 0;
}

function parseArgs(argv: string[]): ParsedApprovalArgs {
  let decision: ApprovalDecision | undefined;
  let catalogId: string | undefined;
  let fixturesDir = "fixtures";
  let incidentId = "manual";
  let service = "unknown";
  let json = false;
  let help = false;

  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--fixtures-dir") {
      fixturesDir = requiredValue(argv[++index], "--fixtures-dir");
    } else if (arg === "--incident-id") {
      incidentId = requiredValue(argv[++index], "--incident-id");
    } else if (arg === "--service") {
      service = requiredValue(argv[++index], "--service");
    } else {
      positional.push(arg);
    }
  }

  const candidateDecision = positional[0];
  if (isApprovalDecision(candidateDecision)) {
    decision = candidateDecision;
  } else if (candidateDecision !== undefined) {
    throw new Error(`Approval decision must be one of ${approvalDecisions.join(", ")}.`);
  }
  catalogId = positional[1];

  return { decision, catalogId, fixturesDir, incidentId, service, json, help };
}

function isApprovalDecision(value: string | undefined): value is ApprovalDecision {
  return value === "approve" || value === "reject";
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printUsage(): void {
  console.log("Usage: npm run triage:approval -- <approve|reject> <catalog-id> [--incident-id INC] [--service SERVICE] [--json]");
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
