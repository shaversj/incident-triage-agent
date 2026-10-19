import {
  createReviewBatchWorkspace,
  loadBatchManifest,
  loadReviewRecord,
  loadRunRecord,
  reviewArtifactPath,
  reviewPaths,
  saveBatchManifest,
  saveReviewRecord,
  saveRunRecord,
} from "./artifact-io";
import {
  failureDiscoverySchemaVersion,
  fingerprintJson,
  type CreateReviewBatchOptions,
  type FailureBatchManifest,
  type FailureReviewRecord,
  type FailureRunRecord,
  type ImportableOutcomeCandidate,
  type LoadedReviewBatch,
} from "./schema";

export function outcomeCandidateToFailureRun(candidate: ImportableOutcomeCandidate): FailureRunRecord {
  const outcome: Record<string, unknown> = {
    status: "runtime_outcome_candidate",
    run_id: candidate.runId ?? `candidate:${candidate.candidateId}`,
    run_status: "recoverable_failure",
    incident_id: candidate.incidentId,
    category: candidate.category,
    rationale: candidate.rationale,
    evidence: candidate.evidenceIds.map((evidenceId) => ({ evidence_id: evidenceId })),
    snapshot: candidate.snapshot,
    states: ["outcome_recorded", "pending_human_review"],
  };
  return {
    schemaVersion: failureDiscoverySchemaVersion,
    runId: `outcome:${candidate.candidateId}`,
    caseId: candidate.candidateId,
    sourceKind: "recorded",
    scenarioName: `runtime:${candidate.category}`,
    mode: "mock",
    generatedAt: candidate.createdAt,
    fingerprint: fingerprintJson(outcome),
    outcome,
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
  createReviewBatchWorkspace(paths, options.batchId);
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
  saveBatchManifest(paths.manifest, manifest);
  return manifest;
}

export function addRunToBatch(root: string, batchId: string, run: FailureRunRecord): FailureReviewRecord {
  const paths = reviewPaths(root, batchId);
  const manifest = loadBatchManifest(paths.manifest);
  if (manifest.status !== "in_progress") {
    throw new Error(`Review batch ${batchId} is already complete.`);
  }
  if (manifest.runIds.includes(run.runId)) {
    throw new Error(`Review batch already contains run ${run.runId}.`);
  }
  const review: FailureReviewRecord = {
    schemaVersion: failureDiscoverySchemaVersion,
    reviewId: `review:${run.runId}`,
    runId: run.runId,
    disposition: "pending",
    downstreamEffects: [],
    independentFindings: [],
  };
  saveRunRecord(reviewArtifactPath(paths.runs, run.runId), run);
  saveReviewRecord(reviewArtifactPath(paths.reviews, run.runId), review);
  saveBatchManifest(paths.manifest, {
    ...manifest,
    runIds: [...manifest.runIds, run.runId],
  });
  return review;
}

export function completeReviewBatch(root: string, batchId: string): FailureBatchManifest {
  const paths = reviewPaths(root, batchId);
  const manifest = loadBatchManifest(paths.manifest);
  if (manifest.runIds.length !== manifest.requestedSize) {
    throw new Error(`Review batch has ${manifest.runIds.length} run(s), expected ${manifest.requestedSize}.`);
  }
  const completed = { ...manifest, status: "complete" as const };
  saveBatchManifest(paths.manifest, completed);
  return completed;
}

export function loadReviewBatch(root: string, batchId: string): LoadedReviewBatch {
  const paths = reviewPaths(root, batchId);
  const manifest = loadBatchManifest(paths.manifest);
  return {
    manifest,
    runs: manifest.runIds.map((runId) => loadRunRecord(reviewArtifactPath(paths.runs, runId))),
    reviews: manifest.runIds.map((runId) => loadReviewRecord(reviewArtifactPath(paths.reviews, runId))),
  };
}

export function reviewStage(review: FailureReviewRecord): string {
  if (review.disposition === "pending" || review.disposition === "acceptable") return review.disposition;
  if (review.followUpDisposition === "protect") return "protected";
  if (review.followUpDisposition === "categorized") return "categorized";
  if (review.followUpDisposition === "candidate") return "candidate";
  return "failed";
}

export function renderReviewBatchSummary(batch: LoadedReviewBatch): string {
  const counts = new Map<string, number>();
  for (const review of batch.reviews) {
    const stage = reviewStage(review);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  const lines = [
    `# Failure review batch: ${batch.manifest.batchId}`,
    "",
    `Change: ${batch.manifest.changeLabel}`,
    `Generated: ${batch.manifest.generatedAt}`,
    `Repository revision: ${batch.manifest.repositoryRevision}${batch.manifest.repositoryDirty ? " (dirty)" : ""}`,
    `Runs: ${batch.runs.length}`,
    `Pending: ${counts.get("pending") ?? 0}`,
    `Acceptable: ${counts.get("acceptable") ?? 0}`,
    `Failed: ${counts.get("failed") ?? 0}`,
    `Candidate: ${counts.get("candidate") ?? 0}`,
    `Categorized: ${counts.get("categorized") ?? 0}`,
    `Protected: ${counts.get("protected") ?? 0}`,
    "",
    "| Run | Source | Scenario | Review state |",
    "| --- | --- | --- | --- |",
  ];
  const reviewByRunId = new Map(batch.reviews.map((review) => [review.runId, review]));
  for (const run of batch.runs) {
    const review = reviewByRunId.get(run.runId);
    lines.push(`| ${run.runId} | ${run.sourceKind} | ${run.scenarioName} | ${review ? reviewStage(review) : "missing"} |`);
  }
  return `${lines.join("\n")}\n`;
}
