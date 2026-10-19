import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { InMemoryTriageRunPersistenceStore } from "../src/persistence";
import { registerPersistenceConformanceSuite } from "./support/persistence-conformance";

registerPersistenceConformanceSuite("in-memory", {
  createStore: () => new InMemoryTriageRunPersistenceStore(),
});

test("phase 1 migration owns only run evidence and replay tables", () => {
  const sql = readFileSync("src/persistence/migrations/001_phase1_read_only.sql", "utf8");

  expect(sql).toContain("CREATE TABLE IF NOT EXISTS incident_runs");
  expect(sql).toContain("review_envelope JSONB");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS evidence_snapshots");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS replay_keys");
  expect(sql).not.toContain("approval_requests");
  expect(sql).not.toContain("executor_attempts");
});
