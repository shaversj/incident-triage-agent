import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StaticDecisionClient } from "../../src/llm";
import { InMemoryTriageRunPersistenceStore } from "../../src/persistence";
import { RecordedLokiClient } from "../../src/recorded-observability";
import { startWebhookServer, type RunningWebhookServer, type WebhookRuntime } from "../../src/server";

test("approves a staged mitigation from the run review console", async ({ page }) => {
  const harness = await startApprovalHarness();
  try {
    await postBadDeployWebhook(harness.baseUrl);
    const gate = await openApprovalGate(page, harness.baseUrl);

    await expect(gate.getByText("pending_human_approval")).toBeVisible();
    await gate.getByRole("button", { name: "Approve" }).click();

    await expect(gate.getByText("human_approved")).toBeVisible();
    await expect(gate.getByText("simulated_not_executed")).toBeVisible();
    await expect(page.getByText("Approval decision recorded.")).toBeVisible();
  } finally {
    await harness.server.close();
  }
});

test("rejects a staged mitigation from the run review console", async ({ page }) => {
  const harness = await startApprovalHarness();
  try {
    await postBadDeployWebhook(harness.baseUrl);
    const gate = await openApprovalGate(page, harness.baseUrl);

    await expect(gate.getByText("pending_human_approval")).toBeVisible();
    await gate.getByRole("button", { name: "Reject" }).click();

    await expect(gate.getByText("human_rejected")).toBeVisible();
    await expect(gate.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(gate.getByRole("button", { name: "Reject" })).toBeDisabled();
  } finally {
    await harness.server.close();
  }
});

test("shows an operator-visible error when an approval decision fails", async ({ page }) => {
  const harness = await startApprovalHarness();
  try {
    await postBadDeployWebhook(harness.baseUrl);
    const gate = await openApprovalGate(page, harness.baseUrl);
    await page.route("**/api/approvals/**/approve", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "approval_store_unavailable" }),
      });
    });

    await gate.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByText("Approval decision failed: approval_store_unavailable")).toBeVisible();
    await expect(gate.getByText("pending_human_approval")).toBeVisible();
    await expect(gate.getByRole("button", { name: "Approve" })).toBeEnabled();
    await expect(gate.getByRole("button", { name: "Reject" })).toBeEnabled();
  } finally {
    await harness.server.close();
  }
});

async function openApprovalGate(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/runs`);
  await expect(page.getByRole("heading", { name: "Operator Run Review" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Checkout API latency regression/ })).toBeVisible();

  const gate = page.locator(".panel").filter({ hasText: "Approval Gate" });
  await expect(gate).toBeVisible();
  return gate;
}

async function startApprovalHarness(): Promise<{ server: RunningWebhookServer; baseUrl: string }> {
  const runtime: WebhookRuntime = {
    fixturesDir: "fixtures",
    webhookSecret: "test-secret",
    llmClient: badDeployLlm(),
    lokiClient: RecordedLokiClient.fromFixture("bad-deploy-latency"),
    lokiLimit: 20,
    mode: "local",
    runStore: new InMemoryTriageRunPersistenceStore(),
    approvalStorePath: join(mkdtempSync(join(tmpdir(), "incident-triage-e2e-")), "approvals.json"),
  };
  const server = startWebhookServer({
    host: "127.0.0.1",
    port: 0,
    runtime,
  });
  await server.ready;
  return { server, baseUrl: serverUrl(server) };
}

async function postBadDeployWebhook(baseUrl: string): Promise<void> {
  const rawBody = readFileSync("fixtures/grafana/bad-deploy-latency-webhook.json", "utf8");
  const response = await fetch(`${baseUrl}/webhooks/grafana`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": "test-secret",
    },
    body: rawBody,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ok",
    scenario: "grafana-bad-deploy-latency",
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

function serverUrl(running: RunningWebhookServer): string {
  const address = running.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}
