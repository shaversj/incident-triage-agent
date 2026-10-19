import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import type { Scenario } from "../domain";
import { EvidencePackage, PrebuiltOperationalTools, loadTools, type Evidence } from "../evidence";
import {
  GrafanaPayloadError,
  defaultGrafanaSignatureHeader,
  defaultGrafanaTimestampHeader,
  defaultGrafanaTimestampToleranceMs,
  normalizeGrafanaPayload,
  verifyGrafanaWebhookHmac,
} from "../grafana";
import type { TriageLogger } from "../logger";
import type { EvidenceGateCandidate, IncidentBaseline, TriageRunPersistenceStore } from "../persistence/contracts";
import { RecordedLokiClient } from "../recorded-observability";
import { evaluateEvidenceReentry, type EvidenceReentryResult } from "../reentry";
import { TriageWorkflow, type TriageRun } from "../workflow";
import { persistApprovalRequest } from "./approval";
import type { HandleGrafanaWebhookOptions, WebhookRuntime } from "./contracts";
import { firstHeader, readRequestBody, runtimeMode, writeJson } from "./http";
import { materialityToResponse, runToResponse } from "./response-mapping";

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

const reentryCoordinators = new WeakMap<WebhookRuntime, IncidentReentryCoordinator>();

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
    if (
      normalized.ignoredReason === "resolved_alert"
      && runtimeMode(runtime) === "read_only"
      && runtime.runStore
      && options.bodyDigest
    ) {
      const baseline = await runtime.runStore.getLatestIncidentBaseline(normalized.incident.incidentId);
      if (baseline) {
        const recorded = await runtime.runStore.recordVerificationOutcome({
          incidentId: normalized.incident.incidentId,
          sourceEventKey: `grafana:resolved:${options.bodyDigest}`,
          verification: {
            outcome: "resolved",
            source: "observability",
            sourceReference: `grafana:${normalized.incident.incidentId}`,
            runId: baseline.run.runId,
            evidenceIds: [`grafana:resolved:${normalized.incident.incidentId}`],
            rationale: "Signed Grafana notification reports that the incident alerts resolved.",
          },
        }, { retentionClass: "read_only_triage" });
        return [202, {
          status: "ignored",
          reason: normalized.ignoredReason,
          incident_id: normalized.incident.incidentId,
          closure_recorded: recorded.created,
          lifecycle: await runtime.runStore.getIncidentLifecycle(normalized.incident.incidentId),
        }];
      }
    }
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
  if (reentryGateEnabled(runtime)) {
    return reentryCoordinator(runtime).run(normalized.incident.incidentId, async () =>
      handleEvidenceReentry(package_, scenario, runtime, options.bodyDigest)
    );
  }

  const run = await executeTriage(package_, scenario, runtime, options.bodyDigest);
  await persistTriageRun(run, runtime);
  persistApprovalRequest(run, runtime);
  return [200, runToResponse(run)];
}

export async function routeGrafanaWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  logger: TriageLogger,
): Promise<void> {
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

export async function routeDemoScenarioApi(
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

async function handleEvidenceReentry(
  candidatePackage: EvidencePackage,
  scenario: Scenario,
  runtime: WebhookRuntime,
  bodyDigest?: string,
): Promise<[number, Record<string, unknown>]> {
  const store = runtime.runStore;
  if (!store) {
    throw new Error("Evidence re-entry requires a persistence store.");
  }
  const baseline = await store.getLatestIncidentBaseline(scenario.incident.incidentId);
  const priorDecision = priorDecisionFromBaseline(baseline);
  const evaluation = await evaluateEvidenceReentry({
    candidate: candidatePackage,
    ...(baseline ? { prior: evidencePackageFromBaseline(baseline) } : {}),
    ...(priorDecision ? { priorDecision } : {}),
    ...(runtime.materialityClassifier ? { classifier: runtime.materialityClassifier } : {}),
  });
  const gateCandidate = evidenceGateCandidate(scenario.incident.incidentId, baseline, evaluation);
  const correlationId = runIdForWebhook(scenario.incident.incidentId, bodyDigest);
  const persistOptions = {
    retentionClass: "read_only_triage" as const,
    ...(correlationId ? { correlationId } : {}),
  };

  if (evaluation.decision.outcome === "not_material") {
    const recorded = await store.recordEvidenceGateDecision(gateCandidate, persistOptions);
    return [202, {
      status: "ignored",
      reason: "non_material_evidence",
      incident_id: scenario.incident.incidentId,
      prior_run_id: baseline?.run.runId,
      gate_decision_id: recorded.decision.decisionId,
      materiality: materialityToResponse(evaluation),
    }];
  }

  const run = await executeTriage(candidatePackage, scenario, runtime, bodyDigest);
  const recorded = await store.recordGatedTriageRun(run, gateCandidate, persistOptions);
  if (!recorded.created) {
    return [202, {
      status: "ignored",
      reason: "evidence_already_processed",
      incident_id: scenario.incident.incidentId,
      prior_run_id: recorded.decision.priorRunId,
      child_run_id: recorded.run.runId,
      gate_decision_id: recorded.decision.decisionId,
      materiality: materialityToResponse(evaluation),
    }];
  }
  persistApprovalRequest(run, runtime);
  return [200, {
    ...runToResponse(run),
    trigger: evaluation.decision.outcome === "first_observation" ? "first_observation" : "material_evidence",
    parent_run_id: baseline?.run.runId,
    gate_decision_id: recorded.decision.decisionId,
    materiality: materialityToResponse(evaluation),
  }];
}

async function executeTriage(
  package_: EvidencePackage,
  scenario: Scenario,
  runtime: WebhookRuntime,
  bodyDigest?: string,
): Promise<TriageRun> {
  const workflowOptions = { mode: runtimeMode(runtime) };
  const runId = runIdForWebhook(scenario.incident.incidentId, bodyDigest);
  if (runId) {
    Object.assign(workflowOptions, { runId });
  }
  const workflow = new TriageWorkflow(
    new PrebuiltOperationalTools(package_),
    runtime.llmClient,
    undefined,
    workflowOptions,
  );
  return workflow.run(scenario);
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

async function releaseGrafanaReplay(
  replayKey: string,
  runtime: WebhookRuntime,
  logger: TriageLogger,
): Promise<void> {
  try {
    await runtime.runStore?.releaseReplayKey(replayKey);
  } catch (error) {
    logger.warn(
      { component: "server", error: error instanceof Error ? error.message : String(error) },
      "Failed to release replay key",
    );
  }
}

function hmacErrorCode(error: GrafanaPayloadError): string {
  if (error.message.includes("timestamp")) {
    return "invalid_hmac_timestamp";
  }
  return "invalid_hmac_signature";
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

function reentryGateEnabled(
  runtime: WebhookRuntime,
): runtime is WebhookRuntime & { runStore: TriageRunPersistenceStore } {
  return runtimeMode(runtime) === "read_only" && runtime.runStore !== undefined;
}

function reentryCoordinator(runtime: WebhookRuntime): IncidentReentryCoordinator {
  const existing = reentryCoordinators.get(runtime);
  if (existing) {
    return existing;
  }
  const coordinator = new IncidentReentryCoordinator();
  reentryCoordinators.set(runtime, coordinator);
  return coordinator;
}

class IncidentReentryCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(incidentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(incidentId) ?? Promise.resolve();
    let release: () => void = () => {};
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.tails.set(incidentId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(incidentId) === tail) {
        this.tails.delete(incidentId);
      }
    }
  }
}

function evidencePackageFromBaseline(baseline: IncidentBaseline): EvidencePackage {
  return new EvidencePackage(
    baseline.run.scenarioName,
    {
      incidentId: baseline.run.incidentId,
      title: baseline.run.incidentTitle,
      severity: baseline.run.severity,
      status: baseline.run.incidentStatus,
      startedAt: baseline.run.startedAt,
      service: baseline.run.service,
      symptoms: [],
      alerts: [],
      recentChanges: [],
      logSignals: [],
      runbookRefs: [],
      priorIncidentRefs: [],
      verificationSignals: [],
    },
    baseline.evidenceSnapshot.evidence as Evidence[],
    baseline.evidenceSnapshot.missingContext,
  );
}

function priorDecisionFromBaseline(baseline?: IncidentBaseline) {
  return baseline?.run.reviewEnvelope?.decision;
}

function evidenceGateCandidate(
  incidentId: string,
  baseline: IncidentBaseline | undefined,
  evaluation: EvidenceReentryResult,
): EvidenceGateCandidate {
  return {
    incidentId,
    canonicalizationVersion: evaluation.candidate.version,
    candidateDigest: evaluation.candidate.digest,
    ...(baseline ? { priorRunId: baseline.run.runId } : {}),
    delta: evaluation.delta,
    decision: evaluation.decision,
  };
}

function runIdForWebhook(incidentId: string, bodyDigest?: string): string | undefined {
  if (!bodyDigest) {
    return undefined;
  }
  return `triage-run:${incidentId}:${bodyDigest.slice(0, 16)}`;
}
