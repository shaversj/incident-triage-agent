import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

test("CLI list prints scenarios without credentials", async () => {
  const result = await runCli(["list"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("checkout-payment-timeout");
  expect(result.stdout).toContain("bad-deploy-latency");
});

test("CLI mock run renders decision provenance safety and scorecard", async () => {
  const result = await runCli(["run", "checkout-payment-timeout", "--mock-llm"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Status: completed");
  expect(result.stdout).toContain("Investigation");
  expect(result.stdout).toContain("Finding");
  expect(result.stdout).toContain("LLM decision");
  expect(result.stdout).toContain("Provenance");
  expect(result.stdout).toContain("Safety gate");
  expect(result.stdout).toContain("Mitigation Control Plane");
  expect(result.stdout).toContain("Scorecard");
  expect(result.stdout).toContain("current_or_operational");
  expect(result.stdout).not.toContain("MINIMAX_API_KEY");
});

test("CLI trace includes workflow states and evidence", async () => {
  const result = await runCli(["run", "bad-deploy-latency", "--mock-llm", "--trace"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("State trace");
  expect(result.stdout).toContain("Investigation steps");
  expect(result.stdout).toContain("simulated_action_recorded");
  expect(result.stdout).toContain("verification_failed");
  expect(result.stdout).toContain("deploy:0");
  expect(result.stdout).toContain("[deploy/operational_context]");
  expect(result.stdout).toContain("approval_request");
  expect(result.stdout).toContain("npm run triage:approval -- approve rollback-approval");
});

test("approval CLI records simulated human approval without execution", async () => {
  const storePath = tempStorePath();
  const result = await runApprovalCli([
    "approve",
    "rollback-approval",
    "--incident-id",
    "INC-2026-015",
    "--service",
    "checkout-api",
    "--store-path",
    storePath,
    "--json",
  ]);
  const record = JSON.parse(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(record).toMatchObject({
    approval_id: "approval:INC-2026-015:rollback-approval",
    status: "human_approved",
    runbook_id: "bad-deploy",
    executed: false,
  });
  expect(record.execution).toMatchObject({
    status: "simulated_not_executed",
    dry_run: true,
    executed: false,
  });
});

test("approval CLI persists request and supports status and list", async () => {
  const storePath = tempStorePath();
  const request = await runApprovalCli([
    "request",
    "capacity-runbook-approval",
    "--incident-id",
    "INC-2026-020",
    "--service",
    "search-api",
    "--store-path",
    storePath,
    "--json",
  ]);
  const requestRecord = JSON.parse(request.stdout);
  const status = await runApprovalCli([
    "status",
    "approval:INC-2026-020:capacity-runbook-approval",
    "--store-path",
    storePath,
    "--json",
  ]);
  const list = await runApprovalCli(["list", "--store-path", storePath, "--json"]);

  expect(request.exitCode).toBe(0);
  expect(requestRecord.status).toBe("pending_human_approval");
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(status.stdout).runbook_id).toBe("capacity-saturation");
  expect(JSON.parse(list.stdout).approvals).toHaveLength(1);
});

test("approval CLI request does not downgrade a decided approval", async () => {
  const storePath = tempStorePath();
  await runApprovalCli([
    "approve",
    "rollback-approval",
    "--incident-id",
    "INC-2026-030",
    "--service",
    "checkout-api",
    "--store-path",
    storePath,
  ]);
  const requestAgain = await runApprovalCli([
    "request",
    "rollback-approval",
    "--incident-id",
    "INC-2026-030",
    "--service",
    "checkout-api",
    "--store-path",
    storePath,
    "--json",
  ]);

  expect(JSON.parse(requestAgain.stdout).status).toBe("human_approved");
});

test("CLI run requires credentials without mock LLM", async () => {
  const result = await runCli([
    "run",
    "checkout-payment-timeout",
    "--fixtures-dir",
    `${process.cwd()}/fixtures`,
  ], { cwd: "/tmp", withoutMiniMaxEnv: true });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("MINIMAX_API_KEY");
});

test("CLI serve requires explicit operator mode with real integration config", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "incident-triage-serve-"));
  writeFileSync(join(cwd, ".env"), "GRAFANA_WEBHOOK_SECRET=webhook-secret\nLOKI_BASE_URL=http://loki:3100\n");

  const result = await runCli([
    "serve",
    "--mock-llm",
    "--fixtures-dir",
    `${process.cwd()}/fixtures`,
  ], { cwd });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("AI_OPERATOR_MODE");
  expect(result.stderr).not.toContain("webhook-secret");
});

async function runCli(args: string[], options: { cwd?: string; withoutMiniMaxEnv?: boolean } = {}) {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.FORCE_COLOR = "0";
  if (options.withoutMiniMaxEnv) {
    delete env.MINIMAX_API_KEY;
    delete env.MODEL_NAME;
    delete env.MINIMAX_BASE_URL;
  }
  const proc = spawn("npx", ["tsx", `${process.cwd()}/src/cli.ts`, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    new Promise<number | null>((resolve) => proc.on("exit", resolve)),
  ]);
  return { stdout, stderr, exitCode };
}

async function runApprovalCli(args: string[]) {
  const proc = spawn("npx", ["tsx", `${process.cwd()}/src/approval-cli.ts`, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    new Promise<number | null>((resolve) => proc.on("exit", resolve)),
  ]);
  return { stdout, stderr, exitCode };
}

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "incident-triage-approval-")), "approvals.json");
}
