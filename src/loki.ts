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

export interface LokiClientOptions {
  timeoutMs?: number;
  tenantId?: string;
  bearerToken?: string;
  redactPatterns?: RegExp[];
  maxResponseBytes?: number;
}

export class LokiClient {
  private readonly timeoutMs: number;
  private readonly tenantId: string | undefined;
  private readonly bearerToken: string | undefined;
  private readonly redactPatterns: readonly RegExp[];
  private readonly maxResponseBytes: number;

  constructor(
    private readonly baseUrl: string,
    optionsOrTimeout: LokiClientOptions | number = {},
    private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  ) {
    const options = typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.tenantId = options.tenantId;
    this.bearerToken = options.bearerToken;
    this.redactPatterns = options.redactPatterns ?? defaultRedactPatterns;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  }

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
        { method: "GET", signal: controller.signal, headers: this.headers() },
      );
      if (!response.ok) {
        throw new LokiClientError(`Loki HTTP error: ${response.status}.`);
      }
      const payload = await readJsonWithLimit(response, this.maxResponseBytes, () => controller.abort());
      return entriesFromPayload(payload, limit)
        .map((entry) => ({ ...entry, line: this.redact(entry.line) }));
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
      detail: `${entry.timestampNs} ${Object.entries(entry.labels).sort().map(([key, value]) => `${key}=${redactDefault(value)}`).join(", ")}`.trim(),
    }));
  }

  toEvidence(entries: LokiLogEntry[]): Evidence[] {
    return LokiClient.toEvidence(entries);
  }

  private headers(): Headers {
    const headers = new Headers();
    if (this.tenantId) {
      headers.set("X-Scope-OrgID", this.tenantId);
    }
    if (this.bearerToken) {
      headers.set("Authorization", `Bearer ${this.bearerToken}`);
    }
    return headers;
  }

  private redact(value: string): string {
    return redactValue(value, this.redactPatterns);
  }
}

const defaultRedactPatterns = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:authorization:\s*)?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:api[_-]?key|token|secret|password)=\S+/gi,
] as const;

function redactDefault(value: string): string {
  return redactValue(value, defaultRedactPatterns);
}

function redactValue(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((text, pattern) => text.replace(pattern, "<redacted>"), value);
}

async function readJsonWithLimit(response: Response, maxBytes: number, abort: () => void): Promise<unknown> {
  const text = await readTextWithLimit(response, maxBytes, abort);
  return JSON.parse(text) as unknown;
}

async function readTextWithLimit(response: Response, maxBytes: number, abort: () => void): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new LokiClientError(`Loki response exceeded ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        abort();
        throw new LokiClientError(`Loki response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
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
