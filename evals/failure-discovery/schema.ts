import { createHash } from "node:crypto";

export const failureDiscoverySchemaVersion = 1 as const;

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

export type FailureModeReference = Pick<FailureModeEntry, "id" | "revision">;

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

export interface LoadedReviewBatch {
  manifest: FailureBatchManifest;
  runs: FailureRunRecord[];
  reviews: FailureReviewRecord[];
}

export type FailureModeStatus = "active" | "retired";

export interface FailureModeEntry {
  id: string;
  name: string;
  revision: number;
  status: FailureModeStatus;
  definition: string;
  distinguishingNotes: string;
  sourceCaseIds: string[];
}

export interface FailureTaxonomy {
  schemaVersion: typeof failureDiscoverySchemaVersion;
  modes: FailureModeEntry[];
}

export interface PromotedFailureCase {
  schemaVersion: typeof failureDiscoverySchemaVersion;
  caseId: string;
  sourceBatchId: string;
  sourceRunId: string;
  sourceReviewId: string;
  sourceCaseId: string;
  sourceKind: ReviewSourceKind;
  scenarioName: string;
  fingerprint: string;
  observation?: string;
  firstFailure: FirstFailureAnchor;
  downstreamEffects: string[];
  independentFindings: string[];
  failureMode?: FailureModeReference;
  outcome: Record<string, unknown>;
}

export interface PromoteCandidateOptions {
  batch: LoadedReviewBatch;
  runId: string;
  caseDirectory: string;
}

export interface PromoteFailureModeOptions {
  batch: LoadedReviewBatch;
  runIds: string[];
  taxonomyPath: string;
  caseDirectory: string;
  modeId: string;
  name: string;
  definition: string;
  distinguishingNotes: string;
}

export interface ImportableOutcomeCandidate {
  candidateId: string;
  incidentId: string;
  runId?: string;
  category: string;
  rationale: string;
  evidenceIds: string[];
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export function parseBatchManifest(payload: unknown): FailureBatchManifest {
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

export function parseRunRecord(payload: unknown): FailureRunRecord {
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

export function parseFailureReviewRecord(payload: unknown): FailureReviewRecord {
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
  if (observation !== undefined) review.observation = observation;
  const firstFailure = record.firstFailure ?? record.first_failure;
  if (firstFailure !== undefined) review.firstFailure = parseFirstFailure(firstFailure);
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

export function parseFailureModeEntry(payload: unknown): FailureModeEntry {
  const record = readRecord(payload, "failure mode");
  const status = record.status;
  if (status !== "active" && status !== "retired") {
    throw new Error("failure mode status must be active or retired.");
  }
  return {
    id: readString(record.id, "failure mode id"),
    name: readString(record.name, "failure mode name"),
    revision: readPositiveInteger(record.revision, "failure mode revision"),
    status,
    definition: readString(record.definition, "failure mode definition"),
    distinguishingNotes: readString(record.distinguishingNotes ?? record.distinguishing_notes, "failure mode distinguishing_notes"),
    sourceCaseIds: readStringArray(record.sourceCaseIds ?? record.source_case_ids, "failure mode source_case_ids"),
  };
}

export function parseFailureTaxonomy(payload: unknown): FailureTaxonomy {
  const record = readRecord(payload, "failure taxonomy");
  readSchemaVersion(record);
  if (!Array.isArray(record.modes)) {
    throw new Error("failure taxonomy modes must be an array.");
  }
  return {
    schemaVersion: failureDiscoverySchemaVersion,
    modes: record.modes.map(parseFailureModeEntry),
  };
}

export function parsePromotedFailureCase(payload: unknown): PromotedFailureCase {
  const record = readRecord(payload, "promoted failure case");
  readSchemaVersion(record);
  const sourceKind = record.sourceKind ?? record.source_kind;
  if (sourceKind !== "mock" && sourceKind !== "recorded" && sourceKind !== "live") {
    throw new Error("promoted case source_kind is unsupported.");
  }
  const snapshot: PromotedFailureCase = {
    schemaVersion: failureDiscoverySchemaVersion,
    caseId: readString(record.caseId ?? record.case_id, "case_id"),
    sourceBatchId: readString(record.sourceBatchId ?? record.source_batch_id, "source_batch_id"),
    sourceRunId: readString(record.sourceRunId ?? record.source_run_id, "source_run_id"),
    sourceReviewId: readString(record.sourceReviewId ?? record.source_review_id, "source_review_id"),
    sourceCaseId: readString(record.sourceCaseId ?? record.source_case_id, "source_case_id"),
    sourceKind,
    scenarioName: readString(record.scenarioName ?? record.scenario_name, "scenario_name"),
    fingerprint: readString(record.fingerprint, "fingerprint"),
    firstFailure: parseFirstFailure(record.firstFailure ?? record.first_failure),
    downstreamEffects: readStringArray(record.downstreamEffects ?? record.downstream_effects, "downstream_effects"),
    independentFindings: readStringArray(record.independentFindings ?? record.independent_findings, "independent_findings"),
    outcome: readRecord(record.outcome, "outcome"),
  };
  const observation = optionalString(record.observation, "observation");
  if (observation !== undefined) snapshot.observation = observation;
  const failureMode = record.failureMode ?? record.failure_mode;
  if (failureMode !== undefined) {
    const mode = readRecord(failureMode, "failure_mode");
    snapshot.failureMode = {
      id: readString(mode.id, "failure_mode.id"),
      revision: readPositiveInteger(mode.revision, "failure_mode.revision"),
    };
  }
  return snapshot;
}

export function validateReviewBatch(batch: LoadedReviewBatch, taxonomy?: FailureTaxonomy): string[] {
  const errors: string[] = [];
  if (batch.manifest.status !== "complete") errors.push("batch generation is not complete.");
  if (batch.manifest.runIds.length !== batch.manifest.requestedSize) {
    errors.push(`batch contains ${batch.manifest.runIds.length} run(s), expected ${batch.manifest.requestedSize}.`);
  }
  const runById = new Map(batch.runs.map((run) => [run.runId, run]));
  const reviewByRunId = new Map(batch.reviews.map((review) => [review.runId, review]));
  const pending = batch.reviews.filter((review) => review.disposition === "pending").length;
  if (pending > 0) errors.push(`${pending} review(s) are still pending.`);
  for (const runId of batch.manifest.runIds) {
    const run = runById.get(runId);
    const review = reviewByRunId.get(runId);
    if (!run) {
      errors.push(`manifest references missing run ${runId}.`);
      continue;
    }
    if (!review) {
      errors.push(`manifest references missing review for ${runId}.`);
      continue;
    }
    for (const error of validateReviewRecord(review, run)) errors.push(`${runId}: ${error}`);
    if (review.failureMode && taxonomy && !findFailureMode(taxonomy, review.failureMode.id, review.failureMode.revision)) {
      errors.push(`${runId}: failure_mode references unknown mode ${review.failureMode.id} revision ${review.failureMode.revision}.`);
    }
  }
  return errors;
}

export function validateReviewRecord(review: FailureReviewRecord, run: FailureRunRecord): string[] {
  const errors: string[] = [];
  if (review.runId !== run.runId) errors.push(`review run_id ${review.runId} does not match run ${run.runId}.`);
  if (review.disposition === "pending") return errors;
  if (review.disposition === "acceptable") {
    if (review.firstFailure) errors.push("acceptable reviews must not include first_failure.");
    if (review.failureMode) errors.push("acceptable reviews must not include failure_mode.");
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
  if (!phase) errors.push("first_failure.phase must be a non-empty string.");
  else if (!outcomeStates(run).has(phase)) errors.push(`first_failure.phase references unknown state ${phase}.`);
  if (!review.firstFailure.rationale.trim()) errors.push("first_failure.rationale must be a non-empty string.");
  if (review.firstFailure.stepId && !investigationStepIds(run).has(review.firstFailure.stepId)) {
    errors.push(`first_failure.step_id references unknown investigation step ${review.firstFailure.stepId}.`);
  }
  const evidenceIds = outcomeEvidenceIds(run);
  for (const evidenceId of review.firstFailure.evidenceIds) {
    if (!evidenceIds.has(evidenceId)) errors.push(`first_failure.evidence_ids references unknown evidence ${evidenceId}.`);
  }
  if (!review.followUpDisposition) errors.push("failed reviews must include follow_up_disposition.");
  if (review.failureMode && review.followUpDisposition === "candidate") {
    errors.push("candidate reviews must not assign failure_mode.");
  }
  if (!review.failureMode && (review.followUpDisposition === "categorized" || review.followUpDisposition === "protect")) {
    errors.push(`${review.followUpDisposition} reviews must assign failure_mode.`);
  }
  return errors;
}

export function findFailureMode(taxonomy: FailureTaxonomy, modeId: string, revision: number): FailureModeEntry | undefined {
  return taxonomy.modes.find((mode) => mode.id === modeId && mode.revision === revision);
}

export function latestFailureMode(taxonomy: FailureTaxonomy, modeId: string): FailureModeEntry | undefined {
  return taxonomy.modes.filter((mode) => mode.id === modeId).sort((left, right) => right.revision - left.revision)[0];
}

export function fingerprintJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function parseFirstFailure(payload: unknown): FirstFailureAnchor {
  const record = readRecord(payload, "first_failure");
  const anchor: FirstFailureAnchor = {
    phase: readStringAllowEmpty(record.phase, "first_failure.phase"),
    evidenceIds: readStringArray(record.evidenceIds ?? record.evidence_ids, "first_failure.evidence_ids"),
    rationale: readStringAllowEmpty(record.rationale, "first_failure.rationale"),
  };
  const stepId = optionalString(record.stepId ?? record.step_id, "first_failure.step_id");
  if (stepId !== undefined) anchor.stepId = stepId;
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
  return new Set(evidence.map((item) => {
    const record = objectValue(item);
    return record.evidence_id ?? record.id;
  }).filter((id): id is string => typeof id === "string"));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function readSchemaVersion(record: Record<string, unknown>): void {
  const value = record.schemaVersion ?? record.schema_version;
  if (value !== failureDiscoverySchemaVersion) throw new Error(`schema_version must equal ${failureDiscoverySchemaVersion}.`);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} must be a non-empty string.`);
}

function readStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${label} must be a string.`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, label);
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${label} must be a positive integer.`);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${label} must be a boolean.`);
}
