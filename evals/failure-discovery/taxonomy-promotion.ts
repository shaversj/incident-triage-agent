import {
  artifactExists,
  loadFailureTaxonomy,
  loadPromotedCase,
  loadPromotedCaseFromDirectory,
  promotedCasePath,
  saveFailureTaxonomy,
  writeJsonAtomic,
} from "./artifact-io";
import {
  canonicalJson,
  failureDiscoverySchemaVersion,
  fingerprintJson,
  latestFailureMode,
  requiredText,
  validateReviewRecord,
  type FailureModeEntry,
  type FailureModeReference,
  type FailureReviewRecord,
  type FailureRunRecord,
  type LoadedReviewBatch,
  type PromoteCandidateOptions,
  type PromotedFailureCase,
  type PromoteFailureModeOptions,
} from "./schema";

export function promoteCandidateObservation(options: PromoteCandidateOptions): PromotedFailureCase {
  const source = reviewedSource(options.batch, options.runId);
  const snapshot = promotedSnapshot(options.batch.manifest.batchId, source.run, source.review);
  savePromotedCase(options.caseDirectory, snapshot);
  return snapshot;
}

export function promoteFailureMode(
  options: PromoteFailureModeOptions,
): { mode: FailureModeEntry; cases: PromotedFailureCase[] } {
  const distinctRunIds = [...new Set(options.runIds)];
  if (distinctRunIds.length < 2) {
    throw new Error("Activating a named failure mode requires at least two source reviews.");
  }
  const modeId = requiredText(options.modeId, "mode_id");
  const taxonomy = loadFailureTaxonomy(options.taxonomyPath);
  if (taxonomy.modes.some((mode) => mode.id === modeId)) {
    throw new Error(`Failure mode ${modeId} already exists; revise it instead.`);
  }
  const mode: FailureModeEntry = {
    id: modeId,
    name: requiredText(options.name, "name"),
    revision: 1,
    status: "active",
    definition: requiredText(options.definition, "definition"),
    distinguishingNotes: requiredText(options.distinguishingNotes, "distinguishing_notes"),
    sourceCaseIds: [],
  };
  const cases = distinctRunIds.map((runId) => {
    const source = reviewedSource(options.batch, runId);
    if (source.review.failureMode && source.review.failureMode.id !== modeId) {
      throw new Error(`Review ${source.review.reviewId} already names failure mode ${source.review.failureMode.id}.`);
    }
    return promotedSnapshot(
      options.batch.manifest.batchId,
      source.run,
      source.review,
      { id: modeId, revision: 1 },
    );
  });
  mode.sourceCaseIds = cases.map((item) => item.caseId);
  for (const snapshot of cases) savePromotedCase(options.caseDirectory, snapshot);
  saveFailureTaxonomy(options.taxonomyPath, {
    ...taxonomy,
    modes: [...taxonomy.modes, mode],
  });
  return { mode, cases };
}

export function reviseFailureMode(
  taxonomyPath: string,
  details: {
    modeId: string;
    name?: string;
    definition: string;
    distinguishingNotes: string;
    sourceCaseIds: string[];
    caseDirectory: string;
  },
): FailureModeEntry {
  const taxonomy = loadFailureTaxonomy(taxonomyPath);
  const latest = latestFailureMode(taxonomy, details.modeId);
  if (!latest) throw new Error(`Unknown failure mode ${details.modeId}.`);
  const sourceCaseIds = [...new Set(details.sourceCaseIds)];
  if (sourceCaseIds.length < 2) {
    throw new Error("An active failure mode revision requires at least two source cases.");
  }
  for (const sourceCaseId of sourceCaseIds) {
    const snapshot = loadPromotedCaseFromDirectory(details.caseDirectory, sourceCaseId);
    if (snapshot.failureMode && snapshot.failureMode.id !== details.modeId) {
      throw new Error(`Source case ${sourceCaseId} belongs to failure mode ${snapshot.failureMode.id}.`);
    }
  }
  const revision: FailureModeEntry = {
    id: latest.id,
    name: details.name === undefined ? latest.name : requiredText(details.name, "name"),
    revision: latest.revision + 1,
    status: "active",
    definition: requiredText(details.definition, "definition"),
    distinguishingNotes: requiredText(details.distinguishingNotes, "distinguishing_notes"),
    sourceCaseIds,
  };
  saveFailureTaxonomy(taxonomyPath, { ...taxonomy, modes: [...taxonomy.modes, revision] });
  return revision;
}

export function retireFailureMode(taxonomyPath: string, modeId: string): FailureModeEntry {
  const taxonomy = loadFailureTaxonomy(taxonomyPath);
  const latest = latestFailureMode(taxonomy, modeId);
  if (!latest) throw new Error(`Unknown failure mode ${modeId}.`);
  const retired: FailureModeEntry = {
    ...latest,
    revision: latest.revision + 1,
    status: "retired",
  };
  saveFailureTaxonomy(taxonomyPath, { ...taxonomy, modes: [...taxonomy.modes, retired] });
  return retired;
}

function reviewedSource(
  batch: LoadedReviewBatch,
  runId: string,
): { run: FailureRunRecord; review: FailureReviewRecord } {
  const run = batch.runs.find((item) => item.runId === runId);
  const review = batch.reviews.find((item) => item.runId === runId);
  if (!run || !review) throw new Error(`Batch does not contain run and review ${runId}.`);
  const errors = validateReviewRecord(review, run);
  if (errors.length > 0) throw new Error(`Review ${review.reviewId} is invalid: ${errors.join(" ")}`);
  if (review.disposition !== "failed" || !review.firstFailure) {
    throw new Error(`Review ${review.reviewId} must record a failed disposition before promotion.`);
  }
  rejectCredentialKeys(run.outcome);
  return { run, review };
}

function promotedSnapshot(
  batchId: string,
  run: FailureRunRecord,
  review: FailureReviewRecord,
  failureMode?: FailureModeReference,
): PromotedFailureCase {
  if (!review.firstFailure) throw new Error(`Review ${review.reviewId} does not have a first failure.`);
  const seed = {
    sourceBatchId: batchId,
    sourceRunId: run.runId,
    sourceReviewId: review.reviewId,
    firstFailure: review.firstFailure,
  };
  const snapshot: PromotedFailureCase = {
    schemaVersion: failureDiscoverySchemaVersion,
    caseId: `failure-case-${fingerprintJson(seed).slice(0, 16)}`,
    sourceBatchId: batchId,
    sourceRunId: run.runId,
    sourceReviewId: review.reviewId,
    sourceCaseId: run.caseId,
    sourceKind: run.sourceKind,
    scenarioName: run.scenarioName,
    fingerprint: run.fingerprint,
    firstFailure: review.firstFailure,
    downstreamEffects: [...review.downstreamEffects],
    independentFindings: [...review.independentFindings],
    outcome: allowlistedOutcome(run.outcome),
  };
  if (review.observation !== undefined) snapshot.observation = review.observation;
  if (failureMode) snapshot.failureMode = failureMode;
  return snapshot;
}

function savePromotedCase(caseDirectory: string, snapshot: PromotedFailureCase): void {
  const path = promotedCasePath(caseDirectory, snapshot.caseId);
  if (artifactExists(path)) {
    const existing = loadPromotedCase(path);
    if (canonicalJson(existing) !== canonicalJson(snapshot)) {
      throw new Error(`Promoted case ${snapshot.caseId} is immutable and already differs on disk.`);
    }
    return;
  }
  writeJsonAtomic(path, snapshot);
}

function allowlistedOutcome(outcome: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "status",
    "run_id",
    "run_status",
    "incident",
    "scenario",
    "states",
    "investigation",
    "validation",
    "explanation_validation",
    "analysis",
    "finding_summary",
    "recommendation",
    "decision",
    "evidence",
    "provenance",
    "safety",
    "mitigation_control",
    "scorecard",
    "trigger",
    "parent_run_id",
    "gate_decision_id",
    "materiality",
    "gate_decision",
    "recent_gate_decisions",
    "recorded_input",
    "recorded_status_code",
  ];
  return Object.fromEntries(allowed
    .filter((key) => outcome[key] !== undefined)
    .map((key) => [key, JSON.parse(JSON.stringify(outcome[key])) as unknown]));
}

function rejectCredentialKeys(value: unknown, path = "outcome"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCredentialKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|authorization|cookie)$/i.test(key)) {
      throw new Error(`Promotion rejected credential-bearing key ${key} at ${path}.`);
    }
    rejectCredentialKeys(item, `${path}.${key}`);
  }
}
