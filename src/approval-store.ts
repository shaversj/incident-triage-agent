import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MitigationCatalogEntry } from "./mitigation-control";
import type { SimulatedExecutionRecord } from "./mitigation-executor";

export const approvalStatuses = [
  "pending_human_approval",
  "human_approved",
  "human_rejected",
] as const;

export type ApprovalStatus = (typeof approvalStatuses)[number];

export const defaultApprovalStorePath = ".triage/approvals.json";

export interface ApprovalRecord {
  approvalId: string;
  status: ApprovalStatus;
  catalogId: string;
  runbookId: string;
  incidentId: string;
  service: string;
  actionIntent: string;
  requestedAt: string;
  decidedAt?: string;
  executed: false;
  execution?: SimulatedExecutionRecord;
}

interface ApprovalStoreFile {
  approvals: ApprovalRecord[];
}

export function requestApproval(
  storePath: string,
  entry: MitigationCatalogEntry,
  details: { incidentId: string; service: string; now?: Date },
): ApprovalRecord {
  const store = loadApprovalStore(storePath);
  const approvalId = buildApprovalId(details.incidentId, entry.catalogId);
  const existing = store.approvals.find((approval) => approval.approvalId === approvalId);
  if (existing) {
    return existing;
  }
  const requestedAt = iso(details.now);
  const record: ApprovalRecord = {
    approvalId,
    status: "pending_human_approval",
    catalogId: entry.catalogId,
    runbookId: entry.runbookId,
    incidentId: details.incidentId,
    service: details.service,
    actionIntent: entry.actionIntent,
    requestedAt,
    executed: false,
  };
  upsertApproval(store, record);
  saveApprovalStore(storePath, store);
  return record;
}

export function decideApproval(
  storePath: string,
  entry: MitigationCatalogEntry,
  details: {
    incidentId: string;
    service: string;
    status: "human_approved" | "human_rejected";
    execution?: SimulatedExecutionRecord;
    now?: Date;
  },
): ApprovalRecord {
  const store = loadApprovalStore(storePath);
  const approvalId = buildApprovalId(details.incidentId, entry.catalogId);
  const existing = store.approvals.find((approval) => approval.approvalId === approvalId);
  const decidedAt = iso(details.now);
  const record: ApprovalRecord = {
    approvalId,
    status: details.status,
    catalogId: entry.catalogId,
    runbookId: entry.runbookId,
    incidentId: details.incidentId,
    service: details.service,
    actionIntent: entry.actionIntent,
    requestedAt: existing?.requestedAt ?? decidedAt,
    decidedAt,
    executed: false,
  };
  if (details.execution) {
    record.execution = details.execution;
  }
  upsertApproval(store, record);
  saveApprovalStore(storePath, store);
  return record;
}

export function getApproval(storePath: string, approvalId: string): ApprovalRecord | undefined {
  return loadApprovalStore(storePath).approvals.find((approval) => approval.approvalId === approvalId);
}

export function listApprovals(storePath: string): ApprovalRecord[] {
  return [...loadApprovalStore(storePath).approvals]
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

export function approvalRecordToJson(record: ApprovalRecord): Record<string, unknown> {
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

export function buildApprovalId(incidentId: string, catalogId: string): string {
  return `approval:${incidentId}:${catalogId}`;
}

function loadApprovalStore(storePath: string): ApprovalStoreFile {
  if (!existsSync(storePath)) {
    return { approvals: [] };
  }
  return parseApprovalStore(JSON.parse(readFileSync(storePath, "utf8")) as unknown);
}

function saveApprovalStore(storePath: string, store: ApprovalStoreFile): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
}

function parseApprovalStore(payload: unknown): ApprovalStoreFile {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Approval store must be an object.");
  }
  const approvals = (payload as Record<string, unknown>).approvals;
  if (!Array.isArray(approvals)) {
    throw new Error("Approval store approvals must be an array.");
  }
  return {
    approvals: approvals.map(parseApprovalRecord),
  };
}

function parseApprovalRecord(payload: unknown): ApprovalRecord {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Approval record must be an object.");
  }
  const record = payload as Record<string, unknown>;
  const approval: ApprovalRecord = {
    approvalId: readString(record.approvalId ?? record.approval_id, "approval_id"),
    status: readApprovalStatus(record.status),
    catalogId: readString(record.catalogId ?? record.catalog_id, "catalog_id"),
    runbookId: readString(record.runbookId ?? record.runbook_id, "runbook_id"),
    incidentId: readString(record.incidentId ?? record.incident_id, "incident_id"),
    service: readString(record.service, "service"),
    actionIntent: readString(record.actionIntent ?? record.action_intent, "action_intent"),
    requestedAt: readString(record.requestedAt ?? record.requested_at, "requested_at"),
    executed: false,
  };
  const decidedAt = record.decidedAt ?? record.decided_at;
  if (decidedAt !== undefined) {
    approval.decidedAt = readString(decidedAt, "decided_at");
  }
  if (record.execution !== undefined) {
    approval.execution = parseExecution(record.execution);
  }
  return approval;
}

function parseExecution(payload: unknown): SimulatedExecutionRecord {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Approval execution must be an object.");
  }
  const record = payload as Record<string, unknown>;
  if (record.status !== "simulated_not_executed") {
    throw new Error("Approval execution status is unsupported.");
  }
  if (record.executed !== false || record.dryRun !== true) {
    throw new Error("Approval execution must remain dry-run and unexecuted.");
  }
  return {
    status: "simulated_not_executed",
    catalogId: readString(record.catalogId ?? record.catalog_id, "execution.catalog_id"),
    runbookId: readString(record.runbookId ?? record.runbook_id, "execution.runbook_id"),
    actionIntent: readString(record.actionIntent ?? record.action_intent, "execution.action_intent"),
    executed: false,
    dryRun: true,
    reason: readString(record.reason, "execution.reason"),
  };
}

function upsertApproval(store: ApprovalStoreFile, record: ApprovalRecord): void {
  const index = store.approvals.findIndex((approval) => approval.approvalId === record.approvalId);
  if (index >= 0) {
    store.approvals[index] = record;
    return;
  }
  store.approvals.push(record);
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`${label} must be a non-empty string.`);
}

function readApprovalStatus(value: unknown): ApprovalStatus {
  if (value === "pending_human_approval" || value === "human_approved" || value === "human_rejected") {
    return value;
  }
  throw new Error("Approval status is unsupported.");
}

function iso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}
