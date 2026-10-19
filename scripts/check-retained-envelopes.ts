import { Pool } from "pg";

import { decodeTriageRunReviewEnvelope } from "../src/persistence/postgres-row-mapping";

interface ReviewEnvelopeRow {
  run_id: string;
  review_envelope: unknown;
}

export interface ReviewEnvelopeQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: ReviewEnvelopeRow[] }>;
}

export interface RetainedEnvelopeAuditResult {
  scanned: number;
  compatible: number;
  incompatible: number;
  incompatibleRunIds: string[];
}

export async function auditRetainedEnvelopes(
  client: ReviewEnvelopeQueryClient,
  batchSize = 250,
): Promise<RetainedEnvelopeAuditResult> {
  const result: RetainedEnvelopeAuditResult = {
    scanned: 0,
    compatible: 0,
    incompatible: 0,
    incompatibleRunIds: [],
  };
  let cursor = "";

  while (true) {
    const page = await client.query(
      `SELECT run_id, review_envelope
       FROM incident_runs
       WHERE review_envelope IS NOT NULL AND run_id > $1
       ORDER BY run_id
       LIMIT $2`,
      [cursor, batchSize],
    );
    if (page.rows.length === 0) {
      return result;
    }
    for (const row of page.rows) {
      result.scanned += 1;
      cursor = row.run_id;
      try {
        decodeTriageRunReviewEnvelope(row.review_envelope);
        result.compatible += 1;
      } catch {
        result.incompatible += 1;
        result.incompatibleRunIds.push(row.run_id);
      }
    }
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const json = parseArgs(argv);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("Retained envelope audit requires DATABASE_URL for a read-only database role.\n");
    return 2;
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    const result = await auditRetainedEnvelopes(client);
    await client.query("COMMIT");
    if (json) {
      process.stdout.write(`${JSON.stringify({
        scanned: result.scanned,
        compatible: result.compatible,
        incompatible: result.incompatible,
        incompatible_run_ids: result.incompatibleRunIds,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`Scanned ${result.scanned} retained envelope(s); ${result.incompatible} incompatible.\n`);
      for (const runId of result.incompatibleRunIds) {
        process.stdout.write(`- ${runId}\n`);
      }
    }
    return result.incompatible === 0 ? 0 : 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    process.stderr.write(`Retained envelope audit failed: ${safeMessage(error)}\n`);
    return 2;
  } finally {
    client.release();
    await pool.end();
  }
}

function parseArgs(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg !== "--json") {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return argv.includes("--json");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown database error.";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/(password|token|secret)=?[^\s]*/gi, "$1=[redacted]");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write("Retained envelope audit failed.\n");
    process.exitCode = 2;
  });
}
