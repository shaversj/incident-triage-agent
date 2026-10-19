import { expect, test } from "vitest";

import {
  auditRetainedEnvelopes,
  runRetainedEnvelopeAuditCommand,
  type ReviewEnvelopePool,
  type ReviewEnvelopePoolClient,
  type ReviewEnvelopeQueryClient,
} from "../scripts/check-retained-envelopes";

const rows = [
  { run_id: "run-1", review_envelope: { validation: { valid: true, errors: [] } } },
  { run_id: "run-2", review_envelope: { validation: { valid: "yes", errors: [] } } },
  { run_id: "run-3", review_envelope: {} },
  { run_id: "run-4", review_envelope: { validation: { valid: false, errors: ["invalid"] } } },
  { run_id: "run-5", review_envelope: { validation: { valid: true, errors: [] } } },
];

test("retained-envelope audit keyset-scans every row and reports only opaque identifiers", async () => {
  const cursors: string[] = [];
  const client: ReviewEnvelopeQueryClient = {
    async query(sql, values = []) {
      expect(sql).toContain("WHERE review_envelope IS NOT NULL AND run_id > $1");
      const cursor = String(values[0]);
      const limit = Number(values[1]);
      cursors.push(cursor);
      return { rows: rows.filter((row) => row.run_id > cursor).slice(0, limit) };
    },
  };

  const result = await auditRetainedEnvelopes(client, 2);

  expect(cursors).toEqual(["", "run-2", "run-4", "run-5"]);
  expect(result).toEqual({
    scanned: 5,
    compatible: 4,
    incompatible: 1,
    incompatibleRunIds: ["run-2"],
  });
  expect(JSON.stringify(result)).not.toContain("invalid");
  expect(JSON.stringify(result)).not.toContain("review_envelope");
});

test("retained-envelope audit command uses a repeatable read-only transaction and JSON output", async () => {
  const harness = commandHarness([{ run_id: "run-1", review_envelope: {} }]);

  const code = await runRetainedEnvelopeAuditCommand(["--json"], harness.options);

  expect(code).toBe(0);
  expect(harness.sql).toEqual([
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    expect.stringContaining("SELECT run_id, review_envelope"),
    expect.stringContaining("SELECT run_id, review_envelope"),
    "COMMIT",
  ]);
  expect(JSON.parse(harness.stdout.value)).toEqual({
    scanned: 1,
    compatible: 1,
    incompatible: 0,
    incompatible_run_ids: [],
  });
  expect(harness.released()).toBe(1);
  expect(harness.ended()).toBe(1);
});

test("retained-envelope audit command returns one and plain output for incompatible rows", async () => {
  const harness = commandHarness([{ run_id: "opaque-run", review_envelope: { validation: { valid: "yes" } } }]);

  const code = await runRetainedEnvelopeAuditCommand([], harness.options);

  expect(code).toBe(1);
  expect(harness.stdout.value).toContain("Scanned 1 retained envelope(s); 1 incompatible.");
  expect(harness.stdout.value).toContain("- opaque-run");
  expect(harness.stdout.value).not.toContain("valid:");
});

test("retained-envelope audit command rolls back and sanitizes database errors", async () => {
  const harness = commandHarness([], new Error(
    "postgres://operator:password@localhost/db token=secret-value failed",
  ));

  const code = await runRetainedEnvelopeAuditCommand(["--json"], harness.options);

  expect(code).toBe(2);
  expect(harness.sql).toEqual([
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    expect.stringContaining("SELECT run_id, review_envelope"),
    "ROLLBACK",
  ]);
  expect(harness.stderr.value).toContain("[redacted-database-url]");
  expect(harness.stderr.value).toContain("token=[redacted]");
  expect(harness.stderr.value).not.toContain("password");
  expect(harness.stderr.value).not.toContain("secret-value");
});

test("retained-envelope audit command closes its pool when connection fails", async () => {
  let ended = 0;
  const stderr = new StringSink();
  const code = await runRetainedEnvelopeAuditCommand([], {
    connectionString: "postgres://read-only",
    createPool: () => ({
      async connect() {
        throw new Error("connection unavailable");
      },
      async end() {
        ended += 1;
      },
    }),
    stdout: new StringSink(),
    stderr,
  });

  expect(code).toBe(2);
  expect(ended).toBe(1);
  expect(stderr.value).toContain("connection unavailable");
});

test("retained-envelope audit command rejects invalid arguments before opening a pool", async () => {
  let created = 0;
  const stderr = new StringSink();
  const code = await runRetainedEnvelopeAuditCommand(["--write"], {
    connectionString: "postgres://read-only",
    createPool: () => {
      created += 1;
      return commandHarness([]).pool;
    },
    stdout: new StringSink(),
    stderr,
  });

  expect(code).toBe(2);
  expect(created).toBe(0);
  expect(stderr.value).toContain("Unknown argument");
});

function commandHarness(
  retainedRows: Array<{ run_id: string; review_envelope: unknown }>,
  queryError?: Error,
): {
  pool: ReviewEnvelopePool;
  options: Parameters<typeof runRetainedEnvelopeAuditCommand>[1];
  sql: string[];
  stdout: StringSink;
  stderr: StringSink;
  released: () => number;
  ended: () => number;
} {
  const sql: string[] = [];
  const stdout = new StringSink();
  const stderr = new StringSink();
  let released = 0;
  let ended = 0;
  const client: ReviewEnvelopePoolClient = {
    async query(statement, values = []) {
      sql.push(statement.trim());
      if (statement.includes("SELECT run_id")) {
        if (queryError) {
          throw queryError;
        }
        const cursor = String(values[0]);
        const limit = Number(values[1]);
        return { rows: retainedRows.filter((row) => row.run_id > cursor).slice(0, limit) };
      }
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  const pool: ReviewEnvelopePool = {
    async connect() {
      return client;
    },
    async end() {
      ended += 1;
    },
  };
  return {
    pool,
    options: {
      connectionString: "postgres://read-only",
      createPool: () => pool,
      stdout,
      stderr,
    },
    sql,
    stdout,
    stderr,
    released: () => released,
    ended: () => ended,
  };
}

class StringSink {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += chunk.toString();
    return true;
  }
}
