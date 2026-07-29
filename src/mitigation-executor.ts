import type { MitigationCatalogEntry } from "./mitigation-control";

export interface SimulatedExecutionRecord {
  status: "simulated_not_executed";
  catalogId: string;
  runbookId: string;
  actionIntent: string;
  executed: false;
  dryRun: true;
  reason: string;
}

export function simulateApprovedMitigation(entry: MitigationCatalogEntry): SimulatedExecutionRecord {
  return {
    status: "simulated_not_executed",
    catalogId: entry.catalogId,
    runbookId: entry.runbookId,
    actionIntent: entry.actionIntent,
    executed: false,
    dryRun: true,
    reason: "Approval was recorded, but the executor boundary is simulation-only.",
  };
}
