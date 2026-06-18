import { expect, test } from "bun:test";
import { LokiClient } from "../src/loki";

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
