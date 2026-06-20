import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LokiClient, type LokiLogEntry } from "./loki";
import type { LokiClientLike } from "./server";

const prohibitedAnswerFields = new Set([
  "incident_class",
  "next_action",
  "suspected_causes",
  "recommended_actions",
  "requires_approval",
  "safety",
  "scorecard",
]);

export class RecordedLokiClient implements LokiClientLike {
  lastQuery?: {
    labels: Record<string, string>;
    startNs: number;
    endNs: number;
    limit?: number;
    direction?: "forward" | "backward";
  };

  constructor(private readonly entries: LokiLogEntry[]) {}

  static fromFixture(name: string, fixturesDir = "fixtures"): RecordedLokiClient {
    return new RecordedLokiClient(loadRecordedLogs(name, fixturesDir));
  }

  async queryRange(
    labels: Record<string, string>,
    startNs: number,
    endNs: number,
    options: { limit?: number; direction?: "forward" | "backward" },
  ): Promise<LokiLogEntry[]> {
    this.lastQuery = { labels, startNs, endNs };
    if (options.limit !== undefined) {
      this.lastQuery.limit = options.limit;
    }
    if (options.direction !== undefined) {
      this.lastQuery.direction = options.direction;
    }
    const matching = this.entries.filter((entry) =>
      Object.entries(labels).every(([key, value]) => entry.labels[key] === value)
    );
    return matching.slice(0, options.limit ?? matching.length);
  }

  toEvidence(entries: LokiLogEntry[]) {
    return LokiClient.toEvidence(entries);
  }
}

export function loadRecordedLogs(name: string, fixturesDir = "fixtures"): LokiLogEntry[] {
  const path = join(fixturesDir, "logs", `${name}.json`);
  const payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertNoAnswerFields(payload, path);
  if (!isRecord(payload) || !Array.isArray(payload.entries)) {
    throw new Error(`Recorded log fixture ${path} must contain an entries array.`);
  }
  return payload.entries.map((entry, index) => normalizeEntry(entry, `${path}.entries[${index}]`));
}

export function assertNoAnswerFields(value: unknown, path = "value"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAnswerFields(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (prohibitedAnswerFields.has(key)) {
      throw new Error(`Recorded observability fixture contains prohibited answer field at ${path}.${key}.`);
    }
    assertNoAnswerFields(nested, `${path}.${key}`);
  }
}

function normalizeEntry(value: unknown, path: string): LokiLogEntry {
  if (!isRecord(value)) {
    throw new Error(`Recorded log entry ${path} must be an object.`);
  }
  if (typeof value.timestampNs !== "string" || typeof value.line !== "string" || !isRecord(value.labels)) {
    throw new Error(`Recorded log entry ${path} must include timestampNs, line, and labels.`);
  }
  return {
    timestampNs: value.timestampNs,
    line: value.line,
    labels: Object.fromEntries(Object.entries(value.labels).map(([key, nested]) => [key, String(nested)])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
