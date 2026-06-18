import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import {
  LokiPushError,
  buildLokiPayload,
  pushLokiLogs,
  startSyntheticCheckoutService,
} from "../services/synthetic-checkout-service";

const servicesToClose: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servicesToClose.splice(0).map((service) => service.close()));
});

test("buildLokiPayload uses queryable service labels and runtime checkout id", () => {
  const payload = buildLokiPayload({
    serviceName: "checkout-api",
    checkoutId: "checkout-123",
    timestampNs: "1781622420000000000",
  });

  const stream = payload.streams[0];
  expect(stream?.stream.service).toBe("checkout-api");
  expect(stream?.stream.component).toBe("synthetic-checkout");
  expect(stream?.values.length).toBeGreaterThanOrEqual(2);
  for (const [timestamp, line] of stream?.values ?? []) {
    expect(timestamp).toBe("1781622420000000000");
    expect(line).toContain("checkout-123");
  }
});

test("buildLokiPayload supports capacity and bad deploy scenarios", () => {
  const capacity = buildLokiPayload({
    serviceName: "search-api",
    checkoutId: "capacity-123",
    timestampNs: "1781625780000000000",
    scenario: "capacity-saturation",
  });
  const badDeploy = buildLokiPayload({
    serviceName: "checkout-api",
    checkoutId: "bad-deploy-123",
    timestampNs: "1781627400000000000",
    scenario: "bad-deploy-latency",
  });

  expect(capacity.streams[0]?.stream.service).toBe("search-api");
  expect(capacity.streams[0]?.stream.scenario).toBe("capacity-saturation");
  expect(capacity.streams[0]?.values[0]?.[1]).toContain("queue_depth");
  expect(badDeploy.streams[0]?.stream.service).toBe("checkout-api");
  expect(badDeploy.streams[0]?.stream.scenario).toBe("bad-deploy-latency");
  expect(badDeploy.streams[0]?.values[0]?.[1]).toContain("v2.19.0");
});

test("pushLokiLogs posts to Loki push endpoint", async () => {
  const payload = buildLokiPayload({
    serviceName: "checkout-api",
    checkoutId: "checkout-123",
    timestampNs: "1781622420000000000",
  });
  const fetcher = vi.fn(async () => new Response("", { status: 200 }));

  await pushLokiLogs("http://loki:3100", payload, { fetcher });

  expect(fetcher).toHaveBeenCalledWith(
    "http://loki:3100/loki/api/v1/push",
    expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
});

test("pushLokiLogs wraps downstream failures without incident values", async () => {
  const payload = buildLokiPayload({
    serviceName: "checkout-api",
    checkoutId: "checkout-123",
    timestampNs: "1781622420000000000",
  });
  const fetcher = vi.fn(async () => {
    throw new Error("connection refused");
  });

  await expect(pushLokiLogs("http://loki:3100", payload, { fetcher })).rejects.toThrow(LokiPushError);
  await expect(pushLokiLogs("http://loki:3100", payload, { fetcher })).rejects.not.toThrow("checkout-123");
});

test("HTTP routes generate scenario logs through the real service boundary", async () => {
  const receivedPayloads: unknown[] = [];
  const loki = await startFakeLoki(receivedPayloads);
  servicesToClose.push(loki);

  const service = startSyntheticCheckoutService({
    host: "127.0.0.1",
    port: 0,
    lokiUrl: loki.url,
    serviceName: "checkout-api",
  });
  servicesToClose.push(service);
  await service.ready;
  const baseUrl = `http://127.0.0.1:${addressPort(service.server.address())}`;

  const response = await fetch(`${baseUrl}/bad-deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incident_id: "bad-deploy-123" }),
  });

  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toMatchObject({
    status: "accepted",
    service: "checkout-api",
    scenario: "bad-deploy-latency",
    incident_id: "bad-deploy-123",
    log_count: 3,
  });
  expect(receivedPayloads).toHaveLength(1);
  expect(receivedPayloads[0]).toMatchObject({
    streams: [{
      stream: {
        service: "checkout-api",
        component: "synthetic-checkout",
        scenario: "bad-deploy-latency",
      },
    }],
  });
});

async function startFakeLoki(receivedPayloads: unknown[]) {
  const server = startSyntheticLoki(receivedPayloads);
  await server.ready;
  return {
    url: `http://127.0.0.1:${addressPort(server.server.address())}`,
    close: server.close,
  };
}

function startSyntheticLoki(receivedPayloads: unknown[]) {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/loki/api/v1/push") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      receivedPayloads.push(JSON.parse(body));
      response.writeHead(204);
      response.end();
    });
  });
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    ready,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function addressPort(address: ReturnType<import("node:net").Server["address"]>): number {
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return address.port;
}
