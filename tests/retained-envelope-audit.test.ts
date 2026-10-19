import { expect, test } from "vitest";

import { auditRetainedEnvelopes, type ReviewEnvelopeQueryClient } from "../scripts/check-retained-envelopes";

test("retained-envelope audit scans every row and reports only opaque identifiers", async () => {
  const pages = [
    [
      { run_id: "run-1", review_envelope: { validation: { valid: true, errors: [] } } },
      { run_id: "run-2", review_envelope: { validation: { valid: "yes", errors: [] } } },
    ],
    [],
  ];
  const client: ReviewEnvelopeQueryClient = {
    async query() {
      return { rows: pages.shift() ?? [] };
    },
  };

  const result = await auditRetainedEnvelopes(client, 2);

  expect(result).toEqual({
    scanned: 2,
    compatible: 1,
    incompatible: 1,
    incompatibleRunIds: ["run-2"],
  });
  expect(JSON.stringify(result)).not.toContain("decision was invalid");
  expect(JSON.stringify(result)).not.toContain("review_envelope");
});
