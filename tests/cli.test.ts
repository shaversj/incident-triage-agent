import { expect, test } from "vitest";
import { spawn } from "node:child_process";
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
  expect(result.stdout).toContain("deploy:0");
  expect(result.stdout).toContain("[deploy/operational_context]");
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
