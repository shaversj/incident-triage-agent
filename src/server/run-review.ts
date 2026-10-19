import type { IncomingMessage, ServerResponse } from "node:http";

import type { IncidentLifecycleReviewRecord } from "../persistence/contracts";
import { resolveRunApproval } from "./approval-support";
import type { WebhookRuntime } from "./contracts";
import { numberQueryParam, operatorReadAuthorized, writeJson } from "./http";
import { objectValue, runListToResponse, runReviewToResponse } from "./response-mapping";

export async function routeRunReviewApi(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  url: URL,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { status: "error", error: "method_not_allowed" });
    return;
  }
  if (!operatorReadAuthorized(request.headers, runtime)) {
    writeJson(response, 401, { status: "error", error: "unauthorized" });
    return;
  }
  if (url.pathname === "/api/runs") {
    if (!runtime.runStore) {
      writeJson(response, 404, { status: "error", error: "run_list_unavailable" });
      return;
    }
    const limit = numberQueryParam(url.searchParams.get("limit"));
    const runs = await runtime.runStore.listTriageRuns(limit === undefined ? {} : { limit });
    writeJson(response, 200, runListToResponse(runs));
    return;
  }

  if (!runtime.runStore) {
    writeJson(response, 404, { status: "error", error: "run_review_unavailable" });
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "runs") {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }
  const runId = decodeURIComponent(parts[2] ?? "");
  const review = await runtime.runStore.getTriageRunReview(runId);
  if (!review) {
    writeJson(response, 404, { status: "error", error: "run_not_found" });
    return;
  }

  const approval = resolveRunApproval(review, runtime);
  const lifecycle = await runtime.runStore.getIncidentLifecycle(review.run.incidentId);
  writeJson(response, 200, runReviewToResponse(review, {
    approval,
    lifecycle: projectAwaitingVerification(lifecycle, approval),
  }));
}

function projectAwaitingVerification(
  lifecycle: IncidentLifecycleReviewRecord,
  approval: Record<string, unknown>,
): IncidentLifecycleReviewRecord {
  const approvalRecord = objectValue(approval.record);
  if (
    lifecycle.projection.state === "open"
    && lifecycle.verificationEvents.length === 0
    && approvalRecord.status === "human_approved"
  ) {
    return {
      ...lifecycle,
      projection: { ...lifecycle.projection, state: "awaiting_verification" },
    };
  }
  return lifecycle;
}
