import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { operatorDemoPreflight, operatorDemoStartupMessage } from "../scripts/operator-demo-preflight";

test("operator demo preflight explains how to create a missing env file", async () => {
  const envPath = join(mkdtempSync(join(tmpdir(), "incident-triage-preflight-")), ".env");

  const result = await operatorDemoPreflight({ envPath, environ: {} });

  expect(result).toMatchObject({ ok: false });
  if (!result.ok) {
    expect(result.message).toContain("Missing .env.");
    expect(result.message).toContain("cp .env.example .env");
    expect(result.message).toContain("docker compose up -d postgres");
  }
});

test("operator demo preflight explains the expected database url when it is missing", async () => {
  const envPath = writeTempEnv("POSTGRES_HOST_PORT=5433\n");

  const result = await operatorDemoPreflight({ envPath, environ: {} });

  expect(result).toMatchObject({ ok: false });
  if (!result.ok) {
    expect(result.message).toContain("DATABASE_URL is not set.");
    expect(result.message).toContain("POSTGRES_HOST_PORT=5433");
    expect(result.message).toContain("postgres://incident_triage:incident_triage@localhost:5433/incident_triage");
  }
});

test("operator demo preflight succeeds when the configured database is reachable", async () => {
  const envPath = writeTempEnv("DATABASE_URL=postgres://incident_triage:incident_triage@localhost:5432/incident_triage\n");
  const connectedTo: string[] = [];

  const result = await operatorDemoPreflight({
    envPath,
    environ: {},
    connect: async (databaseUrl) => {
      connectedTo.push(databaseUrl);
    },
  });

  expect(result).toEqual({
    ok: true,
    databaseUrl: "postgres://incident_triage:incident_triage@localhost:5432/incident_triage",
  });
  expect(connectedTo).toEqual(["postgres://incident_triage:incident_triage@localhost:5432/incident_triage"]);
});

test("operator demo preflight gives port guidance when Postgres is unreachable", async () => {
  const databaseUrl = "postgres://incident_triage:secret@localhost:5433/incident_triage";
  const envPath = writeTempEnv(`DATABASE_URL=${databaseUrl}\n`);

  const result = await operatorDemoPreflight({
    envPath,
    environ: {},
    connect: async () => {
      throw new Error(`password authentication failed for ${databaseUrl}`);
    },
  });

  expect(result).toMatchObject({ ok: false });
  if (!result.ok) {
    expect(result.message).toContain("Could not connect to the demo Postgres database.");
    expect(result.message).toContain("docker compose up -d postgres");
    expect(result.message).toContain("POSTGRES_HOST_PORT=5433");
    expect(result.message).toContain("localhost:5433");
    expect(result.message).not.toContain("secret");
  }
});

test("operator demo startup message gives exact browser steps", () => {
  expect(operatorDemoStartupMessage()).toContain("Open: http://127.0.0.1:8080/runs");
  expect(operatorDemoStartupMessage()).toContain("Select bad-deploy-latency.");
  expect(operatorDemoStartupMessage()).toContain("Click Run Scenario.");
  expect(operatorDemoStartupMessage()).toContain("Click Approve.");
});

function writeTempEnv(contents: string): string {
  const envPath = join(mkdtempSync(join(tmpdir(), "incident-triage-preflight-")), ".env");
  writeFileSync(envPath, contents);
  return envPath;
}
