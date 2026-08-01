import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApprovalId, getApproval, requestApproval } from "../src/approval-store";
import { StaticDecisionClient } from "../src/llm";
import { loadMitigationCatalog } from "../src/mitigation-control";
import { InMemoryTriageRunPersistenceStore, type TriageRunPersistenceStore } from "../src/persistence";
import { RecordedLokiClient } from "../src/recorded-observability";
import { handleGrafanaWebhook, startWebhookServer, type WebhookRuntime } from "../src/server";
import { signGrafanaWebhookBody } from "../src/grafana";

test("webhook rejects invalid secret", async () => {
  const [status, response] = await handleGrafanaWebhook(payload(), "wrong-secret", runtime());

  expect(status).toBe(401);
  expect(response.error).toBe("unauthorized");
});

test("valid webhook returns triage JSON with Loki evidence", async () => {
  const loki = RecordedLokiClient.fromFixture("checkout-payment-timeout");

  const [status, response] = await handleGrafanaWebhook(payload(), "test-secret", runtime(loki));

  expect(status).toBe(200);
  expect(response.status).toBe("ok");
  expect(response.run_status).toBe("completed");
  expect((response.incident as any).service).toBe("checkout-api");
  expect((response.investigation as any).summary).toContain("investigation step");
  expect((response.investigation as any).steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "inspect_logs", status: "found" }),
  ]));
  expect((response.decision as any).incident_class).toBe("dependency_outage");
  expect((response.decision as any).evidence_ids).toContain("log:0");
  expect((response.explanation_validation as any).status).toBe("not_available");
  expect((response.safety as any).status).toBe("safe_recommendation");
  expect((response.provenance as any).available_tiers).toContain("current_signal");
  expect((response.provenance as any).available_tiers).toContain("operational_context");
  expect(loki.lastQuery?.labels).toEqual({ service: "checkout-api" });
  expect(loki.lastQuery?.direction).toBe("forward");
});

test("invalid LLM response is recoverable without safety action", async () => {
  const [status, response] = await handleGrafanaWebhook(
    payload(),
    "test-secret",
    runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      new StaticDecisionClient({ "grafana-checkout-api": "{not json" }),
    ),
  );

  expect(status).toBe(200);
  expect(response.run_status).toBe("recoverable_failure");
  expect((response.validation as any).valid).toBe(false);
  expect(response).not.toHaveProperty("decision");
  expect(response).not.toHaveProperty("safety");
});

test("bad deploy webhook exposes pending human approval request without execution", async () => {
  const [status, response] = await handleGrafanaWebhook(
    JSON.parse(readFileSync("fixtures/grafana/bad-deploy-latency-webhook.json", "utf8")),
    "test-secret",
    runtime(
      RecordedLokiClient.fromFixture("bad-deploy-latency"),
      new StaticDecisionClient({
        "grafana-bad-deploy-latency": JSON.stringify({
          incident_class: "bad_deploy",
          next_action: "request_rollback_approval",
          confidence: 0.88,
          evidence_ids: ["deploy:0", "runbook:bad-deploy", "verification:0"],
          caveats: [],
          verification_plan: ["Check latency after rollback."],
        }),
      }),
    ),
  );

  const mitigation = response.mitigation_control as any;

  expect(status).toBe(200);
  expect(mitigation.status).toBe("approval_required");
  expect(mitigation.catalog_match.runbook_id).toBe("bad-deploy");
  expect(mitigation.staged_action.executed).toBe(false);
  expect(mitigation.approval_request).toMatchObject({
    approval_id: "approval:GRAFANA-checkout-bad-deploy-latency-001:rollback-approval",
    status: "pending_human_approval",
    runbook_id: "bad-deploy",
    executed: false,
  });
});

test("bad deploy webhook persists pending approval when approval store is configured", async () => {
  const storePath = tempStorePath();
  const [status] = await handleGrafanaWebhook(
    JSON.parse(readFileSync("fixtures/grafana/bad-deploy-latency-webhook.json", "utf8")),
    "test-secret",
    runtime(
      RecordedLokiClient.fromFixture("bad-deploy-latency"),
      badDeployLlm(),
      storePath,
    ),
  );

  const approval = getApproval(storePath, "approval:GRAFANA-checkout-bad-deploy-latency-001:rollback-approval");

  expect(status).toBe(200);
  expect(approval).toMatchObject({
    status: "pending_human_approval",
    catalogId: "rollback-approval",
    runbookId: "bad-deploy",
    executed: false,
  });
});

test("read-only webhook does not expose or persist approval side effects", async () => {
  const storePath = tempStorePath();
  const [status, response] = await handleGrafanaWebhook(
    JSON.parse(readFileSync("fixtures/grafana/bad-deploy-latency-webhook.json", "utf8")),
    "test-secret",
    runtime(
      RecordedLokiClient.fromFixture("bad-deploy-latency"),
      badDeployLlm(),
      storePath,
      "read_only",
    ),
  );

  const mitigation = response.mitigation_control as any;

  expect(status).toBe(200);
  expect((response.safety as any).status).toBe("approval_required");
  expect((response.safety as any).staged_payload).toBeUndefined();
  expect(mitigation.status).toBe("approval_required");
  expect(mitigation.staged_action).toBeUndefined();
  expect(mitigation.approval_request).toBeUndefined();
  expect(getApproval(storePath, buildApprovalId("GRAFANA-checkout-bad-deploy-latency-001", "rollback-approval"))).toBeUndefined();
});

test("read-only webhook records run persistence when configured", async () => {
  const runStore = new InMemoryTriageRunPersistenceStore();
  const [status] = await handleGrafanaWebhook(
    JSON.parse(readFileSync("fixtures/grafana/bad-deploy-latency-webhook.json", "utf8")),
    "test-secret",
    runtime(
      RecordedLokiClient.fromFixture("bad-deploy-latency"),
      badDeployLlm(),
      undefined,
      "read_only",
      runStore,
    ),
  );

  const run = runStore.runs.get("triage-run:grafana-bad-deploy-latency");

  expect(status).toBe(200);
  expect(run).toMatchObject({
    incidentId: "GRAFANA-checkout-bad-deploy-latency-001",
    service: "checkout-api",
    validationStatus: "valid",
    safetyStatus: "approval_required",
    mitigationStatus: "approval_required",
    retentionClass: "read_only_triage",
  });
  expect(runStore.evidenceSnapshots.has("triage-run:grafana-bad-deploy-latency")).toBe(true);
});

test("approval console serves queue and approve API records simulated execution", async () => {
  const storePath = tempStorePath();
  const entry = requiredCatalogEntry("rollback-approval");
  requestApproval(storePath, entry, {
    incidentId: "INC-2026-015",
    service: "checkout-api",
    now: new Date("2026-07-29T18:00:00.000Z"),
  });
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(undefined, defaultLlm(), storePath),
  });

  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const html = await fetchText(`${baseUrl}/approvals`);
    const list = await fetchJson(`${baseUrl}/api/approvals`);
    const approvalId = encodeURIComponent("approval:INC-2026-015:rollback-approval");
    const approved = await fetchJson(`${baseUrl}/api/approvals/${approvalId}/approve`, { method: "POST" });

    expect(html).toContain("Incident Approval Console");
    expect((list.approvals as any[])).toHaveLength(1);
    expect((approved.approval as any).status).toBe("human_approved");
    expect((approved.approval as any).execution).toMatchObject({
      status: "simulated_not_executed",
      executed: false,
      dry_run: true,
    });
  } finally {
    await server.close();
  }
});

test("server accepts signed read-only Grafana webhook and rejects replay", async () => {
  const runStore = new InMemoryTriageRunPersistenceStore();
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      defaultLlm(),
      undefined,
      "read_only",
      runStore,
    ),
  });
  const rawBody = readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8");
  const timestamp = unixTimestamp(new Date());

  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const first = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, timestamp),
      body: rawBody,
    });
    const replay = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, timestamp),
      body: rawBody,
    });

    expect(first.status).toBe(200);
    expect((await first.json() as any).status).toBe("ok");
    expect(replay.status).toBe(409);
    expect((await replay.json() as any).error).toBe("replayed_webhook");
    expect([...runStore.runs.keys()].some((runId) => runId.startsWith("triage-run:GRAFANA-checkout-latency-001:"))).toBe(true);
  } finally {
    await server.close();
  }
});

test("server rejects replay when signature hex casing changes", async () => {
  const runStore = new InMemoryTriageRunPersistenceStore();
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      defaultLlm(),
      undefined,
      "read_only",
      runStore,
    ),
  });
  const rawBody = readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8");
  const timestamp = unixTimestamp(new Date());
  const headers = signedGrafanaHeaders(rawBody, timestamp) as Record<string, string>;

  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const first = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    const replay = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: {
        ...headers,
        "X-Grafana-Alerting-Signature": headers["X-Grafana-Alerting-Signature"]?.toUpperCase() ?? "",
      },
      body: rawBody,
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
  } finally {
    await server.close();
  }
});

test("server persists distinct same-service webhooks as separate runs", async () => {
  const runStore = new InMemoryTriageRunPersistenceStore();
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      defaultLlm(),
      undefined,
      "read_only",
      runStore,
    ),
  });
  const firstBody = readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8");
  const secondPayload = payload();
  secondPayload.alerts[0].fingerprint = "checkout-latency-002";
  const secondBody = JSON.stringify(secondPayload);

  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const first = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(firstBody, unixTimestamp(new Date())),
      body: firstBody,
    });
    const second = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(secondBody, unixTimestamp(new Date())),
      body: secondBody,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(runStore.runs.size).toBe(2);
    expect(runStore.evidenceSnapshots.size).toBe(2);
  } finally {
    await server.close();
  }
});

test("server releases replay claim after persistence failure", async () => {
  const runStore = new FailingOnceRunStore();
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      defaultLlm(),
      undefined,
      "read_only",
      runStore,
    ),
  });
  const rawBody = readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8");
  const timestamp = unixTimestamp(new Date());

  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const first = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, timestamp),
      body: rawBody,
    });
    const retry = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, timestamp),
      body: rawBody,
    });

    expect(first.status).toBe(500);
    expect(retry.status).toBe(200);
    expect(runStore.runs.size).toBe(1);
  } finally {
    await server.close();
  }
});

test("server rejects invalid or stale signed read-only Grafana webhook before persistence", async () => {
  const runStore = new InMemoryTriageRunPersistenceStore();
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      defaultLlm(),
      undefined,
      "read_only",
      runStore,
    ),
  });
  const rawBody = readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8");
  const staleTimestamp = unixTimestamp(new Date(Date.now() - 60 * 60 * 1000));

  await server.ready;
  try {
    const baseUrl = serverUrl(server.server);
    const invalid = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grafana-Alerting-Signature": "bad",
        "X-Grafana-Alerting-Timestamp": unixTimestamp(new Date()),
      },
      body: rawBody,
    });
    const stale = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, staleTimestamp),
      body: rawBody,
    });
    const missingTimestamp = await fetch(`${baseUrl}/webhooks/grafana`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grafana-Alerting-Signature": signGrafanaWebhookBody(rawBody, "test-secret"),
      },
      body: rawBody,
    });

    expect(invalid.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(missingTimestamp.status).toBe(401);
    expect((await missingTimestamp.json() as any).error).toBe("missing_hmac_timestamp");
    expect(runStore.runs.size).toBe(0);
  } finally {
    await server.close();
  }
});

test("read-only webhook fails closed without replay store", async () => {
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime: runtime(
      RecordedLokiClient.fromFixture("checkout-payment-timeout"),
      defaultLlm(),
      undefined,
      "read_only",
    ),
  });
  const rawBody = readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8");

  await server.ready;
  try {
    const response = await fetch(`${serverUrl(server.server)}/webhooks/grafana`, {
      method: "POST",
      headers: signedGrafanaHeaders(rawBody, unixTimestamp(new Date())),
      body: rawBody,
    });

    expect(response.status).toBe(503);
    expect((await response.json() as any).error).toBe("replay_store_unavailable");
  } finally {
    await server.close();
  }
});

test("resolved webhook is ignored", async () => {
  const body = payload();
  body.status = "resolved";
  for (const alert of body.alerts) {
    alert.status = "resolved";
  }

  const [status, response] = await handleGrafanaWebhook(body, "test-secret", runtime());

  expect(status).toBe(202);
  expect(response.status).toBe("ignored");
  expect(response.reason).toBe("resolved_alert");
});

function runtime(
  lokiClient?: RecordedLokiClient,
  llmClient = defaultLlm(),
  approvalStorePath?: string,
  mode?: WebhookRuntime["mode"],
  runStore?: TriageRunPersistenceStore,
): WebhookRuntime {
  const runtime: WebhookRuntime = {
    fixturesDir: "fixtures",
    webhookSecret: "test-secret",
    llmClient,
    lokiLimit: 20,
  };
  if (mode) {
    runtime.mode = mode;
  }
  if (runStore) {
    runtime.runStore = runStore;
  }
  if (lokiClient) {
    runtime.lokiClient = lokiClient;
  }
  if (approvalStorePath) {
    runtime.approvalStorePath = approvalStorePath;
  }
  return runtime;
}

class FailingOnceRunStore extends InMemoryTriageRunPersistenceStore {
  private shouldFail = true;

  override async recordTriageRun(...args: Parameters<InMemoryTriageRunPersistenceStore["recordTriageRun"]>) {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated persistence failure");
    }
    return super.recordTriageRun(...args);
  }
}

function defaultLlm() {
  return new StaticDecisionClient({
    "grafana-checkout-api": JSON.stringify({
      incident_class: "dependency_outage",
      next_action: "escalate_owner",
      confidence: 0.87,
      evidence_ids: ["alert:0", "log:0", "runbook:dependency-outage"],
      caveats: ["Synthetic integration path."],
      verification_plan: ["Watch payment timeout rate."],
    }),
  });
}

function badDeployLlm() {
  return new StaticDecisionClient({
    "grafana-bad-deploy-latency": JSON.stringify({
      incident_class: "bad_deploy",
      next_action: "request_rollback_approval",
      confidence: 0.88,
      evidence_ids: ["deploy:0", "runbook:bad-deploy", "verification:0"],
      caveats: [],
      verification_plan: ["Check latency after rollback."],
    }),
  });
}

function payload(): any {
  return JSON.parse(readFileSync("fixtures/grafana/checkout-payment-timeout-webhook.json", "utf8"));
}

function requiredCatalogEntry(catalogId: string) {
  const entry = loadMitigationCatalog("fixtures").find((item) => item.catalogId === catalogId);
  if (!entry) {
    throw new Error(`missing catalog entry: ${catalogId}`);
  }
  return entry;
}

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "incident-triage-server-")), "approvals.json");
}

function serverUrl(server: Awaited<ReturnType<typeof startWebhookServer>>["server"]): string {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  return await response.json() as Record<string, unknown>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  return await response.text();
}

function signedGrafanaHeaders(rawBody: string, timestamp: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Grafana-Alerting-Signature": signGrafanaWebhookBody(rawBody, "test-secret", timestamp),
    "X-Grafana-Alerting-Timestamp": timestamp,
  };
}

function unixTimestamp(date: Date): string {
  return `${Math.floor(date.getTime() / 1000)}`;
}
