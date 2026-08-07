import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  approvalRecordToJson,
  defaultApprovalStorePath,
  decideApproval,
  getApproval,
  listApprovals,
  requestApproval,
} from "./approval-store";
import { approvalConsoleHtml } from "./approval-console";
import type { OperatorMode } from "./config";
import { type Scenario } from "./domain";
import { PrebuiltOperationalTools, loadTools, type Evidence } from "./evidence";
import {
  GrafanaPayloadError,
  defaultGrafanaSignatureHeader,
  defaultGrafanaTimestampHeader,
  defaultGrafanaTimestampToleranceMs,
  normalizeGrafanaPayload,
  verifyGrafanaWebhookHmac,
} from "./grafana";
import type { LLMDecisionClient } from "./llm";
import { noopLogger, type TriageLogger } from "./logger";
import { loadMitigationCatalog, type MitigationControlResult } from "./mitigation-control";
import { simulateApprovedMitigation } from "./mitigation-executor";
import type { TriageRunPersistenceStore, TriageRunRecord, TriageRunReviewRecord } from "./persistence";
import { RecordedLokiClient } from "./recorded-observability";
import { runReviewConsoleHtml } from "./run-review-console";
import { TriageWorkflow, type TriageRun } from "./workflow";

export interface WebhookRuntime {
  fixturesDir: string;
  webhookSecret: string;
  llmClient: LLMDecisionClient;
  lokiClient?: LokiClientLike;
  lokiLimit: number;
  mode?: OperatorMode;
  runStore?: TriageRunPersistenceStore;
  operatorReadToken?: string;
  hmacToleranceMs?: number;
  replayTtlMs?: number;
  retentionCleanupIntervalMs?: number;
  approvalStorePath?: string;
}

export interface WebhookServerOptions {
  host: string;
  port: number;
  runtime: WebhookRuntime;
  logger?: TriageLogger;
}

export interface RunningWebhookServer {
  server: Server;
  ready: Promise<void>;
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface LokiClientLike {
  queryRange(
    labels: Record<string, string>,
    startNs: number,
    endNs: number,
    options: { limit?: number; direction?: "forward" | "backward" },
  ): Promise<LokiLogEntryLike[]>;
  toEvidence(entries: LokiLogEntryLike[]): Evidence[];
}

interface LokiLogEntryLike {
  timestampNs: string;
  line: string;
  labels: Record<string, string>;
}

interface HandleGrafanaWebhookOptions {
  bodyDigest?: string;
}

interface DemoScenarioDescriptor {
  id: string;
  label: string;
  grafanaFixture: string;
  logFixture: string;
}

const demoScenarios: DemoScenarioDescriptor[] = [
  {
    id: "bad-deploy-latency",
    label: "Bad deploy latency",
    grafanaFixture: "bad-deploy-latency-webhook.json",
    logFixture: "bad-deploy-latency",
  },
  {
    id: "capacity-saturation",
    label: "Capacity saturation",
    grafanaFixture: "capacity-saturation-webhook.json",
    logFixture: "capacity-saturation",
  },
  {
    id: "checkout-payment-timeout",
    label: "Checkout payment timeout",
    grafanaFixture: "checkout-payment-timeout-webhook.json",
    logFixture: "checkout-payment-timeout",
  },
];

export async function handleGrafanaWebhook(
  payload: unknown,
  providedSecret: string | undefined,
  runtime: WebhookRuntime,
  options: HandleGrafanaWebhookOptions = {},
): Promise<[number, Record<string, unknown>]> {
  if (runtimeMode(runtime) === "read_only" && !options.bodyDigest) {
    return [401, { status: "error", error: "signed_ingestion_required" }];
  }
  if (runtime.webhookSecret && providedSecret !== runtime.webhookSecret) {
    return [401, { status: "error", error: "unauthorized" }];
  }

  let normalized;
  try {
    normalized = normalizeGrafanaPayload(payload);
  } catch (error) {
    if (error instanceof GrafanaPayloadError || error instanceof Error) {
      return [400, { status: "error", error: error.message }];
    }
    return [400, { status: "error", error: String(error) }];
  }

  if (normalized.ignored) {
    return [202, {
      status: "ignored",
      reason: normalized.ignoredReason,
      incident_id: normalized.incident.incidentId,
    }];
  }

  const extraMissing: string[] = [];
  let logEvidence: Evidence[] = [];
  if (runtime.lokiClient) {
    try {
      const entries = await runtime.lokiClient.queryRange(
        normalized.lokiQueryLabels,
        normalized.startNs,
        normalized.endNs,
        { limit: runtime.lokiLimit, direction: "forward" },
      );
      logEvidence = runtime.lokiClient.toEvidence(entries);
      if (logEvidence.length === 0) {
        extraMissing.push("logs");
      }
    } catch {
      extraMissing.push("logs");
    }
  } else {
    extraMissing.push("logs");
  }

  const tools = loadTools(runtime.fixturesDir);
  const package_ = tools.buildEvidencePackageFromIncident(
    normalized.scenarioName,
    normalized.incident,
    { logEvidence, extraMissingContext: extraMissing },
  );
  const scenario: Scenario = {
    name: normalized.scenarioName,
    incident: normalized.incident,
  };
  const workflowOptions = { mode: runtimeMode(runtime) };
  const runId = runIdForWebhook(normalized.incident.incidentId, options.bodyDigest);
  if (runId) {
    Object.assign(workflowOptions, { runId });
  }
  const workflow = new TriageWorkflow(
    new PrebuiltOperationalTools(package_),
    runtime.llmClient,
    undefined,
    workflowOptions,
  );
  const run = await workflow.run(scenario);
  await persistTriageRun(run, runtime);
  persistApprovalRequest(run, runtime);
  return [200, runToResponse(run)];
}

export function startWebhookServer(options: WebhookServerOptions): RunningWebhookServer {
  const logger = options.logger ?? noopLogger;
  const retentionCleanup = startRetentionCleanup(options.runtime, logger);
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options.runtime, logger);
    } catch (error) {
      logger.error({ component: "server", error: error instanceof Error ? error.message : String(error) }, "Unhandled request error");
      writeJson(response, 500, { status: "error", error: "internal_server_error" });
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => server.once("close", resolve));

  const shutdown = () => {
    retentionCleanup.stop();
    void closeServer(server);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return {
    server,
    ready,
    closed,
    close: async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      retentionCleanup.stop();
      await closeServer(server);
    },
  };
}

function startRetentionCleanup(runtime: WebhookRuntime, logger: TriageLogger): { stop(): void } {
  const cleanupExpired = runtime.runStore?.cleanupExpired.bind(runtime.runStore);
  if (!cleanupExpired) {
    return { stop: () => undefined };
  }
  const cleanup = () => {
    void cleanupExpired()
      .catch((error) => {
        logger.warn({
          component: "server",
          error: error instanceof Error ? error.message : String(error),
        }, "Failed to clean expired triage persistence rows");
      });
  };
  cleanup();
  const interval = setInterval(cleanup, runtime.retentionCleanupIntervalMs ?? 60 * 60 * 1000);
  interval.unref?.();
  return {
    stop: () => clearInterval(interval),
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  logger: TriageLogger,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (approvalSurfaceDisabled(runtime, request.method, url.pathname)) {
    writeJson(response, 404, { status: "error", error: "approval_routes_disabled" });
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/approvals")) {
    writeHtml(response, 200, approvalConsoleHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/runs") {
    writeHtml(response, 200, runReviewConsoleHtml());
    return;
  }

  if (url.pathname === "/api/approvals") {
    if (request.method !== "GET") {
      writeJson(response, 405, { status: "error", error: "method_not_allowed" });
      return;
    }
    writeJson(response, 200, approvalsListResponse(runtime));
    return;
  }

  if (url.pathname.startsWith("/api/approvals/")) {
    await routeApprovalApi(request, response, runtime, url.pathname);
    return;
  }

  if (url.pathname === "/api/demo/scenarios" || url.pathname.startsWith("/api/demo/scenarios/")) {
    await routeDemoScenarioApi(request, response, runtime, url);
    return;
  }

  if (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/")) {
    await routeRunReviewApi(request, response, runtime, url);
    return;
  }

  if (request.method !== "POST" || request.url !== "/webhooks/grafana") {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRequestBody(request);
  } catch {
    writeJson(response, 413, { status: "error", error: "request_body_too_large" });
    return;
  }

  const auth = await authenticateGrafanaRequest(rawBody, request.headers, runtime);
  if (!auth.accepted) {
    writeJson(response, auth.status, { status: "error", error: auth.error });
    return;
  }

  const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    writeJson(response, 400, { status: "error", error: "invalid_json" });
    return;
  }

  const replayClaim = await claimGrafanaReplay(bodyDigest, auth, runtime);
  if (!replayClaim.accepted) {
    writeJson(response, replayClaim.status, { status: "error", error: replayClaim.error });
    return;
  }

  logger.info({ component: "server" }, "Grafana webhook received");
  try {
    const [status, body] = await handleGrafanaWebhook(payload, runtime.webhookSecret, runtime, { bodyDigest });
    writeJson(response, status, body);
    if ((status < 200 || status >= 300) && replayClaim.replayKey) {
      await releaseGrafanaReplay(replayClaim.replayKey, runtime, logger);
    }
  } catch (error) {
    if (replayClaim.replayKey) {
      await releaseGrafanaReplay(replayClaim.replayKey, runtime, logger);
    }
    throw error;
  }
}

async function authenticateGrafanaRequest(
  rawBody: string,
  headers: IncomingHttpHeaders,
  runtime: WebhookRuntime,
): Promise<
  | { accepted: true; signature?: string; timestamp?: string }
  | { accepted: false; status: number; error: string }
> {
  const signature = firstHeader(headers[defaultGrafanaSignatureHeader]);
  const timestamp = firstHeader(headers[defaultGrafanaTimestampHeader]);
  const legacySecret = firstHeader(headers["x-webhook-secret"]);
  const requiresHmac = runtimeMode(runtime) === "read_only";

  if (signature || requiresHmac) {
    if (requiresHmac && !timestamp) {
      return { accepted: false, status: 401, error: "missing_hmac_timestamp" };
    }
    try {
      const hmacOptions = {
        rawBody,
        secret: runtime.webhookSecret,
        signature,
      };
      if (timestamp) {
        Object.assign(hmacOptions, { timestamp });
      }
      if (runtime.hmacToleranceMs !== undefined) {
        Object.assign(hmacOptions, { toleranceMs: runtime.hmacToleranceMs });
      }
      verifyGrafanaWebhookHmac(hmacOptions);
    } catch (error) {
      return {
        accepted: false,
        status: 401,
        error: error instanceof GrafanaPayloadError ? hmacErrorCode(error) : "invalid_hmac_signature",
      };
    }
    const accepted: { accepted: true; signature?: string; timestamp?: string } = { accepted: true };
    if (signature) {
      accepted.signature = signature;
    }
    if (timestamp) {
      accepted.timestamp = timestamp;
    }
    return accepted;
  }

  if (runtime.webhookSecret && legacySecret !== runtime.webhookSecret) {
    return { accepted: false, status: 401, error: "unauthorized" };
  }
  return { accepted: true };
}

async function claimGrafanaReplay(
  bodyDigest: string,
  auth: { accepted: true; signature?: string; timestamp?: string },
  runtime: WebhookRuntime,
): Promise<{ accepted: true; replayKey?: string } | { accepted: false; status: number; error: string }> {
  if (!auth.timestamp) {
    return { accepted: true };
  }
  if (!runtime.runStore) {
    if (runtimeMode(runtime) === "read_only") {
      return { accepted: false, status: 503, error: "replay_store_unavailable" };
    }
    return { accepted: true };
  }
  const replayClaim = await runtime.runStore.claimReplayKey({
    sender: "grafana",
    signature: (auth.signature ?? "").toLowerCase(),
    timestamp: auth.timestamp,
    bodyDigest,
    ttlMs: runtime.replayTtlMs ?? runtime.hmacToleranceMs ?? defaultGrafanaTimestampToleranceMs,
  });
  if (!replayClaim.accepted) {
    return { accepted: false, status: 409, error: "replayed_webhook" };
  }
  return { accepted: true, replayKey: replayClaim.replayKey };
}

async function releaseGrafanaReplay(replayKey: string, runtime: WebhookRuntime, logger: TriageLogger): Promise<void> {
  try {
    await runtime.runStore?.releaseReplayKey?.(replayKey);
  } catch (error) {
    logger.warn({ component: "server", error: error instanceof Error ? error.message : String(error) }, "Failed to release replay key");
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hmacErrorCode(error: GrafanaPayloadError): string {
  if (error.message.includes("timestamp")) {
    return "invalid_hmac_timestamp";
  }
  return "invalid_hmac_signature";
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > 1_000_000) {
        if (!rejected) {
          rejected = true;
          reject(new Error("request body too large"));
        }
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
  });
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
  });
  response.end(encoded);
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function routeApprovalApi(
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

async function routeRunReviewApi(
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
    if (!runtime.runStore?.listTriageRuns) {
      writeJson(response, 404, { status: "error", error: "run_list_unavailable" });
      return;
    }
    const limit = numberQueryParam(url.searchParams.get("limit"));
    const runs = await runtime.runStore.listTriageRuns(limit === undefined ? {} : { limit });
    writeJson(response, 200, runListToResponse(runs));
    return;
  }

  if (!runtime.runStore?.getTriageRunReview) {
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
  writeJson(response, 200, runReviewToResponse(review));
}

async function routeDemoScenarioApi(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  url: URL,
): Promise<void> {
  if (runtimeMode(runtime) !== "local") {
    writeJson(response, 403, { status: "error", error: "demo_scenarios_local_only" });
    return;
  }

  if (url.pathname === "/api/demo/scenarios") {
    if (request.method !== "GET") {
      writeJson(response, 405, { status: "error", error: "method_not_allowed" });
      return;
    }
    writeJson(response, 200, {
      status: "ok",
      scenarios: demoScenarios.map(({ id, label }) => ({ id, label })),
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { status: "error", error: "method_not_allowed" });
    return;
  }
  if (!runtime.runStore) {
    writeJson(response, 503, { status: "error", error: "run_store_unavailable" });
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "api" || parts[1] !== "demo" || parts[2] !== "scenarios") {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }
  const scenarioId = decodeURIComponent(parts[3] ?? "");
  const scenario = demoScenarios.find((item) => item.id === scenarioId);
  if (!scenario) {
    writeJson(response, 404, { status: "error", error: "demo_scenario_not_found" });
    return;
  }

  const rawBody = readFileSync(join(runtime.fixturesDir, "grafana", scenario.grafanaFixture), "utf8");
  const payload = JSON.parse(rawBody) as unknown;
  const demoRuntime: WebhookRuntime = {
    ...runtime,
    mode: "read_only",
    lokiClient: RecordedLokiClient.fromFixture(scenario.logFixture, runtime.fixturesDir),
  };
  const bodyDigest = createHash("sha256")
    .update(rawBody)
    .update(":demo:")
    .update(String(Date.now()))
    .update(":")
    .update(String(process.hrtime.bigint()))
    .digest("hex");
  const [status, body] = await handleGrafanaWebhook(payload, runtime.webhookSecret, demoRuntime, { bodyDigest });
  writeJson(response, status, {
    ...body,
    demo_scenario: scenario.id,
  });
}

function numberQueryParam(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function operatorReadAuthorized(headers: IncomingHttpHeaders, runtime: WebhookRuntime): boolean {
  if (!runtime.operatorReadToken) {
    return runtimeMode(runtime) === "local";
  }
  return firstHeader(headers.authorization) === `Bearer ${runtime.operatorReadToken}`;
}

function runListToResponse(runs: TriageRunRecord[]): Record<string, unknown> {
  const bySafety = new Map<string, number>();
  for (const run of runs) {
    const key = run.safetyStatus ?? "not_available";
    bySafety.set(key, (bySafety.get(key) ?? 0) + 1);
  }
  return {
    status: "ok",
    runs: runs.map(runRecordToResponse),
    summary: {
      total: runs.length,
      by_safety_status: Object.fromEntries(bySafety.entries()),
    },
  };
}

function runRecordToResponse(run: TriageRunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    incident_id: run.incidentId,
    incident_title: run.incidentTitle,
    severity: run.severity,
    incident_status: run.incidentStatus,
    started_at: run.startedAt,
    scenario_name: run.scenarioName,
    service: run.service,
    run_status: run.runStatus,
    validation_status: run.validationStatus,
    safety_status: run.safetyStatus,
    mitigation_status: run.mitigationStatus,
    evidence_ids: run.evidenceIds,
    scorecard: run.scorecard,
    retention_class: run.retentionClass,
    correlation_id: run.correlationId,
    created_at: run.createdAt,
    expires_at: run.expiresAt,
  };
}

function runReviewToResponse(review: TriageRunReviewRecord): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: "ok",
    run: runRecordToResponse(review.run),
  };
  const normalizedReview = reviewEnvelopeToResponse(review.run.reviewEnvelope);
  if (normalizedReview) {
    response.review = normalizedReview;
  }
  if (review.evidenceSnapshot) {
    response.evidence_snapshot = {
      run_id: review.evidenceSnapshot.runId,
      incident_id: review.evidenceSnapshot.incidentId,
      evidence: review.evidenceSnapshot.evidence,
      missing_context: review.evidenceSnapshot.missingContext,
      retention_class: review.evidenceSnapshot.retentionClass,
      created_at: review.evidenceSnapshot.createdAt,
      expires_at: review.evidenceSnapshot.expiresAt,
    };
  }
  return response;
}

function reviewEnvelopeToResponse(envelope: unknown): Record<string, unknown> | undefined {
  const source = objectValue(envelope);
  const response: Record<string, unknown> = {};
  if (source.investigation) {
    response.investigation = investigationToResponse(source.investigation);
  }
  if (source.validation) {
    response.validation = source.validation;
  }
  if (source.explanation) {
    response.explanation = explanationToResponse(source.explanation);
  }
  if (source.explanationValidation) {
    response.explanation_validation = source.explanationValidation;
  }
  if (source.decision) {
    response.decision = decisionToResponse(source.decision);
  }
  if (source.safety) {
    response.safety = safetyToResponse(source.safety);
  }
  if (source.mitigationControl) {
    response.mitigation_control = mitigationControlToResponse(source.mitigationControl as MitigationControlResult);
  }
  if (source.provenance) {
    response.provenance = provenanceToResponse(source.provenance);
  }
  return Object.keys(response).length > 0 ? response : undefined;
}

function investigationToResponse(investigation: unknown): Record<string, unknown> {
  const source = objectValue(investigation);
  return {
    summary: source.summary,
    steps: arrayValue(source.steps).map((step) => {
      const item = objectValue(step);
      return {
        id: item.id,
        kind: item.kind,
        status: item.status,
        purpose: item.purpose,
        evidence_ids: item.evidenceIds,
      };
    }),
  };
}

function explanationToResponse(explanation: unknown): Record<string, unknown> {
  const source = objectValue(explanation);
  const response: Record<string, unknown> = {};
  if (source.hypotheses) {
    response.hypotheses = arrayValue(source.hypotheses).map((hypothesis) => {
      const item = objectValue(hypothesis);
      return {
        label: item.label,
        status: item.status,
        supporting_evidence_ids: item.supportingEvidenceIds,
        contradicting_evidence_ids: item.contradictingEvidenceIds,
      };
    });
  }
  if (source.findingSummary) {
    response.finding_summary = source.findingSummary;
  }
  if (source.recommendation) {
    const recommendation = objectValue(source.recommendation);
    response.recommendation = {
      rationale: recommendation.rationale,
      evidence_ids: recommendation.evidenceIds,
    };
  }
  return response;
}

function decisionToResponse(decision: unknown): Record<string, unknown> {
  const source = objectValue(decision);
  return {
    incident_class: source.incidentClass,
    next_action: source.nextAction,
    confidence: source.confidence,
    evidence_ids: source.evidenceIds,
    caveats: source.caveats,
    verification_plan: source.verificationPlan,
  };
}

function safetyToResponse(safety: unknown): Record<string, unknown> {
  const source = objectValue(safety);
  return {
    status: source.status,
    approval_required: source.approvalRequired,
    reason: source.reason,
  };
}

function provenanceToResponse(provenance: unknown): Record<string, unknown> {
  const source = objectValue(provenance);
  return {
    available_tiers: source.availableTiers,
    cited_tiers: source.citedTiers,
    cited_sources: source.citedSources,
    cited_evidence_ids: source.citedEvidenceIds,
    missing_context: source.missingContext,
    support: source.historicalOnly ? "historical_only" : source.hasCurrentOrOperationalSupport ? "current_or_operational" : "none",
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function persistApprovalRequest(run: TriageRun, runtime: WebhookRuntime): void {
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

async function persistTriageRun(run: TriageRun, runtime: WebhookRuntime): Promise<void> {
  if (!runtime.runStore) {
    return;
  }
  await runtime.runStore.recordTriageRun(run, {
    correlationId: run.runId,
    retentionClass: runtimeMode(runtime) === "read_only" ? "read_only_triage" : "ephemeral",
  });
}

function runIdForWebhook(incidentId: string, bodyDigest?: string): string | undefined {
  if (!bodyDigest) {
    return undefined;
  }
  return `triage-run:${incidentId}:${bodyDigest.slice(0, 16)}`;
}

function approvalStorePath(runtime: WebhookRuntime): string {
  return runtime.approvalStorePath ?? defaultApprovalStorePath;
}

function approvalRoutesEnabled(runtime: WebhookRuntime): boolean {
  return runtimeMode(runtime) !== "read_only";
}

function approvalSurfaceDisabled(runtime: WebhookRuntime, method: string | undefined, pathname: string): boolean {
  if (approvalRoutesEnabled(runtime)) {
    return false;
  }
  if (method === "GET" && (pathname === "/" || pathname === "/approvals")) {
    return true;
  }
  return pathname === "/api/approvals" || pathname.startsWith("/api/approvals/");
}

function runtimeMode(runtime: WebhookRuntime): OperatorMode {
  return runtime.mode ?? "local";
}

export function runToResponse(run: TriageRun): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: "ok",
    run_id: run.runId,
    run_status: run.runStatus,
    incident: {
      incident_id: run.scenario.incident.incidentId,
      title: run.scenario.incident.title,
      severity: run.scenario.incident.severity,
      service: run.scenario.incident.service,
      status: run.scenario.incident.status,
      started_at: run.scenario.incident.startedAt,
    },
    scenario: run.scenario.name,
    states: run.states,
  };

  if (run.investigation) {
    response.investigation = {
      summary: run.investigation.summary,
      steps: run.investigation.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        purpose: step.purpose,
        evidence_ids: step.evidenceIds,
      })),
    };
  }

  if (run.explanation) {
    if (run.explanation.hypotheses) {
      response.analysis = {
        hypotheses: run.explanation.hypotheses.map((hypothesis) => ({
          label: hypothesis.label,
          status: hypothesis.status,
          supporting_evidence_ids: hypothesis.supportingEvidenceIds,
          contradicting_evidence_ids: hypothesis.contradictingEvidenceIds,
        })),
      };
    }
    if (run.explanation.findingSummary) {
      response.finding_summary = run.explanation.findingSummary;
    }
    if (run.explanation.recommendation) {
      response.recommendation = {
        rationale: run.explanation.recommendation.rationale,
        evidence_ids: run.explanation.recommendation.evidenceIds,
      };
    }
  }

  if (run.explanationValidation) {
    response.explanation_validation = {
      status: run.explanationValidation.status,
      warnings: run.explanationValidation.warnings,
    };
  }

  if (run.validation) {
    response.validation = {
      valid: run.validation.valid,
      errors: run.validation.errors,
    };
    if (run.validation.decision) {
      response.decision = {
        incident_class: run.validation.decision.incidentClass,
        next_action: run.validation.decision.nextAction,
        confidence: run.validation.decision.confidence,
        evidence_ids: run.validation.decision.evidenceIds,
        caveats: run.validation.decision.caveats,
        verification_plan: run.validation.decision.verificationPlan,
      };
    }
  }

  if (run.evidencePackage) {
    const provenance = run.evidencePackage.provenanceSummary(run.validation?.decision?.evidenceIds ?? []);
    response.evidence = run.evidencePackage.evidence.map((item) => ({
      evidence_id: item.evidenceId,
      source: item.source,
      source_tier: item.sourceTier,
      summary: item.summary,
    }));
    response.provenance = {
      available_tiers: provenance.availableTiers,
      cited_tiers: provenance.citedTiers,
      cited_sources: provenance.citedSources,
      cited_evidence_ids: provenance.citedEvidenceIds,
      missing_context: provenance.missingContext,
      support: provenance.historicalOnly ? "historical_only" : provenance.hasCurrentOrOperationalSupport ? "current_or_operational" : "none",
    };
  }

  if (run.safety) {
    response.safety = {
      status: run.safety.status,
      approval_required: run.safety.approvalRequired,
      reason: run.safety.reason,
      staged_payload: run.safety.stagedPayload,
      audit_event: run.safety.auditEvent,
    };
  }

  if (run.mitigationControl) {
    response.mitigation_control = mitigationControlToResponse(run.mitigationControl);
  }

  if (run.scorecard) {
    response.scorecard = {
      scenario_name: run.scorecard.scenarioName,
      scores: run.scorecard.scores,
      notes: run.scorecard.notes,
    };
  }

  return response;
}

export function mitigationControlToResponse(mitigation: MitigationControlResult): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: mitigation.status,
    approval_required: mitigation.approvalRequired,
    reason: mitigation.reason,
    evidence_checks: mitigation.evidenceChecks.map((check) => ({
      source: check.source,
      passed: check.passed,
    })),
  };
  if (mitigation.catalogMatch) {
    response.catalog_match = {
      catalog_id: mitigation.catalogMatch.catalogId,
      runbook_id: mitigation.catalogMatch.runbookId,
      action_intent: mitigation.catalogMatch.actionIntent,
    };
  }
  if (mitigation.dryRun) {
    response.dry_run = {
      status: mitigation.dryRun.status,
      summary: mitigation.dryRun.summary,
      executed: mitigation.dryRun.executed,
    };
  }
  if (mitigation.stagedAction) {
    response.staged_action = {
      incident_id: mitigation.stagedAction.incidentId,
      service: mitigation.stagedAction.service,
      catalog_id: mitigation.stagedAction.catalogId,
      runbook_id: mitigation.stagedAction.runbookId,
      action_intent: mitigation.stagedAction.actionIntent,
      next_action: mitigation.stagedAction.nextAction,
      incident_class: mitigation.stagedAction.incidentClass,
      confidence: mitigation.stagedAction.confidence,
      evidence_ids: mitigation.stagedAction.evidenceIds,
      verification_plan: mitigation.stagedAction.verificationPlan,
      executed: mitigation.stagedAction.executed,
    };
  }
  if (mitigation.approvalRequest) {
    response.approval_request = {
      approval_id: mitigation.approvalRequest.approvalId,
      status: mitigation.approvalRequest.status,
      catalog_id: mitigation.approvalRequest.catalogId,
      runbook_id: mitigation.approvalRequest.runbookId,
      incident_id: mitigation.approvalRequest.incidentId,
      service: mitigation.approvalRequest.service,
      summary: mitigation.approvalRequest.summary,
      approve_command: mitigation.approvalRequest.approveCommand,
      reject_command: mitigation.approvalRequest.rejectCommand,
      executed: mitigation.approvalRequest.executed,
    };
  }
  if (mitigation.auditEvent) {
    response.audit_event = {
      event: mitigation.auditEvent.event,
      incident_id: mitigation.auditEvent.incidentId,
      status: mitigation.auditEvent.status,
      next_action: mitigation.auditEvent.nextAction,
      catalog_id: mitigation.auditEvent.catalogId,
      runbook_id: mitigation.auditEvent.runbookId,
      executed: mitigation.auditEvent.executed,
    };
  }
  if (mitigation.verification) {
    response.verification = {
      status: mitigation.verification.status,
      signals: mitigation.verification.signals,
      reason: mitigation.verification.reason,
    };
  }
  return response;
}
