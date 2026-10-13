import { expect, test } from "vitest";

import { buildReducedOutcomeCandidate } from "../src/outcome-promotion";

test("outcome candidates retain only allowlisted decision evidence", () => {
  const candidate = buildReducedOutcomeCandidate({
    incidentId: "INC-1",
    runId: "run-1",
    sourceEventId: "feedback:1",
    category: "corrected_finding",
    rationale: "The deploy was unrelated.",
    evidenceIds: ["deploy:0", "deploy:0"],
    snapshot: {
      incident_class: "bad_deploy",
      next_action: "request_rollback_approval",
      raw_prompt: "must not persist",
    },
  });

  expect(candidate.evidenceIds).toEqual(["deploy:0"]);
  expect(candidate.snapshot).toEqual({
    incident_class: "bad_deploy",
    next_action: "request_rollback_approval",
  });
});

test("outcome candidates reject credential-shaped fields before reduction", () => {
  expect(() => buildReducedOutcomeCandidate({
    incidentId: "INC-1",
    sourceEventId: "feedback:1",
    category: "corrected_finding",
    rationale: "Correction.",
    evidenceIds: [],
    snapshot: { metadata: { api_key: "sensitive" } },
  })).toThrow("not allowed");
});
