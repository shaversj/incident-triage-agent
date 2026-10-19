import type { IncomingMessage, ServerResponse } from "node:http";

import {
  approvalRecordToJson,
  defaultApprovalStorePath,
  decideApproval,
  getApproval,
  listApprovals,
  requestApproval,
} from "../approval-store";
import { loadMitigationCatalog } from "../mitigation-control";
import { simulateApprovedMitigation } from "../mitigation-executor";
import type { TriageRunReviewRecord } from "../persistence/contracts";
import type { TriageRun } from "../workflow";
import type { WebhookRuntime } from "./contracts";
import { runtimeMode, writeJson } from "./http";

export function approvalRoutesEnabled(runtime: WebhookRuntime): boolean {
  return runtimeMode(runtime) !== "read_only";
}

export function approvalSurfaceDisabled(
  runtime: WebhookRuntime,
  method: string | undefined,
  pathname: string,
): boolean {
  if (approvalRoutesEnabled(runtime)) {
    return false;
  }
  if (method === "GET" && (pathname === "/" || pathname === "/approvals")) {
    return true;
  }
  return pathname === "/api/approvals" || pathname.startsWith("/api/approvals/");
}

export function routeApprovalList(response: ServerResponse, runtime: WebhookRuntime): void {
  writeJson(response, 200, approvalsListResponse(runtime));
}

export async function routeApprovalApi(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  pathname: string,
): Promise<void> {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "approvals") {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }

  const approvalId = decodeURIComponent(parts[2] ?? "");
  if (parts.length === 3 && request.method === "GET") {
    const approval = getApproval(approvalStorePath(runtime), approvalId);
    if (!approval) {
      writeJson(response, 404, { status: "error", error: "approval_not_found" });
      return;
    }
    writeJson(response, 200, { approval: approvalRecordToJson(approval) });
    return;
  }

  if (parts.length === 4 && request.method === "POST" && (parts[3] === "approve" || parts[3] === "reject")) {
    const current = getApproval(approvalStorePath(runtime), approvalId);
    if (!current) {
      writeJson(response, 404, { status: "error", error: "approval_not_found" });
      return;
    }
    const catalogEntry = loadMitigationCatalog(runtime.fixturesDir)
      .find((entry) => entry.catalogId === current.catalogId);
    if (!catalogEntry) {
      writeJson(response, 409, { status: "error", error: "catalog_entry_not_found" });
      return;
    }
    const decision = parts[3];
    const details: Parameters<typeof decideApproval>[2] = {
      incidentId: current.incidentId,
      service: current.service,
      status: decision === "approve" ? "human_approved" : "human_rejected",
    };
    if (decision === "approve") {
      details.execution = simulateApprovedMitigation(catalogEntry);
    }
    const record = decideApproval(approvalStorePath(runtime), catalogEntry, details);
    writeJson(response, 200, { approval: approvalRecordToJson(record) });
    return;
  }

  writeJson(response, 404, { status: "error", error: "not_found" });
}

export function resolveRunApproval(
  review: TriageRunReviewRecord,
  runtime: WebhookRuntime,
): Record<string, unknown> {
  const approvalId = linkedApprovalId(review);
  const enabled = approvalRoutesEnabled(runtime);
  const response: Record<string, unknown> = { enabled };
  if (!approvalId) {
    return response;
  }
  response.approval_id = approvalId;
  if (!enabled) {
    return response;
  }
  const approval = getApproval(approvalStorePath(runtime), approvalId);
  if (approval) {
    response.record = approvalRecordToJson(approval);
  }
  return response;
}

export function persistApprovalRequest(run: TriageRun, runtime: WebhookRuntime): void {
  const approvalRequest = run.mitigationControl?.approvalRequest;
  if (!approvalRequest || !runtime.approvalStorePath || !approvalRoutesEnabled(runtime)) {
    return;
  }
  const catalogEntry = loadMitigationCatalog(runtime.fixturesDir)
    .find((entry) => entry.catalogId === approvalRequest.catalogId);
  if (!catalogEntry) {
    return;
  }
  requestApproval(runtime.approvalStorePath, catalogEntry, {
    incidentId: approvalRequest.incidentId,
    service: approvalRequest.service,
  });
}

function approvalStorePath(runtime: WebhookRuntime): string {
  return runtime.approvalStorePath ?? defaultApprovalStorePath;
}

function approvalsListResponse(runtime: WebhookRuntime): Record<string, unknown> {
  const approvals = listApprovals(approvalStorePath(runtime)).map(approvalRecordToJson);
  const pending = approvals.filter((approval) => approval.status === "pending_human_approval").length;
  return {
    status: "ok",
    approvals,
    summary: {
      total: approvals.length,
      pending,
      decided: approvals.length - pending,
    },
  };
}

function linkedApprovalId(review: TriageRunReviewRecord): string | undefined {
  const approvalId = review.run.reviewEnvelope?.mitigationControl?.approvalRequest?.approvalId;
  if (approvalId && approvalId.length > 0) {
    return approvalId;
  }
  return undefined;
}
