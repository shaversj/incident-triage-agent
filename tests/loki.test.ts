import { expect, test } from "vitest";
import { LokiClient } from "../src/loki";
import { assertNoAnswerFields, loadRecordedLogs } from "../src/recorded-observability";

test("Loki client queries range and converts logs to evidence", async () => {
  let requestedUrl = "";
  const client = new LokiClient("http://loki:3100", 10_000, async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      status: "success",
      data: {
        result: [{
          stream: { service: "checkout-api" },
          values: [["1781622420000000000", "payment timeout after 3000ms"]],
        }],
      },
    }));
  });

  const entries = await client.queryRange(
    { service: "checkout-api" },
    1781621820000000000,
    1781623020000000000,
    { limit: 5, direction: "forward" },
  );
  const evidence = client.toEvidence(entries);

  expect(decodeURIComponent(requestedUrl)).toContain('query={service="checkout-api"}');
  expect(decodeURIComponent(requestedUrl)).toContain("direction=forward");
  expect(evidence[0]?.evidenceId).toBe("log:0");
  expect(evidence[0]?.sourceTier).toBe("operational_context");
  expect(evidence[0]?.summary).toContain("payment timeout");
});

test("Loki client reports downstream errors", async () => {
  const client = new LokiClient("http://loki:3100", 10_000, async () =>
    new Response("nope", { status: 503 })
  );

  await expect(client.queryRange({ service: "checkout-api" }, 1, 2)).rejects.toThrow("503");
});

test("Loki client sends tenant and bearer auth headers and redacts log lines", async () => {
  let requestedHeaders: Headers | undefined;
  const client = new LokiClient("http://loki:3100", {
    timeoutMs: 10_000,
    tenantId: "tenant-a",
    bearerToken: "secret-token",
  }, async (_url, init) => {
    requestedHeaders = new Headers(init?.headers);
	    return new Response(JSON.stringify({
	      status: "success",
	      data: {
	        result: [{
	          stream: { service: "checkout-api" },
	          values: [["1781622420000000000", "Authorization: Bearer secret-token token=abc123 user@example.com"]],
	        }],
	      },
	    }));
	  });

  const entries = await client.queryRange({ service: "checkout-api" }, 1, 2, { limit: 1 });

  expect(requestedHeaders?.get("X-Scope-OrgID")).toBe("tenant-a");
  expect(requestedHeaders?.get("Authorization")).toBe("Bearer secret-token");
  expect(entries[0]?.line).toBe("<redacted> <redacted> <redacted>");
});

test("Loki client rejects oversized successful responses", async () => {
  const client = new LokiClient("http://loki:3100", {
    timeoutMs: 10_000,
    maxResponseBytes: 32,
  }, async () =>
    new Response(JSON.stringify({
      status: "success",
      data: {
        result: [{
          stream: { service: "checkout-api" },
          values: [["1781622420000000000", "payment timeout after 3000ms"]],
        }],
      },
    }))
  );

  await expect(client.queryRange({ service: "checkout-api" }, 1, 2)).rejects.toThrow("exceeded");
});

test("recorded log fixtures load as Loki-shaped entries", () => {
  const entries = loadRecordedLogs("checkout-payment-timeout");

  expect(entries).toHaveLength(3);
  expect(entries[0]).toMatchObject({
    labels: { service: "checkout-api" },
  });
  expect(entries[0]?.line).toContain("payment timeout");
  expect(LokiClient.toEvidence(entries)[0]?.evidenceId).toBe("log:0");
});

test("recorded log fixtures reject answer-like fields", () => {
  expect(() => assertNoAnswerFields({
    entries: [{ line: "payment timeout", incident_class: "dependency_outage" }],
  })).toThrow("prohibited answer field");
});

test("Loki evidence redacts sensitive label values before persistence", () => {
  const evidence = LokiClient.toEvidence([{
    timestampNs: "1781622420000000000",
    line: "payment timeout",
    labels: {
      service: "checkout-api",
      operator: "user@example.com",
      token: "token=secret-value",
      authorization: "Bearer secret-token",
    },
  }]);

  expect(evidence[0]?.detail).toContain("service=checkout-api");
  expect(evidence[0]?.detail).toContain("operator=<redacted>");
  expect(evidence[0]?.detail).toContain("token=<redacted>");
  expect(evidence[0]?.detail).toContain("authorization=<redacted>");
  expect(evidence[0]?.detail).not.toContain("user@example.com");
  expect(evidence[0]?.detail).not.toContain("secret-token");
  expect(evidence[0]?.detail).not.toContain("secret-value");
});
