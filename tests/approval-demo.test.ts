import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("approval demo seeds bad-deploy approval with recorded observability", () => {
  const storePath = tempStorePath();
  const result = spawnSync("npx", [
    "tsx",
    "scripts/run-approval-demo.ts",
    "--once",
    "--json",
    "--approval-store-path",
    storePath,
    "--port",
    "0",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const body = JSON.parse(result.stdout);

  expect(result.status).toBe(0);
  expect(body).toMatchObject({
    scenario: "bad-deploy-latency",
    mode: "mock",
    status_code: 200,
    approval_id: "approval:GRAFANA-checkout-bad-deploy-latency-001:rollback-approval",
    approval_status: "pending_human_approval",
  });
});

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "incident-triage-approval-demo-")), "approvals.json");
}
