import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import * as failureDiscovery from "../evals/failure-discovery";
import * as persistence from "../src/persistence";
import * as server from "../src/server";

test("compatibility facades retain their public runtime exports", () => {
  expect(Object.keys(persistence).sort()).toEqual([
    "InMemoryTriageRunPersistenceStore",
    "PostgresTriageRunPersistenceStore",
    "buildReplayKey",
  ]);
  expect(Object.keys(server).sort()).toEqual([
    "handleGrafanaWebhook",
    "mitigationControlToResponse",
    "runToResponse",
    "startWebhookServer",
  ]);
  expect(Object.keys(failureDiscovery).sort()).toEqual([
    "addRunToBatch",
    "canonicalJson",
    "completeReviewBatch",
    "createReviewBatch",
    "defaultFailureReviewRoot",
    "failureDiscoverySchemaVersion",
    "findFailureMode",
    "fingerprintJson",
    "latestFailureMode",
    "loadBatchManifest",
    "loadFailureTaxonomy",
    "loadPromotedCase",
    "loadReviewBatch",
    "loadReviewRecord",
    "loadRunRecord",
    "outcomeCandidateToFailureRun",
    "parseFailureReviewRecord",
    "promoteCandidateObservation",
    "promoteFailureMode",
    "renderReviewBatchSummary",
    "retireFailureMode",
    "reviewArtifactPath",
    "reviewPaths",
    "reviewStage",
    "reviseFailureMode",
    "saveBatchManifest",
    "saveFailureTaxonomy",
    "saveReviewRecord",
    "saveRunRecord",
    "validateReviewBatch",
    "validateReviewRecord",
    "writeJsonAtomic",
  ]);
});

test("facades remain export-only and leaf modules do not import them", () => {
  for (const path of ["src/persistence/index.ts", "src/server.ts", "evals/failure-discovery.ts"]) {
    expect(readFileSync(path, "utf8"), path).not.toMatch(/^(?:export )?(?:async )?(?:class|function|const|let) /m);
  }

  expect(readTypeScriptFiles("src/persistence", ["index.ts"])).not.toMatch(
    /from ["'](?:\.\/index|\.\.\/persistence)["']/,
  );
  expect(readTypeScriptFiles("src/server")).not.toMatch(/from ["']\.\.\/server["']/);
  expect(readFileSync("src/recorded-observability.ts", "utf8")).not.toMatch(/from ["']\.\/server["']/);
  expect(readTypeScriptFiles("evals/failure-discovery")).not.toMatch(/from ["']\.\.\/failure-discovery["']/);
});

test("approval and taxonomy mutation stay behind explicit human-intent boundaries", () => {
  const nonApprovalServer = readTypeScriptFiles("src/server", ["approval.ts"]);
  expect(nonApprovalServer).not.toMatch(/\b(?:decideApproval|requestApproval|simulateApprovedMitigation)\s*\(/);

  const reviewBatch = readFileSync("evals/failure-discovery/review-batch.ts", "utf8");
  const taxonomyPromotion = readFileSync("evals/failure-discovery/taxonomy-promotion.ts", "utf8");
  expect(reviewBatch).not.toContain("taxonomy-promotion");
  expect(taxonomyPromotion).not.toContain("review-batch");
  expect(readTypeScriptFiles("src")).not.toMatch(/from ["']\.\.\/evals\/failure-discovery/);
});

function readTypeScriptFiles(directory: string, excludedNames: string[] = []): string {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !excludedNames.includes(entry.name))
    .map((entry) => readFileSync(join(directory, entry.name), "utf8"))
    .join("\n");
}
