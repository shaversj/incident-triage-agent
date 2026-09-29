import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const failureDiscoverySchemaVersion = 1 as const;
export const defaultFailureReviewRoot = ".triage/failure-reviews";

export type ReviewSourceKind = "mock" | "recorded" | "live";
export type FailureReviewDisposition = "pending" | "acceptable" | "failed";
export type FailureFollowUpDisposition = "none" | "candidate" | "categorized" | "protect";

export interface FailureBatchManifest {
  schemaVersion: typeof failureDiscoverySchemaVersion;
  batchId: string;
  changeLabel: string;
  requestedSize: number;
  generatedAt: string;
  repositoryRevision: string;
  repositoryDirty: boolean;
  status: "in_progress" | "complete";
  runIds: string[];
}

export interface FailureRunRecord {
  schemaVersion: typeof failureDiscoverySchemaVersion;
  runId: string;
  caseId: string;
  sourceKind: ReviewSourceKind;
  scenarioName: string;
  mode: "mock" | "live";
  generatedAt: string;
  fingerprint: string;
  outcome: Record<string, unknown>;
}

export interface FirstFailureAnchor {
  phase: string;
  stepId?: string;
  evidenceIds: string[];
  rationale: string;
}

export interface FailureModeReference {
  id: string;
  revision: number;
}

export interface FailureReviewRecord {
  schemaVersion: typeof failureDiscoverySchemaVersion;
  reviewId: string;
  runId: string;
  disposition: FailureReviewDisposition;
  observation?: string;
  firstFailure?: FirstFailureAnchor;
  downstreamEffects: string[];
  independentFindings: string[];
  failureMode?: FailureModeReference;
  followUpDisposition?: FailureFollowUpDisposition;
}

export interface CreateReviewBatchOptions {
  batchId: string;
  changeLabel: string;
  requestedSize: number;
  repositoryRevision: string;
  repositoryDirty: boolean;
  generatedAt?: string;
}

export interface ReviewBatchPaths {
  directory: string;
  manifest: string;
  runs: string;
  reviews: string;
  summary: string;
}

export function reviewPaths(root: string, batchId: string): ReviewBatchPaths {
  const directory = join(root, batchId);
  return {
    directory,
    manifest: join(directory, "manifest.json"),
    runs: join(directory, "runs"),
    reviews: join(directory, "reviews"),
    summary: join(directory, "summary.md"),
  };
}

export function createReviewBatch(root: string, options: CreateReviewBatchOptions): FailureBatchManifest {
  if (!options.batchId.trim()) {
    throw new Error("batch_id must be a non-empty string.");
  }
  if (!options.changeLabel.trim()) {
    throw new Error("change_label must be a non-empty string.");
  }
  if (!Number.isInteger(options.requestedSize) || options.requestedSize < 1) {
    throw new Error("requested_size must be a positive integer.");
  }
  const paths = reviewPaths(root, options.batchId);
  if (existsSync(paths.directory)) {
    throw new Error(`Review batch already exists: ${options.batchId}.`);
  }
  mkdirSync(paths.runs, { recursive: true });
  mkdirSync(paths.reviews, { recursive: true });
  const manifest: FailureBatchManifest = {
    schemaVersion: failureDiscoverySchemaVersion,
    batchId: options.batchId,
    changeLabel: options.changeLabel,
    requestedSize: options.requestedSize,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    repositoryRevision: options.repositoryRevision,
    repositoryDirty: options.repositoryDirty,
    status: "in_progress",
    runIds: [],
  };
  writeJsonAtomic(paths.manifest, manifest);
  return manifest;
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
  return parseReviewRecord(readJson(path));
}

export function saveReviewRecord(path: string, record: FailureReviewRecord): void {
  writeJsonAtomic(path, record);
}

export function validateReviewRecord(review: FailureReviewRecord, run: FailureRunRecord): string[] {
  const errors: string[] = [];
  if (review.runId !== run.runId) {
    errors.push(`review run_id ${review.runId} does not match run ${run.runId}.`);
  }
  if (review.disposition === "pending") {
    return errors;
  }
  if (review.disposition === "acceptable") {
    if (review.firstFailure) {
      errors.push("acceptable reviews must not include first_failure.");
    }
    if (review.failureMode) {
      errors.push("acceptable reviews must not include failure_mode.");
    }
    if (review.followUpDisposition && review.followUpDisposition !== "none") {
      errors.push("acceptable reviews must use follow_up_disposition none.");
    }
    return errors;
  }
  if (!review.firstFailure) {
    errors.push("failed reviews must include first_failure.");
    return errors;
  }

  const phase = review.firstFailure.phase.trim();
  if (!phase) {
    errors.push("first_failure.phase must be a non-empty string.");
  } else if (!outcomeStates(run).has(phase)) {
    errors.push(`first_failure.phase references unknown state ${phase}.`);
  }
  if (!review.firstFailure.rationale.trim()) {
    errors.push("first_failure.rationale must be a non-empty string.");
  }
  if (review.firstFailure.stepId && !investigationStepIds(run).has(review.firstFailure.stepId)) {
    errors.push(`first_failure.step_id references unknown investigation step ${review.firstFailure.stepId}.`);
  }
  const evidenceIds = outcomeEvidenceIds(run);
  for (const evidenceId of review.firstFailure.evidenceIds) {
    if (!evidenceIds.has(evidenceId)) {
      errors.push(`first_failure.evidence_ids references unknown evidence ${evidenceId}.`);
    }
  }
  if (!review.followUpDisposition) {
    errors.push("failed reviews must include follow_up_disposition.");
  }
  if (review.failureMode && review.followUpDisposition === "candidate") {
    errors.push("candidate reviews must not assign failure_mode.");
  }
  if (!review.failureMode && (review.followUpDisposition === "categorized" || review.followUpDisposition === "protect")) {
    errors.push(`${review.followUpDisposition} reviews must assign failure_mode.`);
  }
  return errors;
}

export function fingerprintJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
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

function parseBatchManifest(payload: unknown): FailureBatchManifest {
  const record = readRecord(payload, "batch manifest");
  readSchemaVersion(record);
  const status = record.status;
  if (status !== "in_progress" && status !== "complete") {
    throw new Error("status must be in_progress or complete.");
  }
  return {
    schemaVersion: failureDiscoverySchemaVersion,
    batchId: readString(record.batchId ?? record.batch_id, "batch_id"),
    changeLabel: readString(record.changeLabel ?? record.change_label, "change_label"),
    requestedSize: readPositiveInteger(record.requestedSize ?? record.requested_size, "requested_size"),
    generatedAt: readString(record.generatedAt ?? record.generated_at, "generated_at"),
    repositoryRevision: readString(record.repositoryRevision ?? record.repository_revision, "repository_revision"),
    repositoryDirty: readBoolean(record.repositoryDirty ?? record.repository_dirty, "repository_dirty"),
    status,
    runIds: readStringArray(record.runIds ?? record.run_ids, "run_ids"),
  };
}

function parseRunRecord(payload: unknown): FailureRunRecord {
  const record = readRecord(payload, "run record");
  readSchemaVersion(record);
  const sourceKind = record.sourceKind ?? record.source_kind;
  if (sourceKind !== "mock" && sourceKind !== "recorded" && sourceKind !== "live") {
    throw new Error("source_kind must be mock, recorded, or live.");
  }
  const mode = record.mode;
  if (mode !== "mock" && mode !== "live") {
    throw new Error("mode must be mock or live.");
  }
  return {
    schemaVersion: failureDiscoverySchemaVersion,
    runId: readString(record.runId ?? record.run_id, "run_id"),
    caseId: readString(record.caseId ?? record.case_id, "case_id"),
    sourceKind,
    scenarioName: readString(record.scenarioName ?? record.scenario_name, "scenario_name"),
    mode,
    generatedAt: readString(record.generatedAt ?? record.generated_at, "generated_at"),
    fingerprint: readString(record.fingerprint, "fingerprint"),
    outcome: readRecord(record.outcome, "outcome"),
  };
}

function parseReviewRecord(payload: unknown): FailureReviewRecord {
  const record = readRecord(payload, "review record");
  readSchemaVersion(record);
  const disposition = record.disposition;
  if (disposition !== "pending" && disposition !== "acceptable" && disposition !== "failed") {
    throw new Error("disposition must be pending, acceptable, or failed.");
  }
  const review: FailureReviewRecord = {
    schemaVersion: failureDiscoverySchemaVersion,
    reviewId: readString(record.reviewId ?? record.review_id, "review_id"),
    runId: readString(record.runId ?? record.run_id, "run_id"),
    disposition,
    downstreamEffects: readStringArray(record.downstreamEffects ?? record.downstream_effects ?? [], "downstream_effects"),
    independentFindings: readStringArray(record.independentFindings ?? record.independent_findings ?? [], "independent_findings"),
  };
  const observation = optionalString(record.observation, "observation");
  if (observation !== undefined) {
    review.observation = observation;
  }
  const firstFailure = record.firstFailure ?? record.first_failure;
  if (firstFailure !== undefined) {
    review.firstFailure = parseFirstFailure(firstFailure);
  }
  const failureMode = record.failureMode ?? record.failure_mode;
  if (failureMode !== undefined) {
    const modeRecord = readRecord(failureMode, "failure_mode");
    review.failureMode = {
      id: readString(modeRecord.id, "failure_mode.id"),
      revision: readPositiveInteger(modeRecord.revision, "failure_mode.revision"),
    };
  }
  const followUp = record.followUpDisposition ?? record.follow_up_disposition;
  if (followUp !== undefined) {
    if (followUp !== "none" && followUp !== "candidate" && followUp !== "categorized" && followUp !== "protect") {
      throw new Error("follow_up_disposition is unsupported.");
    }
    review.followUpDisposition = followUp;
  }
  return review;
}

function parseFirstFailure(payload: unknown): FirstFailureAnchor {
  const record = readRecord(payload, "first_failure");
  const anchor: FirstFailureAnchor = {
    phase: readStringAllowEmpty(record.phase, "first_failure.phase"),
    evidenceIds: readStringArray(record.evidenceIds ?? record.evidence_ids, "first_failure.evidence_ids"),
    rationale: readStringAllowEmpty(record.rationale, "first_failure.rationale"),
  };
  const stepId = optionalString(record.stepId ?? record.step_id, "first_failure.step_id");
  if (stepId !== undefined) {
    anchor.stepId = stepId;
  }
  return anchor;
}

function outcomeStates(run: FailureRunRecord): Set<string> {
  const states = run.outcome.states;
  return new Set(Array.isArray(states) ? states.filter((value): value is string => typeof value === "string") : []);
}

function investigationStepIds(run: FailureRunRecord): Set<string> {
  const investigation = objectValue(run.outcome.investigation);
  const steps = Array.isArray(investigation.steps) ? investigation.steps : [];
  return new Set(steps.map((step) => objectValue(step).id).filter((id): id is string => typeof id === "string"));
}

function outcomeEvidenceIds(run: FailureRunRecord): Set<string> {
  const evidence = Array.isArray(run.outcome.evidence) ? run.outcome.evidence : [];
  return new Set(evidence
    .map((item) => {
      const record = objectValue(item);
      return record.evidence_id ?? record.id;
    })
    .filter((id): id is string => typeof id === "string"));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readSchemaVersion(record: Record<string, unknown>): void {
  const value = record.schemaVersion ?? record.schema_version;
  if (value !== failureDiscoverySchemaVersion) {
    throw new Error(`schema_version must equal ${failureDiscoverySchemaVersion}.`);
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} must be a non-empty string.`);
}

function readStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${label} must be a string.`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, label);
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`${label} must be a positive integer.`);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${label} must be a boolean.`);
}
