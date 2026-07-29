import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  approvalRecordToJson,
  defaultApprovalStorePath,
  decideApproval,
  getApproval,
  listApprovals,
  requestApproval,
} from "./approval-store";
import { type Scenario } from "./domain";
import { PrebuiltOperationalTools, loadTools, type Evidence } from "./evidence";
import { GrafanaPayloadError, normalizeGrafanaPayload } from "./grafana";
import type { LLMDecisionClient } from "./llm";
import { noopLogger, type TriageLogger } from "./logger";
import { loadMitigationCatalog, type MitigationControlResult } from "./mitigation-control";
import { simulateApprovedMitigation } from "./mitigation-executor";
import { TriageWorkflow, type TriageRun } from "./workflow";

export interface WebhookRuntime {
  fixturesDir: string;
  webhookSecret: string;
  llmClient: LLMDecisionClient;
  lokiClient?: LokiClientLike;
  lokiLimit: number;
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

export async function handleGrafanaWebhook(
  payload: unknown,
  providedSecret: string | undefined,
  runtime: WebhookRuntime,
): Promise<[number, Record<string, unknown>]> {
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
  const workflow = new TriageWorkflow(new PrebuiltOperationalTools(package_), runtime.llmClient);
  const run = await workflow.run(scenario);
  persistApprovalRequest(run, runtime);
  return [200, runToResponse(run)];
}

export function startWebhookServer(options: WebhookServerOptions): RunningWebhookServer {
  const logger = options.logger ?? noopLogger;
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
      await closeServer(server);
    },
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
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/approvals")) {
    writeHtml(response, 200, approvalConsoleHtml());
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

  if (request.method !== "POST" || request.url !== "/webhooks/grafana") {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch {
    writeJson(response, 400, { status: "error", error: "invalid_json" });
    return;
  }

  const secret = request.headers["x-webhook-secret"];
  const providedSecret = Array.isArray(secret) ? secret[0] : secret;
  logger.info({ component: "server" }, "Grafana webhook received");
  const [status, body] = await handleGrafanaWebhook(payload, providedSecret, runtime);
  writeJson(response, status, body);
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
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
  if (!approvalRequest || !runtime.approvalStorePath) {
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

function approvalConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Incident Approval Console</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #647086;
      --line: #d9dee8;
      --teal: #0f766e;
      --amber: #b45309;
      --red: #b42318;
      --green: #15803d;
      --blue: #1d4ed8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: #101828;
      color: #f8fafc;
    }
    .topbar {
      max-width: 1180px;
      margin: 0 auto;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 720;
      letter-spacing: 0;
    }
    .banner {
      border: 1px solid #f7d394;
      background: #fff7ed;
      color: #7c2d12;
      padding: 9px 12px;
      border-radius: 6px;
      font-weight: 650;
      white-space: nowrap;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 22px 24px 36px;
      display: grid;
      grid-template-columns: minmax(320px, 0.95fr) minmax(360px, 1.25fr);
      gap: 18px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-width: 0;
    }
    .section-head {
      min-height: 58px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0;
    }
    .count {
      color: var(--muted);
      font-size: 13px;
    }
    .queue {
      display: grid;
      gap: 0;
    }
    .row {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      padding: 14px 16px;
      text-align: left;
      cursor: pointer;
      display: grid;
      gap: 8px;
      color: inherit;
      font: inherit;
    }
    .row:hover, .row.active { background: #eef6ff; }
    .row:last-child { border-bottom: 0; }
    .row-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      font-weight: 700;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .status {
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 750;
      white-space: nowrap;
    }
    .pending_human_approval { background: #fff7ed; color: var(--amber); }
    .human_approved { background: #ecfdf3; color: var(--green); }
    .human_rejected { background: #fef3f2; color: var(--red); }
    .detail {
      padding: 16px;
      display: grid;
      gap: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .field {
      border-bottom: 1px solid var(--line);
      padding-bottom: 10px;
      min-width: 0;
    }
    .label {
      color: var(--muted);
      display: block;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .value {
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button.action {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 10px 12px;
      color: #ffffff;
      font-weight: 750;
      cursor: pointer;
    }
    button.action:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .approve { background: var(--teal); }
    .reject { background: var(--red); }
    .refresh { background: var(--blue); }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      background: #111827;
      color: #d1fae5;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.45;
    }
    .empty {
      padding: 28px 16px;
      color: var(--muted);
    }
    @media (max-width: 820px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .banner { white-space: normal; }
      main { grid-template-columns: 1fr; padding: 16px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <h1>Incident Approval Console</h1>
      <div class="banner">Simulation only: approvals never execute production actions</div>
    </div>
  </header>
  <main>
    <section>
      <div class="section-head">
        <h2>Approval Queue</h2>
        <button class="action refresh" type="button" id="refresh">Refresh</button>
      </div>
      <div id="queue" class="queue"><div class="empty">Loading approvals...</div></div>
    </section>
    <section>
      <div class="section-head">
        <h2>Approval Detail</h2>
        <span class="count" id="summary"></span>
      </div>
      <div id="detail" class="detail"><div class="empty">Select an approval to review.</div></div>
    </section>
  </main>
  <script>
    let approvals = [];
    let selectedId = "";

    const queue = document.getElementById("queue");
    const detail = document.getElementById("detail");
    const summary = document.getElementById("summary");
    document.getElementById("refresh").addEventListener("click", loadApprovals);

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    async function loadApprovals() {
      const response = await fetch("/api/approvals");
      const data = await response.json();
      approvals = data.approvals ?? [];
      summary.textContent = data.summary ? data.summary.pending + " pending / " + data.summary.total + " total" : "";
      if (!selectedId && approvals.length > 0) {
        selectedId = approvals[0].approval_id;
      }
      renderQueue();
      renderDetail();
    }

    function renderQueue() {
      if (approvals.length === 0) {
        queue.innerHTML = '<div class="empty">No approval records yet.</div>';
        return;
      }
      queue.innerHTML = approvals.map((approval) => {
        const active = approval.approval_id === selectedId ? " active" : "";
        return '<button class="row' + active + '" type="button" data-id="' + escapeHtml(approval.approval_id) + '">' +
          '<div class="row-title"><span>' + escapeHtml(approval.service) + '</span><span class="status ' + escapeHtml(approval.status) + '">' + escapeHtml(approval.status) + '</span></div>' +
          '<div class="meta">' + escapeHtml(approval.incident_id) + ' / ' + escapeHtml(approval.runbook_id) + '</div>' +
          '<div class="meta">' + escapeHtml(approval.action_intent) + '</div>' +
        '</button>';
      }).join("");
      for (const row of queue.querySelectorAll(".row")) {
        row.addEventListener("click", () => {
          selectedId = row.getAttribute("data-id") ?? "";
          renderQueue();
          renderDetail();
        });
      }
    }

    function renderDetail() {
      const approval = approvals.find((item) => item.approval_id === selectedId);
      if (!approval) {
        detail.innerHTML = '<div class="empty">Select an approval to review.</div>';
        return;
      }
      const disabled = approval.status !== "pending_human_approval" ? " disabled" : "";
      detail.innerHTML =
        '<div class="grid">' +
          field("Approval ID", approval.approval_id) +
          field("Status", approval.status) +
          field("Incident", approval.incident_id) +
          field("Service", approval.service) +
          field("Catalog", approval.catalog_id) +
          field("Runbook", approval.runbook_id) +
          field("Requested", approval.requested_at) +
          field("Executed", String(approval.executed)) +
        '</div>' +
        '<div class="field"><span class="label">Action Intent</span><div class="value">' + escapeHtml(approval.action_intent) + '</div></div>' +
        '<div class="actions">' +
          '<button class="action approve" type="button" id="approve"' + disabled + '>Approve</button>' +
          '<button class="action reject" type="button" id="reject"' + disabled + '>Reject</button>' +
        '</div>' +
        '<pre>' + escapeHtml(JSON.stringify(approval, null, 2)) + '</pre>';
      document.getElementById("approve").addEventListener("click", () => decide("approve"));
      document.getElementById("reject").addEventListener("click", () => decide("reject"));
    }

    function field(label, value) {
      return '<div class="field"><span class="label">' + escapeHtml(label) + '</span><div class="value">' + escapeHtml(value) + '</div></div>';
    }

    async function decide(decision) {
      await fetch("/api/approvals/" + encodeURIComponent(selectedId) + "/" + decision, { method: "POST" });
      await loadApprovals();
    }

    loadApprovals().catch((error) => {
      queue.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
  </script>
</body>
</html>`;
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
