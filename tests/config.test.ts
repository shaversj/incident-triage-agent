import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ConfigError, loadConfig, loadDotenv, loadWebhookConfig, redactSecret } from "../src/config";

test("loadConfig reads required MiniMax values", () => {
  const envFile = writeTempEnv("MINIMAX_API_KEY=secret-key\nMODEL_NAME=MiniMax-M2.7\n");

  const config = loadConfig(envFile, {});

  expect(config.minimaxApiKey).toBe("secret-key");
  expect(config.modelName).toBe("MiniMax-M2.7");
  expect(config.minimaxBaseUrl).toBe("https://api.minimax.io");
  expect(config.redacted.MINIMAX_API_KEY).toBe("<redacted>");
});

test("loadConfig reports missing names without secret values", () => {
  const envFile = writeTempEnv("MINIMAX_API_KEY=secret-key\n");

  expect(() => loadConfig(envFile, {})).toThrow(ConfigError);
  expect(() => loadConfig(envFile, {})).toThrow("MODEL_NAME");
  try {
    loadConfig(envFile, {});
  } catch (error) {
    expect(String(error)).not.toContain("secret-key");
  }
});

test("loadDotenv rejects malformed lines", () => {
  const envFile = writeTempEnv("MINIMAX_API_KEY\n");

  expect(() => loadDotenv(envFile)).toThrow("Invalid .env line 1");
});

test("redactSecret replaces configured API key", () => {
  const config = loadConfig(writeTempEnv("MINIMAX_API_KEY=secret-key\nMODEL_NAME=MiniMax-M2.7\n"), {});

  expect(redactSecret("failed with secret-key", config)).toBe("failed with <redacted>");
});

test("loadWebhookConfig reads secret and Loki values", () => {
  const envFile = writeTempEnv(
    "GRAFANA_WEBHOOK_SECRET=webhook-secret\nLOKI_BASE_URL=http://loki:3100\nLOKI_LIMIT=7\n",
  );

  const config = loadWebhookConfig(envFile, {});

  expect(config.grafanaWebhookSecret).toBe("webhook-secret");
  expect(config.lokiBaseUrl).toBe("http://loki:3100");
  expect(config.lokiLimit).toBe(7);
  expect(config.redacted.GRAFANA_WEBHOOK_SECRET).toBe("<redacted>");
});

test("loadWebhookConfig requires secret without printing values", () => {
  const envFile = writeTempEnv("LOKI_BASE_URL=http://loki:3100\n");

  try {
    loadWebhookConfig(envFile, {});
  } catch (error) {
    expect(String(error)).toContain("GRAFANA_WEBHOOK_SECRET");
    expect(String(error)).not.toContain("http://loki:3100");
  }
});

function writeTempEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "incident-triage-config-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, contents);
  return envFile;
}
