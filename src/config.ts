import { existsSync, readFileSync } from "node:fs";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  minimaxApiKey: string;
  modelName: string;
  minimaxBaseUrl: string;
  redacted: {
    MINIMAX_API_KEY: "<redacted>";
    MODEL_NAME: string;
    MINIMAX_BASE_URL: string;
  };
}

export interface WebhookConfig {
  grafanaWebhookSecret: string;
  lokiBaseUrl: string;
  lokiLimit: number;
  redacted: {
    GRAFANA_WEBHOOK_SECRET: "<redacted>";
    LOKI_BASE_URL: string;
    LOKI_LIMIT: string;
  };
}

export function loadDotenv(path = ".env"): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const values: Record<string, string> = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!line.includes("=")) {
      throw new ConfigError(`Invalid .env line ${index + 1}; expected KEY=value.`);
    }

    const [rawKey, ...rawValueParts] = line.split("=");
    const key = rawKey?.trim() ?? "";
    if (!key) {
      throw new ConfigError(`Invalid .env line ${index + 1}; missing key.`);
    }
    values[key] = stripQuotes(rawValueParts.join("=").trim());
  }
  return values;
}

export function loadConfig(
  envPath = ".env",
  environ: Record<string, string | undefined> = process.env,
): AppConfig {
  const source = { ...definedValues(environ), ...loadDotenv(envPath) };
  const missing = ["MINIMAX_API_KEY", "MODEL_NAME"].filter((name) => !source[name]);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required configuration: ${missing.join(", ")}.`);
  }

  const minimaxApiKey = source.MINIMAX_API_KEY;
  const modelName = source.MODEL_NAME;
  if (!minimaxApiKey || !modelName) {
    throw new ConfigError("Missing required MiniMax configuration.");
  }
  const minimaxBaseUrl = source.MINIMAX_BASE_URL ?? "https://api.minimax.io";
  return {
    minimaxApiKey,
    modelName,
    minimaxBaseUrl,
    redacted: {
      MINIMAX_API_KEY: "<redacted>",
      MODEL_NAME: modelName,
      MINIMAX_BASE_URL: minimaxBaseUrl,
    },
  };
}

export function loadWebhookConfig(
  envPath = ".env",
  environ: Record<string, string | undefined> = process.env,
): WebhookConfig {
  const source = { ...definedValues(environ), ...loadDotenv(envPath) };
  const secret = source.GRAFANA_WEBHOOK_SECRET;
  if (!secret) {
    throw new ConfigError("Missing required configuration: GRAFANA_WEBHOOK_SECRET.");
  }

  const lokiLimitText = source.LOKI_LIMIT ?? "20";
  const lokiLimit = Number.parseInt(lokiLimitText, 10);
  if (!Number.isInteger(lokiLimit) || `${lokiLimit}` !== lokiLimitText.trim()) {
    throw new ConfigError("LOKI_LIMIT must be an integer.");
  }
  if (lokiLimit <= 0) {
    throw new ConfigError("LOKI_LIMIT must be greater than 0.");
  }

  const lokiBaseUrl = source.LOKI_BASE_URL ?? "http://localhost:3100";
  return {
    grafanaWebhookSecret: secret,
    lokiBaseUrl,
    lokiLimit,
    redacted: {
      GRAFANA_WEBHOOK_SECRET: "<redacted>",
      LOKI_BASE_URL: lokiBaseUrl,
      LOKI_LIMIT: `${lokiLimit}`,
    },
  };
}

export function redactSecret(text: string, config?: Pick<AppConfig, "minimaxApiKey">): string {
  if (!config?.minimaxApiKey) {
    return text;
  }
  return text.replaceAll(config.minimaxApiKey, "<redacted>");
}

function definedValues(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
