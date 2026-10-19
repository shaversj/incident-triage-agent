import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  failureDiscoverySchemaVersion,
  parseBatchManifest,
  parseFailureModeEntry,
  parseFailureReviewRecord,
  parseFailureTaxonomy,
  parsePromotedFailureCase,
  parseRunRecord,
  type FailureBatchManifest,
  type FailureReviewRecord,
  type FailureRunRecord,
  type FailureTaxonomy,
  type PromotedFailureCase,
  type ReviewBatchPaths,
} from "./schema";

export const defaultFailureReviewRoot = ".triage/failure-reviews";

export function reviewPaths(root: string, batchId: string): ReviewBatchPaths {
  assertSafeBatchId(batchId);
  const directory = join(root, batchId);
  return {
    directory,
    manifest: join(directory, "manifest.json"),
    runs: join(directory, "runs"),
    reviews: join(directory, "reviews"),
    summary: join(directory, "summary.md"),
  };
}

export function createReviewBatchWorkspace(paths: ReviewBatchPaths, batchId: string): void {
  if (existsSync(paths.directory)) {
    throw new Error(`Review batch already exists: ${batchId}.`);
  }
  mkdirSync(paths.runs, { recursive: true });
  mkdirSync(paths.reviews, { recursive: true });
}

export function reviewArtifactPath(directory: string, id: string): string {
  return join(directory, `${encodeURIComponent(id)}.json`);
}

export function loadBatchManifest(path: string): FailureBatchManifest {
  return parseBatchManifest(readJson(path));
}

export function saveBatchManifest(path: string, manifest: FailureBatchManifest): void {
  writeJsonAtomic(path, parseBatchManifest(manifest));
}

export function loadRunRecord(path: string): FailureRunRecord {
  return parseRunRecord(readJson(path));
}

export function saveRunRecord(path: string, record: FailureRunRecord): void {
  writeJsonAtomic(path, parseRunRecord(record));
}

export function loadReviewRecord(path: string): FailureReviewRecord {
  return parseFailureReviewRecord(readJson(path));
}

export function saveReviewRecord(path: string, record: FailureReviewRecord): void {
  writeJsonAtomic(path, record);
}

export function loadFailureTaxonomy(path: string): FailureTaxonomy {
  if (!existsSync(path)) {
    return { schemaVersion: failureDiscoverySchemaVersion, modes: [] };
  }
  return parseFailureTaxonomy(readJson(path));
}

export function saveFailureTaxonomy(path: string, taxonomy: FailureTaxonomy): void {
  writeJsonAtomic(path, {
    schemaVersion: failureDiscoverySchemaVersion,
    modes: taxonomy.modes.map(parseFailureModeEntry),
  });
}

export function loadPromotedCase(path: string): PromotedFailureCase {
  return parsePromotedFailureCase(readJson(path));
}

export function loadPromotedCaseFromDirectory(
  caseDirectory: string,
  caseId: string,
): PromotedFailureCase {
  return loadPromotedCase(promotedCasePath(caseDirectory, caseId));
}

export function promotedCasePath(caseDirectory: string, caseId: string): string {
  return join(caseDirectory, `${caseId}.json`);
}

export function artifactExists(path: string): boolean {
  return existsSync(path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function assertSafeBatchId(batchId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batchId) || batchId === "." || batchId === "..") {
    throw new Error("batch_id must be a path-safe identifier using letters, numbers, dots, underscores, or hyphens.");
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
