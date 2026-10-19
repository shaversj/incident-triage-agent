import type { IncomingMessage, ServerResponse } from "node:http";

import {
  approvalRecordToJson,
  decideApproval,
  getApproval,
  listApprovals,
} from "../approval-store";
import { loadMitigationCatalog } from "../mitigation-control";
import { simulateApprovedMitigation } from "../mitigation-executor";
import { approvalRoutesEnabled, approvalStorePath } from "./approval-support";
import type { WebhookRuntime } from "./contracts";
import { writeJson } from "./http";

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
