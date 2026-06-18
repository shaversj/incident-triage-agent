import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import pino from "pino";

const logger = pino({ name: "synthetic-checkout-service", level: process.env.LOG_LEVEL ?? "info" });

export class LokiPushError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LokiPushError";
  }
}

export interface ServiceConfig {
  host: string;
  port: number;
  lokiUrl: string;
  serviceName: string;
}

export interface LokiPayload {
  streams: Array<{
    stream: Record<string, string>;
    values: Array<[string, string]>;
  }>;
}

export interface SyntheticService {
  server: Server;
  ready: Promise<void>;
  closed: Promise<void>;
  close(): Promise<void>;
}

type ScenarioName = "payment-timeout" | "capacity-saturation" | "bad-deploy-latency";

const scenarioLogLines: Record<ScenarioName, string[]> = {
  "payment-timeout": [
    "checkout_id={incident_id} payment timeout after 3000ms",
    "checkout_id={incident_id} retry queue depth increasing for payment gateway",
    "checkout_id={incident_id} customer checkout failed after payment retries",
  ],
  "capacity-saturation": [
    "incident_id={incident_id} search worker cpu=94 queue_depth=438",
    "incident_id={incident_id} search-api p95 latency elevated while workers saturated",
    "incident_id={incident_id} autoscaling backlog still above baseline",
  ],
  "bad-deploy-latency": [
    "incident_id={incident_id} checkout-api p95 latency elevated after v2.19.0 traffic ramp",
    "incident_id={incident_id} checkout retry attempts increased for checkout-api requests",
    "incident_id={incident_id} checkout error rate above baseline for new version",
  ],
};

const routes: Record<string, {
  scenario: ScenarioName;
  service: (config: ServiceConfig) => string;
  idField: string;
  idPrefix: string;
}> = {
  "/checkout": {
    scenario: "payment-timeout",
    service: (config) => config.serviceName,
    idField: "checkout_id",
    idPrefix: "checkout",
  },
  "/capacity": {
    scenario: "capacity-saturation",
    service: () => "search-api",
    idField: "incident_id",
    idPrefix: "capacity",
  },
  "/bad-deploy": {
    scenario: "bad-deploy-latency",
    service: () => "checkout-api",
    idField: "incident_id",
    idPrefix: "bad-deploy",
  },
};

export function buildLokiPayload(input: {
  serviceName: string;
  checkoutId: string;
  timestampNs?: string;
  scenario?: ScenarioName;
}): LokiPayload {
  const scenario = input.scenario ?? "payment-timeout";
  const lines = scenarioLogLines[scenario];
  const timestamp = input.timestampNs ?? String(BigInt(Date.now()) * 1_000_000n);

  return {
    streams: [{
      stream: {
        service: input.serviceName,
        component: "synthetic-checkout",
        scenario,
      },
      values: lines.map((line) => [
        timestamp,
        line.replaceAll("{incident_id}", input.checkoutId),
      ]),
    }],
  };
}

export async function pushLokiLogs(
  lokiUrl: string,
  payload: LokiPayload,
  options: {
    timeoutSeconds?: number;
    fetcher?: typeof fetch;
  } = {},
): Promise<void> {
  const timeoutSeconds = options.timeoutSeconds ?? 10;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(`${lokiUrl.replace(/\/$/, "")}/loki/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new LokiPushError(`Loki HTTP error: ${response.status}.`);
    }
    await response.arrayBuffer();
  } catch (error) {
    if (error instanceof LokiPushError) {
      throw error;
    }
    throw new LokiPushError(`Loki request failed: ${error instanceof Error ? error.message : String(error)}.`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function startSyntheticCheckoutService(config: ServiceConfig): SyntheticService {
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, config);
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "Unhandled synthetic service request error");
      writeJson(response, 500, { status: "error", error: "internal_server_error" });
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      logger.info({ host: config.host, port: config.port }, "Synthetic checkout service ready");
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => server.once("close", resolve));

  return {
    server,
    ready,
    closed,
    close: async () => closeServer(server),
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number.parseInt(env.PORT ?? "8081", 10),
    lokiUrl: env.LOKI_URL ?? "http://localhost:3100",
    serviceName: env.SERVICE_NAME ?? "checkout-api",
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServiceConfig,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { status: "ok", service: config.serviceName });
    return;
  }

  const route = request.url ? routes[request.url] : undefined;
  if (request.method !== "POST" || route === undefined) {
    writeJson(response, 404, { status: "error", error: "not_found" });
    return;
  }

  let requestPayload: Record<string, unknown>;
  try {
    requestPayload = await readJsonObject(request);
  } catch (error) {
    writeJson(response, 400, { status: "error", error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const incidentId = String(requestPayload[route.idField] ?? `${route.idPrefix}-${Math.floor(Date.now() / 1000)}`);
  const payload = buildLokiPayload({
    serviceName: route.service(config),
    checkoutId: incidentId,
    scenario: route.scenario,
  });

  try {
    await pushLokiLogs(config.lokiUrl, payload);
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to push synthetic logs to Loki");
    writeJson(response, 502, { status: "error", error: "loki_push_failed" });
    return;
  }

  writeJson(response, 202, {
    status: "accepted",
    service: route.service(config),
    scenario: route.scenario,
    [route.idField]: incidentId,
    log_count: payload.streams[0]?.values.length ?? 0,
  });
}

function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const length = Number.parseInt(request.headers["content-length"] ?? "0", 10);
    if (length > 100_000) {
      reject(new Error("payload_too_large"));
      request.destroy();
      return;
    }
    if (length === 0) {
      resolve({});
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        const payload: unknown = JSON.parse(body);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          reject(new Error("payload_must_be_object"));
          return;
        }
        resolve(payload as Record<string, unknown>);
      } catch {
        reject(new Error("invalid_json"));
      }
    });
  });
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<number> {
  const service = startSyntheticCheckoutService(configFromEnv());
  await service.ready;
  await service.closed;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "Synthetic service failed");
      process.exitCode = 1;
    },
  );
}
