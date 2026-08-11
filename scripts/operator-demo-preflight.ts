import { existsSync } from "node:fs";
import { Client } from "pg";

import { loadDotenv } from "../src/config";

export interface OperatorDemoPreflightOptions {
  envPath?: string;
  environ?: Record<string, string | undefined>;
  connect?: (databaseUrl: string) => Promise<void>;
}

export interface OperatorDemoPreflightSuccess {
  ok: true;
  databaseUrl: string;
}

export interface OperatorDemoPreflightFailure {
  ok: false;
  message: string;
}

export type OperatorDemoPreflightResult = OperatorDemoPreflightSuccess | OperatorDemoPreflightFailure;

export async function operatorDemoPreflight(
  options: OperatorDemoPreflightOptions = {},
): Promise<OperatorDemoPreflightResult> {
  const envPath = options.envPath ?? ".env";
  if (!existsSync(envPath)) {
    return failure([
      "Missing .env.",
      "Create one before running the operator demo:",
      "  cp .env.example .env",
      "  docker compose up -d postgres",
      "  npm run demo:operator",
    ]);
  }

  let envFile: Record<string, string>;
  try {
    envFile = loadDotenv(envPath);
  } catch (error) {
    return failure([
      `Could not read ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the .env file, then rerun npm run demo:operator.",
    ]);
  }

  const source = { ...envFile, ...definedValues(options.environ ?? process.env) };
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    const hostPort = source.POSTGRES_HOST_PORT ?? "5432";
    return failure([
      "DATABASE_URL is not set.",
      "Add a local Postgres URL to .env:",
      `  POSTGRES_HOST_PORT=${hostPort}`,
      `  DATABASE_URL=${expectedDatabaseUrl(hostPort)}`,
      "Then start Postgres:",
      "  docker compose up -d postgres",
    ]);
  }

  try {
    await (options.connect ?? connectPostgres)(databaseUrl);
  } catch (error) {
    return failure(postgresFailureMessage(databaseUrl, error));
  }

  return { ok: true, databaseUrl };
}

export function operatorDemoStartupMessage(): string {
  return [
    "Starting local operator demo.",
    "",
    "Open: http://127.0.0.1:8080/runs",
    "1. Select bad-deploy-latency.",
    "2. Click Run Scenario.",
    "3. Review the Approval Gate.",
    "4. Click Approve.",
  ].join("\n");
}

function postgresFailureMessage(databaseUrl: string, error: unknown): string[] {
  const port = portFromDatabaseUrl(databaseUrl) ?? "5432";
  return [
    "Could not connect to the demo Postgres database.",
    `Connection error: ${safeErrorMessage(error, databaseUrl)}`,
    "",
    "Fix:",
    "  docker compose up -d postgres",
    `  DATABASE_URL=${expectedDatabaseUrl(port)}`,
    "",
    "If your container maps Postgres to a different host port, update both values in .env:",
    "  POSTGRES_HOST_PORT=5433",
    `  DATABASE_URL=${expectedDatabaseUrl("5433")}`,
  ];
}

function safeErrorMessage(error: unknown, databaseUrl: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(databaseUrl, redactDatabaseUrl(databaseUrl));
}

function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) {
      url.password = "<redacted>";
    }
    return url.toString();
  } catch {
    return "<redacted DATABASE_URL>";
  }
}

async function connectPostgres(databaseUrl: string): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

function expectedDatabaseUrl(port: string): string {
  return `postgres://incident_triage:incident_triage@localhost:${port}/incident_triage`;
}

function portFromDatabaseUrl(databaseUrl: string): string | undefined {
  try {
    return new URL(databaseUrl).port || undefined;
  } catch {
    return undefined;
  }
}

function definedValues(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function failure(lines: string[]): OperatorDemoPreflightFailure {
  return {
    ok: false,
    message: lines.join("\n"),
  };
}
