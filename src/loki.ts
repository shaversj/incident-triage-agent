import type { Evidence } from "./evidence";

export class LokiClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LokiClientError";
  }
}

export interface LokiLogEntry {
  timestampNs: string;
  line: string;
  labels: Record<string, string>;
}

export class LokiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  ) {}

  async queryRange(
    labels: Record<string, string>,
    startNs: number,
    endNs: number,
    options: { limit?: number; direction?: "forward" | "backward" } = {},
  ): Promise<LokiLogEntry[]> {
    const limit = options.limit ?? 20;
    const direction = options.direction ?? "backward";
    const params = new URLSearchParams({
      query: selector(labels),
      start: String(startNs),
      end: String(endNs),
      limit: String(limit),
      direction,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl.replace(/\/$/, "")}/loki/api/v1/query_range?${params.toString()}`,
        { method: "GET", signal: controller.signal },
      );
      if (!response.ok) {
        throw new LokiClientError(`Loki HTTP error: ${response.status}.`);
      }
      return entriesFromPayload(await response.json(), limit);
    } catch (error) {
      if (error instanceof LokiClientError) {
        throw error;
      }
      throw new LokiClientError(`Loki request failed: ${error instanceof Error ? error.message : String(error)}.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  static toEvidence(entries: LokiLogEntry[]): Evidence[] {
    return entries.map((entry, index) => ({
      evidenceId: `log:${index}`,
      source: "log",
      sourceTier: "operational_context",
      summary: entry.line,
      detail: `${entry.timestampNs} ${Object.entries(entry.labels).sort().map(([key, value]) => `${key}=${value}`).join(", ")}`.trim(),
    }));
  }

  toEvidence(entries: LokiLogEntry[]): Evidence[] {
    return LokiClient.toEvidence(entries);
  }
}

function selector(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    throw new LokiClientError("At least one Loki label is required.");
  }
  return `{${entries.sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) =>
    `${key}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  ).join(",")}}`;
}

function entriesFromPayload(payload: unknown, limit: number): LokiLogEntry[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new LokiClientError("Loki response was not a JSON object.");
  }
  const body = payload as Record<string, unknown>;
  if (body.status !== "success") {
    throw new LokiClientError("Loki response status was not success.");
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LokiClientError("Loki response data was missing.");
  }
  const result = (data as Record<string, unknown>).result;
  if (!Array.isArray(result)) {
    throw new LokiClientError("Loki response result was missing.");
  }

  const entries: LokiLogEntry[] = [];
  for (const stream of result) {
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
      continue;
    }
    const labels = (stream as Record<string, unknown>).stream;
    const values = (stream as Record<string, unknown>).values;
    if (!labels || typeof labels !== "object" || Array.isArray(labels) || !Array.isArray(values)) {
      continue;
    }
    const cleanLabels = Object.fromEntries(
      Object.entries(labels).map(([key, value]) => [key, String(value)]),
    );
    for (const value of values) {
      if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
        entries.push({ timestampNs: value[0], line: value[1], labels: cleanLabels });
      }
      if (entries.length >= limit) {
        return entries;
      }
    }
  }
  return entries;
}
