import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { expect, expectTypeOf, test } from "vitest";

import * as artifactIo from "../evals/failure-discovery/artifact-io";
import * as failureDiscovery from "../evals/failure-discovery";
import * as reviewBatch from "../evals/failure-discovery/review-batch";
import * as schema from "../evals/failure-discovery/schema";
import * as taxonomyPromotion from "../evals/failure-discovery/taxonomy-promotion";
import * as inMemory from "../src/persistence/in-memory";
import * as persistence from "../src/persistence";
import * as postgres from "../src/persistence/postgres";
import * as recordMapping from "../src/persistence/record-mapping";
import * as serverComposition from "../src/server/composition";
import * as serverContracts from "../src/server/contracts";
import * as responseMapping from "../src/server/response-mapping";
import * as server from "../src/server";
import * as webhook from "../src/server/webhook";
import type * as FailureDiscoveryTypes from "../evals/failure-discovery";
import type * as PersistenceTypes from "../src/persistence";
import type * as ServerTypes from "../src/server";

export type PublicFacadeTypeContract = {
  persistence: [
    PersistenceTypes.CleanupResult,
    PersistenceTypes.EvidenceGateCandidate,
    PersistenceTypes.EvidenceGateDecisionRecord,
    PersistenceTypes.EvidenceGateDecisionWriteResult,
    PersistenceTypes.EvidenceSnapshotRecord,
    PersistenceTypes.GatedTriageRunWriteResult,
    PersistenceTypes.IncidentBaseline,
    PersistenceTypes.IncidentBaselineLookupOptions,
    PersistenceTypes.IncidentLifecycleReviewRecord,
    PersistenceTypes.OutcomeReviewCandidateInput,
    PersistenceTypes.OutcomeReviewCandidateRecord,
    PersistenceTypes.OutcomeReviewCandidateStatus,
    PersistenceTypes.PersistTriageRunOptions,
    PersistenceTypes.RecoveryBudgetRecord,
    PersistenceTypes.RecoveryEventRecord,
    PersistenceTypes.RecoveryEventType,
    PersistenceTypes.RecoveryFailureWriteInput,
    PersistenceTypes.RecoveryResetWriteInput,
    PersistenceTypes.RecoveryWriteResult,
    PersistenceTypes.ReplayKeyClaim,
    PersistenceTypes.ReplayKeyInput,
    PersistenceTypes.RetentionClass,
    PersistenceTypes.TriageRunPersistenceStore,
    PersistenceTypes.TriageRunRecord,
    PersistenceTypes.TriageRunReviewEnvelope,
    PersistenceTypes.TriageRunReviewRecord,
    PersistenceTypes.VerificationOutcomeRecord,
    PersistenceTypes.VerificationOutcomeWriteInput,
    PersistenceTypes.VerificationOutcomeWriteResult,
  ];
  server: [
    ServerTypes.LokiClientLike,
    ServerTypes.RunningWebhookServer,
    ServerTypes.WebhookRuntime,
    ServerTypes.WebhookServerOptions,
  ];
  failureDiscovery: [
    FailureDiscoveryTypes.CreateReviewBatchOptions,
    FailureDiscoveryTypes.FailureBatchManifest,
    FailureDiscoveryTypes.FailureFollowUpDisposition,
    FailureDiscoveryTypes.FailureModeEntry,
    FailureDiscoveryTypes.FailureModeReference,
    FailureDiscoveryTypes.FailureModeStatus,
    FailureDiscoveryTypes.FailureReviewDisposition,
    FailureDiscoveryTypes.FailureReviewRecord,
    FailureDiscoveryTypes.FailureRunRecord,
    FailureDiscoveryTypes.FailureTaxonomy,
    FailureDiscoveryTypes.FirstFailureAnchor,
    FailureDiscoveryTypes.ImportableOutcomeCandidate,
    FailureDiscoveryTypes.LoadedReviewBatch,
    FailureDiscoveryTypes.PromotedFailureCase,
    FailureDiscoveryTypes.PromoteCandidateOptions,
    FailureDiscoveryTypes.PromoteFailureModeOptions,
    FailureDiscoveryTypes.ReviewBatchPaths,
    FailureDiscoveryTypes.ReviewSourceKind,
  ];
};

test("compatibility facades retain public names and runtime identities", () => {
  expect(Object.keys(persistence).sort()).toEqual([
    "InMemoryTriageRunPersistenceStore",
    "PostgresTriageRunPersistenceStore",
    "buildReplayKey",
  ]);
  expect(persistence.InMemoryTriageRunPersistenceStore).toBe(inMemory.InMemoryTriageRunPersistenceStore);
  expect(persistence.PostgresTriageRunPersistenceStore).toBe(postgres.PostgresTriageRunPersistenceStore);
  expect(persistence.buildReplayKey).toBe(recordMapping.buildReplayKey);

  expect(Object.keys(server).sort()).toEqual([
    "handleGrafanaWebhook",
    "mitigationControlToResponse",
    "runToResponse",
    "startWebhookServer",
  ]);
  expect(server.startWebhookServer).toBe(serverComposition.startWebhookServer);
  expect(server.handleGrafanaWebhook).toBe(webhook.handleGrafanaWebhook);
  expect(server.runToResponse).toBe(responseMapping.runToResponse);
  expect(server.mitigationControlToResponse).toBe(responseMapping.mitigationControlToResponse);
  expectTypeOf<ServerTypes.WebhookRuntime>().toEqualTypeOf<serverContracts.WebhookRuntime>();

  const failureLeafExports = { ...artifactIo, ...reviewBatch, ...schema, ...taxonomyPromotion };
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
  for (const [name, value] of Object.entries(failureDiscovery)) {
    expect(failureLeafExports[name as keyof typeof failureLeafExports], name).toBe(value);
  }
});

test("facades remain export-only and leaf modules do not import them", () => {
  for (const path of ["src/persistence/index.ts", "src/server.ts", "evals/failure-discovery.ts"]) {
    expect(readFileSync(path, "utf8"), path).not.toMatch(/^(?:export )?(?:async )?(?:class|function|const|let) /m);
  }

  expect(importViolations("src/persistence", (path, moduleName) =>
    path !== "src/persistence/index.ts" && ["./index", "../persistence"].includes(moduleName)
  )).toEqual([]);
  expect(importViolations("src/server", (path, moduleName) =>
    path !== "src/server.ts" && moduleName === "../server"
  )).toEqual([]);
  expect(importViolations("evals/failure-discovery", (path, moduleName) =>
    path !== "evals/failure-discovery.ts" && moduleName === "../failure-discovery"
  )).toEqual([]);
});

test("server handlers depend inward and mutation authority stays explicit", () => {
  const routeModules = new Set(["approval", "webhook", "run-review", "lifecycle"]);
  const siblingImports = importViolations("src/server", (path, moduleName) => {
    if (path === "src/server/composition.ts" || !moduleName.startsWith("./")) {
      return false;
    }
    const importer = path.split("/").at(-1)?.replace(/\.ts$/, "");
    const imported = moduleName.slice(2);
    return routeModules.has(importer ?? "") && routeModules.has(imported) && importer !== imported;
  });
  expect(siblingImports).toEqual([]);

  const approvalMutationImports = importedNames("src/server")
    .filter(({ path, moduleName, imported }) =>
      (
        moduleName === "../approval-store"
        && imported === "decideApproval"
        && path !== "src/server/approval.ts"
      )
      || (
        moduleName === "../approval-store"
        && imported === "requestApproval"
        && !["src/server/approval.ts", "src/server/approval-support.ts"].includes(path)
      )
      || (
        moduleName === "../mitigation-executor"
        && imported === "simulateApprovedMitigation"
        && path !== "src/server/approval.ts"
      )
    );
  expect(approvalMutationImports).toEqual([]);

  const reviewBatchSource = readFileSync("evals/failure-discovery/review-batch.ts", "utf8");
  const taxonomyPromotionSource = readFileSync("evals/failure-discovery/taxonomy-promotion.ts", "utf8");
  expect(reviewBatchSource).not.toContain("taxonomy-promotion");
  expect(taxonomyPromotionSource).not.toContain("review-batch");
  expect(importViolations("src", (_path, moduleName) => moduleName.includes("evals/failure-discovery"))).toEqual([]);
});

function importViolations(
  directory: string,
  violates: (path: string, moduleName: string) => boolean,
): string[] {
  return sourceFiles(directory).flatMap(({ path, sourceFile }) =>
    sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return [];
      }
      const moduleName = statement.moduleSpecifier.text;
      return violates(path, moduleName) ? [`${path} -> ${moduleName}`] : [];
    })
  );
}

function importedNames(directory: string): Array<{ path: string; moduleName: string; imported: string }> {
  return sourceFiles(directory).flatMap(({ path, sourceFile }) =>
    sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return [];
      }
      const moduleName = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        return [];
      }
      return bindings.elements.map((element) => ({
        path,
        moduleName,
        imported: element.propertyName?.text ?? element.name.text,
      }));
    })
  );
}

function sourceFiles(directory: string): Array<{ path: string; sourceFile: ts.SourceFile }> {
  return typeScriptPaths(directory).map((path) => ({
    path,
    sourceFile: ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true),
  }));
}

function typeScriptPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typeScriptPaths(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative(".", path)] : [];
  });
}
