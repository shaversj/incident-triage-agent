import {
  approvalRecordToJson,
  defaultApprovalStorePath,
  getApproval,
  requestApproval,
} from "../approval-store";
import { loadMitigationCatalog } from "../mitigation-control";
import type { TriageRunReviewRecord } from "../persistence/contracts";
import type { TriageRun } from "../workflow";
import type { WebhookRuntime } from "./contracts";
import { runtimeMode } from "./http";

export function approvalRoutesEnabled(runtime: WebhookRuntime): boolean {
  return runtimeMode(runtime) !== "read_only";
}

export function approvalStorePath(runtime: WebhookRuntime): string {
  return runtime.approvalStorePath ?? defaultApprovalStorePath;
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

function linkedApprovalId(review: TriageRunReviewRecord): string | undefined {
  const approvalId = review.run.reviewEnvelope?.mitigationControl?.approvalRequest?.approvalId;
  return approvalId && approvalId.length > 0 ? approvalId : undefined;
}
