import type { IncomingMessage, ServerResponse } from "node:http";

import {
  parseVerificationOutcomeInput,
  recoveryFailureClasses,
  recoveryResetReasons,
  type RecoveryFailureClass,
  type RecoveryResetReason,
} from "../incident-lifecycle";
import { buildReducedOutcomeCandidate } from "../outcome-promotion";
import type { OutcomeReviewCandidateStatus } from "../persistence/contracts";
import type { WebhookRuntime } from "./contracts";
import {
  firstHeader,
  operatorReadAuthorized,
  operatorWriteAuthorized,
  readRequestBody,
  requiredBodyText,
  runtimeMode,
  writeJson,
} from "./http";
import { objectValue } from "./response-mapping";

export async function routeIncidentLifecycleApi(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  url: URL,
): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "incidents") {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }
  if (!runtime.runStore) {
    writeJson(response, 503, { status: "error", error: "lifecycle_store_unavailable" });
    return;
  }
  const incidentId = decodeURIComponent(parts[2] ?? "");
  if (parts[3] === "lifecycle" && request.method === "GET") {
    if (!operatorReadAuthorized(request.headers, runtime)) {
      writeJson(response, 401, { status: "error", error: "unauthorized" });
      return;
    }
    writeJson(response, 200, {
      status: "ok",
      lifecycle: await runtime.runStore.getIncidentLifecycle(incidentId),
    });
    return;
  }
  if (parts[3] === "verification" && request.method === "POST") {
    if (!operatorWriteAuthorized(request, runtime)) {
      writeJson(response, 401, { status: "error", error: "write_unauthorized" });
      return;
    }
    const sourceEventKey = firstHeader(request.headers["idempotency-key"]);
    if (!sourceEventKey) {
      writeJson(response, 400, { status: "error", error: "idempotency_key_required" });
      return;
    }
    let input: ReturnType<typeof parseVerificationOutcomeInput>;
    try {
      const raw = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
      input = parseVerificationOutcomeInput({
        ...raw,
        source: "operator",
        source_reference: runtime.operatorWriteActor ?? "operator:authenticated",
      });
    } catch (error) {
      writeJson(response, 400, {
        status: "error",
        error: error instanceof Error ? error.message : "invalid_verification",
      });
      return;
    }
    const relatedRun = await runtime.runStore.getTriageRunReview(input.runId);
    if (!relatedRun || relatedRun.run.incidentId !== incidentId) {
      writeJson(response, 409, { status: "error", error: "verification_run_incident_mismatch" });
      return;
    }
    const result = await runtime.runStore.recordVerificationOutcome({
      incidentId,
      sourceEventKey,
      verification: input,
    }, {
      retentionClass: runtimeMode(runtime) === "read_only" ? "read_only_triage" : "ephemeral",
    });
    const recovery = result.created && input.outcome === "unresolved"
      ? await runtime.runStore.recordRecoveryFailure({
        incidentId,
        runId: input.runId,
        sourceEventKey: `verification:${sourceEventKey}`,
        failureClass: "unresolved_mitigation",
        rationale: input.rationale,
      }, {
        retentionClass: runtimeMode(runtime) === "read_only" ? "read_only_triage" : "ephemeral",
      })
      : undefined;
    writeJson(response, result.created ? 201 : 200, {
      status: "ok",
      created: result.created,
      verification: result.record,
      ...(recovery ? { recovery } : {}),
      lifecycle: await runtime.runStore.getIncidentLifecycle(incidentId),
    });
    return;
  }
  if (parts[3] === "recovery" && parts.length >= 5 && request.method === "POST") {
    if (!operatorWriteAuthorized(request, runtime)) {
      writeJson(response, 401, { status: "error", error: "write_unauthorized" });
      return;
    }
    const sourceEventKey = firstHeader(request.headers["idempotency-key"]);
    if (!sourceEventKey) {
      writeJson(response, 400, { status: "error", error: "idempotency_key_required" });
      return;
    }
    const failureClass = decodeURIComponent(parts[4] ?? "") as RecoveryFailureClass;
    if (!recoveryFailureClasses.includes(failureClass)) {
      writeJson(response, 400, { status: "error", error: "invalid_failure_class" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    } catch {
      writeJson(response, 400, { status: "error", error: "invalid_json" });
      return;
    }
    const rationale = requiredBodyText(body.rationale);
    if (!rationale) {
      writeJson(response, 400, { status: "error", error: "rationale_required" });
      return;
    }
    const runId = requiredBodyText(body.run_id ?? body.runId);
    if (parts.length === 6 && parts[5] === "reset") {
      const reason = body.reason as RecoveryResetReason;
      if (!recoveryResetReasons.includes(reason) || reason !== "operator_reset") {
        writeJson(response, 400, { status: "error", error: "invalid_reset_reason" });
        return;
      }
      const result = await runtime.runStore.resetRecoveryBudget({
        incidentId,
        sourceEventKey,
        failureClass,
        reason,
        actor: runtime.operatorWriteActor ?? "operator:authenticated",
        rationale,
        ...(runId ? { runId } : {}),
      });
      writeJson(response, result.created ? 201 : 200, { status: "ok", ...result });
      return;
    }
    if (parts.length !== 5) {
      writeJson(response, 404, { status: "error", error: "not_found" });
      return;
    }
    const result = await runtime.runStore.recordRecoveryFailure({
      incidentId,
      sourceEventKey,
      failureClass,
      rationale,
      ...(runId ? { runId } : {}),
    });
    writeJson(response, result.created ? 201 : 200, { status: "ok", ...result });
    return;
  }
  if (parts[3] === "feedback" && parts.length === 4 && request.method === "POST") {
    if (!operatorWriteAuthorized(request, runtime)) {
      writeJson(response, 401, { status: "error", error: "write_unauthorized" });
      return;
    }
    const sourceEventId = firstHeader(request.headers["idempotency-key"]);
    if (!sourceEventId) {
      writeJson(response, 400, { status: "error", error: "idempotency_key_required" });
      return;
    }
    try {
      const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
      const category = body.category;
      if (category !== "corrected_finding" && category !== "reasoned_rejection") {
        writeJson(response, 400, { status: "error", error: "invalid_feedback_category" });
        return;
      }
      const runId = requiredBodyText(body.run_id ?? body.runId);
      const candidate = buildReducedOutcomeCandidate({
        incidentId,
        sourceEventId,
        category,
        rationale: requiredBodyText(body.rationale) ?? "",
        evidenceIds: Array.isArray(body.evidence_ids) ? body.evidence_ids.map(String) : [],
        snapshot: objectValue(body.snapshot),
        ...(runId ? { runId } : {}),
      });
      const result = await runtime.runStore.recordOutcomeReviewCandidate(candidate);
      writeJson(response, result.created ? 201 : 200, { status: "ok", ...result });
    } catch (error) {
      writeJson(response, 400, {
        status: "error",
        error: error instanceof Error ? error.message : "invalid_feedback",
      });
    }
    return;
  }
  writeJson(response, 405, { status: "error", error: "method_not_allowed" });
}

export async function routeOutcomeCandidateApi(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  url: URL,
): Promise<void> {
  if (!runtime.runStore) {
    writeJson(response, 503, { status: "error", error: "lifecycle_store_unavailable" });
    return;
  }
  if (url.pathname === "/api/outcome-candidates" && request.method === "GET") {
    if (!operatorReadAuthorized(request.headers, runtime)) {
      writeJson(response, 401, { status: "error", error: "unauthorized" });
      return;
    }
    const status = url.searchParams.get("status");
    const options: { status?: OutcomeReviewCandidateStatus } = {};
    if (status === "pending" || status === "imported") {
      options.status = status;
    }
    writeJson(response, 200, {
      status: "ok",
      candidates: await runtime.runStore.listOutcomeReviewCandidates(options),
    });
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length === 4
    && parts[0] === "api"
    && parts[1] === "outcome-candidates"
    && parts[3] === "import"
    && request.method === "POST"
  ) {
    if (!operatorWriteAuthorized(request, runtime)) {
      writeJson(response, 401, { status: "error", error: "write_unauthorized" });
      return;
    }
    const candidate = await runtime.runStore.markOutcomeReviewCandidateImported(decodeURIComponent(parts[2] ?? ""));
    writeJson(response, 200, { status: "ok", candidate });
    return;
  }
  writeJson(response, 404, { status: "error", error: "not_found" });
}
