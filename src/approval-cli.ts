import {
  decideApproval,
  defaultApprovalStorePath,
  getApproval,
  listApprovals,
  requestApproval,
  type ApprovalRecord,
} from "./approval-store";
import { simulateApprovedMitigation } from "./mitigation-executor";
import { loadMitigationCatalog, type MitigationCatalogEntry } from "./mitigation-control";

const approvalCommands = ["request", "approve", "reject", "status", "list"] as const;

type ApprovalCommand = (typeof approvalCommands)[number];

interface ParsedApprovalArgs {
  command: ApprovalCommand | undefined;
  target: string | undefined;
  fixturesDir: string;
  storePath: string;
  incidentId: string;
  service: string;
  json: boolean;
  help: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    printUsage();
    return args.help ? 0 : 2;
  }

  if (args.command === "list") {
    renderList(listApprovals(args.storePath), args.json);
    return 0;
  }

  if (!args.target) {
    printUsage();
    return 2;
  }

  if (args.command === "status") {
    const record = getApproval(args.storePath, args.target);
    if (!record) {
      console.error(`Unknown approval id: ${args.target}`);
      return 2;
    }
    renderRecord(record, args.json);
    return 0;
  }

  const catalogEntry = findCatalogEntry(args.fixturesDir, args.target);
  if (!catalogEntry) {
    console.error(`Unknown mitigation catalog id: ${args.target}`);
    return 2;
  }

  const record = args.command === "request"
    ? requestApproval(args.storePath, catalogEntry, {
      incidentId: args.incidentId,
      service: args.service,
    })
    : decideApproval(args.storePath, catalogEntry, decisionDetails(args, catalogEntry));

  renderRecord(record, args.json);
  return 0;
}

function parseArgs(argv: string[]): ParsedApprovalArgs {
  let command: ApprovalCommand | undefined;
  let target: string | undefined;
  let fixturesDir = "fixtures";
  let storePath = defaultApprovalStorePath;
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
    } else if (arg === "--store-path") {
      storePath = requiredValue(argv[++index], "--store-path");
    } else if (arg === "--incident-id") {
      incidentId = requiredValue(argv[++index], "--incident-id");
    } else if (arg === "--service") {
      service = requiredValue(argv[++index], "--service");
    } else {
      positional.push(arg);
    }
  }

  const candidateCommand = positional[0];
  if (isApprovalCommand(candidateCommand)) {
    command = candidateCommand;
  } else if (candidateCommand !== undefined) {
    throw new Error(`Approval command must be one of ${approvalCommands.join(", ")}.`);
  }
  target = positional[1];

  return { command, target, fixturesDir, storePath, incidentId, service, json, help };
}

function findCatalogEntry(fixturesDir: string, catalogId: string): MitigationCatalogEntry | undefined {
  return loadMitigationCatalog(fixturesDir).find((entry) => entry.catalogId === catalogId);
}

function decisionDetails(
  args: ParsedApprovalArgs,
  catalogEntry: MitigationCatalogEntry,
): Parameters<typeof decideApproval>[2] {
  const details: Parameters<typeof decideApproval>[2] = {
    incidentId: args.incidentId,
    service: args.service,
    status: args.command === "approve" ? "human_approved" : "human_rejected",
  };
  if (args.command === "approve") {
    details.execution = simulateApprovedMitigation(catalogEntry);
  }
  return details;
}

function renderList(records: ApprovalRecord[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ approvals: records.map(recordToJson) }, null, 2)}\n`);
    return;
  }
  process.stdout.write("Approval records\n");
  if (records.length === 0) {
    process.stdout.write("- none\n");
    return;
  }
  for (const record of records) {
    process.stdout.write(`- ${record.approvalId}: ${record.status} (${record.catalogId}, executed: ${String(record.executed)})\n`);
  }
}

function renderRecord(record: ApprovalRecord, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(recordToJson(record), null, 2)}\n`);
    return;
  }

  process.stdout.write("Approval record\n");
  process.stdout.write(`- approval_id: ${record.approvalId}\n`);
  process.stdout.write(`- status: ${record.status}\n`);
  process.stdout.write(`- catalog_id: ${record.catalogId}\n`);
  process.stdout.write(`- runbook_id: ${record.runbookId}\n`);
  process.stdout.write(`- incident_id: ${record.incidentId}\n`);
  process.stdout.write(`- service: ${record.service}\n`);
  process.stdout.write(`- executed: ${String(record.executed)}\n`);
  if (record.execution) {
    process.stdout.write("- execution:\n");
    process.stdout.write(`  - status: ${record.execution.status}\n`);
    process.stdout.write(`  - dry_run: ${String(record.execution.dryRun)}\n`);
    process.stdout.write(`  - executed: ${String(record.execution.executed)}\n`);
    process.stdout.write(`  - reason: ${record.execution.reason}\n`);
  }
}

function recordToJson(record: ApprovalRecord): Record<string, unknown> {
  const json: Record<string, unknown> = {
    approval_id: record.approvalId,
    status: record.status,
    catalog_id: record.catalogId,
    runbook_id: record.runbookId,
    incident_id: record.incidentId,
    service: record.service,
    action_intent: record.actionIntent,
    requested_at: record.requestedAt,
    executed: record.executed,
  };
  if (record.decidedAt) {
    json.decided_at = record.decidedAt;
  }
  if (record.execution) {
    json.execution = {
      status: record.execution.status,
      catalog_id: record.execution.catalogId,
      runbook_id: record.execution.runbookId,
      action_intent: record.execution.actionIntent,
      executed: record.execution.executed,
      dry_run: record.execution.dryRun,
      reason: record.execution.reason,
    };
  }
  return json;
}

function isApprovalCommand(value: string | undefined): value is ApprovalCommand {
  return value === "request" || value === "approve" || value === "reject" || value === "status" || value === "list";
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printUsage(): void {
  console.log("Usage: npm run triage:approval -- <request|approve|reject> <catalog-id> [--incident-id INC] [--service SERVICE] [--store-path PATH] [--json]");
  console.log("       npm run triage:approval -- status <approval-id> [--store-path PATH] [--json]");
  console.log("       npm run triage:approval -- list [--store-path PATH] [--json]");
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
