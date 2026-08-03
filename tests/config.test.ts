import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ConfigError,
  loadConfig,
  loadDotenv,
  loadOperatorMode,
  loadPersistenceConfig,
  loadWebhookConfig,
  redactSecret,
} from "../src/config";

test("loadConfig reads required MiniMax values", () => {
  const envFile = writeTempEnv("MINIMAX_API_KEY=secret-key\nMODEL_NAME=MiniMax-M2.7\n");

  const config = loadConfig(envFile, {});

  expect(config.minimaxApiKey).toBe("secret-key");
  expect(config.modelName).toBe("MiniMax-M2.7");
  expect(config.minimaxBaseUrl).toBe("https://api.minimax.io");
  expect(config.redacted.MINIMAX_API_KEY).toBe("<redacted>");
});

test("process environment overrides dotenv values", () => {
  const envFile = writeTempEnv([
    "MINIMAX_API_KEY=dotenv-key",
    "MODEL_NAME=DotenvModel",
    "AI_OPERATOR_MODE=local",
    "DATABASE_URL=postgres://dotenv",
  ].join("\n"));

  const appConfig = loadConfig(envFile, {
    MINIMAX_API_KEY: "process-key",
    MODEL_NAME: "ProcessModel",
  });
  const operatorMode = loadOperatorMode(envFile, { AI_OPERATOR_MODE: "read_only" }, { command: "serve" });
  const persistence = loadPersistenceConfig(envFile, { DATABASE_URL: "postgres://process" });

  expect(appConfig.minimaxApiKey).toBe("process-key");
  expect(appConfig.modelName).toBe("ProcessModel");
  expect(operatorMode.mode).toBe("read_only");
  expect(operatorMode.capabilities.approvalStaging).toBe(false);
  expect(persistence.databaseUrl).toBe("postgres://process");
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
    [
      "GRAFANA_WEBHOOK_SECRET=webhook-secret",
      "LOKI_BASE_URL=http://loki:3100",
      "LOKI_LIMIT=7",
      "LOKI_TIMEOUT_MS=2500",
      "LOKI_TENANT_ID=tenant-a",
      "LOKI_BEARER_TOKEN=loki-secret",
      "OPERATOR_READ_TOKEN=read-secret",
    ].join("\n"),
  );

  const config = loadWebhookConfig(envFile, {});

  expect(config.grafanaWebhookSecret).toBe("webhook-secret");
  expect(config.lokiBaseUrl).toBe("http://loki:3100");
  expect(config.lokiLimit).toBe(7);
  expect(config.lokiTimeoutMs).toBe(2500);
  expect(config.lokiTenantId).toBe("tenant-a");
  expect(config.lokiBearerToken).toBe("loki-secret");
  expect(config.operatorReadToken).toBe("read-secret");
  expect(config.redacted.GRAFANA_WEBHOOK_SECRET).toBe("<redacted>");
  expect(config.redacted.LOKI_BEARER_TOKEN).toBe("<redacted>");
  expect(config.redacted.OPERATOR_READ_TOKEN).toBe("<redacted>");
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

test("loadOperatorMode defaults local commands to local mode", () => {
  const config = loadOperatorMode(writeTempEnv(""), {}, { command: "run" });

  expect(config.mode).toBe("local");
  expect(config.capabilities).toEqual({
    readOnlyTriage: true,
    approvalStaging: true,
    execution: false,
  });
});

test("loadOperatorMode requires explicit mode for serve with real integrations", () => {
  const envFile = writeTempEnv("GRAFANA_WEBHOOK_SECRET=webhook-secret\nLOKI_BASE_URL=http://loki:3100\n");

  expect(() => loadOperatorMode(envFile, {}, { command: "serve" })).toThrow(ConfigError);
  expect(() => loadOperatorMode(envFile, {}, { command: "serve" })).toThrow("AI_OPERATOR_MODE");
});

test("loadOperatorMode exposes read-only capabilities", () => {
  const envFile = writeTempEnv("AI_OPERATOR_MODE=read_only\nGRAFANA_WEBHOOK_SECRET=webhook-secret\n");

  const config = loadOperatorMode(envFile, {}, { command: "serve" });

  expect(config.mode).toBe("read_only");
  expect(config.capabilities).toEqual({
    readOnlyTriage: true,
    approvalStaging: false,
    execution: false,
  });
  expect(config.redacted.AI_OPERATOR_MODE).toBe("read_only");
});

test("loadOperatorMode blocks execution-enabled mode until durable execution exists", () => {
  const envFile = writeTempEnv("AI_OPERATOR_MODE=execution_enabled\nGRAFANA_WEBHOOK_SECRET=webhook-secret\n");

  expect(() => loadOperatorMode(envFile, {}, { command: "serve" })).toThrow("not available");
});

test("loadOperatorMode blocks approval mode until authenticated approvals exist", () => {
  const envFile = writeTempEnv("AI_OPERATOR_MODE=approval\nGRAFANA_WEBHOOK_SECRET=webhook-secret\n");

  expect(() => loadOperatorMode(envFile, {}, { command: "serve" })).toThrow("not available");
});

test("loadPersistenceConfig redacts database URL", () => {
  const envFile = writeTempEnv("DATABASE_URL=postgres://user:secret@localhost:5432/triage\n");

  const config = loadPersistenceConfig(envFile, {});

  expect(config.databaseUrl).toBe("postgres://user:secret@localhost:5432/triage");
  expect(config.redacted.DATABASE_URL).toBe("<redacted>");
});

function writeTempEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "incident-triage-config-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, contents);
  return envFile;
}
