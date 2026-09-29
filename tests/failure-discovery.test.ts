import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { describe, expect, test } from "vitest";
import {
  defaultFailureCaseCatalog,
  executeFailureCase,
  selectFailureCases,
} from "../evals/failure-case-catalog";
import {
  failureRegressionCases,
  validateFailureRegressionRegistry,
} from "../evals/failure-regressions";
import { runIncidentTriage } from "../evals/incident-triage-runner";
import {
  addRunToBatch,
  completeReviewBatch,
  createReviewBatch,
  findFailureMode,
  fingerprintJson,
  loadFailureTaxonomy,
  loadPromotedCase,
  loadReviewBatch,
  loadReviewRecord,
  promoteCandidateObservation,
  promoteFailureMode,
  retireFailureMode,
  reviewPaths,
  reviewArtifactPath,
  reviseFailureMode,
  saveReviewRecord,
  validateReviewBatch,
  validateReviewRecord,
  type FailureReviewRecord,
  type FailureRunRecord,
} from "../evals/failure-discovery";

describe("failure discovery review domain", () => {
  test("creates a valid empty batch workspace", () => {
    const root = tempRoot();
    const manifest = createReviewBatch(root, {
      batchId: "batch-2026-09-28",
      changeLabel: "local-validation",
      requestedSize: 24,
      repositoryRevision: "abc123",
      repositoryDirty: true,
      generatedAt: "2026-09-28T20:00:00.000Z",
    });
    const paths = reviewPaths(root, manifest.batchId);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      status: "in_progress",
      runIds: [],
    });
    expect(JSON.parse(readFileSync(paths.manifest, "utf8"))).toEqual(manifest);
  });

  test("rejects batch identifiers that escape the review root", () => {
    const root = tempRoot();

    expect(() => createReviewBatch(root, {
      batchId: "../escaped",
      changeLabel: "local-validation",
      requestedSize: 24,
      repositoryRevision: "abc123",
      repositoryDirty: false,
    })).toThrow("path-safe identifier");
  });

  test("accepts an acceptable review without a failure anchor or taxonomy", () => {
    const run = sampleRun();
    const review: FailureReviewRecord = {
      schemaVersion: 1,
      reviewId: "review:run-1",
      runId: run.runId,
      disposition: "acceptable",
      observation: "The run stayed within the bounded contract.",
      downstreamEffects: [],
      independentFindings: [],
      followUpDisposition: "none",
    };

    expect(validateReviewRecord(review, run)).toEqual([]);
  });

  test("accepts one first failure with evidence and downstream effects", () => {
    const run = sampleRun();
    const review: FailureReviewRecord = {
      schemaVersion: 1,
      reviewId: "review:run-1",
      runId: run.runId,
      disposition: "failed",
      observation: "The evidence selection omitted the current deploy.",
      firstFailure: {
        phase: "context_gathered",
        stepId: "deploy_lookup",
        evidenceIds: ["deploy:0"],
        rationale: "The deploy was available but did not inform the decision.",
      },
      downstreamEffects: ["The mitigation recommendation was too weak."],
      independentFindings: ["The explanation was also difficult to scan."],
      followUpDisposition: "candidate",
    };

    expect(validateReviewRecord(review, run)).toEqual([]);
  });

  test("rejects failed reviews without a complete first-failure anchor", () => {
    const run = sampleRun();
    const review = {
      schemaVersion: 1,
      reviewId: "review:run-1",
      runId: run.runId,
      disposition: "failed",
      observation: "Evidence selection failed.",
      firstFailure: {
        phase: "",
        evidenceIds: ["missing:0"],
        rationale: "",
      },
      downstreamEffects: [],
      independentFindings: [],
      followUpDisposition: "candidate",
    } as FailureReviewRecord;

    expect(validateReviewRecord(review, run)).toEqual(expect.arrayContaining([
      "first_failure.phase must be a non-empty string.",
      "first_failure.rationale must be a non-empty string.",
      "first_failure.evidence_ids references unknown evidence missing:0.",
    ]));
  });

  test("rejects acceptable reviews carrying a primary failure", () => {
    const run = sampleRun();
    const review = {
      schemaVersion: 1,
      reviewId: "review:run-1",
      runId: run.runId,
      disposition: "acceptable",
      firstFailure: {
        phase: "context_gathered",
        evidenceIds: ["deploy:0"],
        rationale: "This should not be present.",
      },
      downstreamEffects: [],
      independentFindings: [],
      followUpDisposition: "none",
    } as FailureReviewRecord;

    expect(validateReviewRecord(review, run)).toContain(
      "acceptable reviews must not include first_failure.",
    );
  });

  test("rejects dangling run and step references", () => {
    const run = sampleRun();
    const review: FailureReviewRecord = {
      schemaVersion: 1,
      reviewId: "review:other-run",
      runId: "other-run",
      disposition: "failed",
      firstFailure: {
        phase: "context_gathered",
        stepId: "missing-step",
        evidenceIds: ["deploy:0"],
        rationale: "The named step is not present.",
      },
      downstreamEffects: [],
      independentFindings: [],
      followUpDisposition: "candidate",
    };

    expect(validateReviewRecord(review, run)).toEqual(expect.arrayContaining([
      "review run_id other-run does not match run run-1.",
      "first_failure.step_id references unknown investigation step missing-step.",
    ]));
  });

  test("rejects failure-mode references absent from the taxonomy", () => {
    const run = sampleRun();
    const review: FailureReviewRecord = {
      ...failedReview(run.runId),
      failureMode: { id: "missing-mode", revision: 99 },
      followUpDisposition: "categorized",
    };
    const errors = validateReviewBatch({
      manifest: {
        schemaVersion: 1,
        batchId: "batch-validation",
        changeLabel: "taxonomy-validation",
        requestedSize: 1,
        generatedAt: "2026-09-28T20:00:00.000Z",
        repositoryRevision: "abc123",
        repositoryDirty: false,
        status: "complete",
        runIds: [run.runId],
      },
      runs: [run],
      reviews: [review],
    }, { schemaVersion: 1, modes: [] });

    expect(errors).toContain(
      `${run.runId}: failure_mode references unknown mode missing-mode revision 99.`,
    );
  });

  test("reports unsupported schema versions with a field-specific diagnostic", () => {
    const root = tempRoot();
    const path = join(root, "review.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2 }));

    expect(() => loadReviewRecord(path)).toThrow("schema_version must equal 1");
  });

  test("fingerprints object content independent of key insertion order", () => {
    expect(fingerprintJson({ alpha: 1, beta: { two: 2, one: 1 } })).toBe(
      fingerprintJson({ beta: { one: 1, two: 2 }, alpha: 1 }),
    );
  });

  test("atomic review replacement preserves the prior file when serialization fails", () => {
    const root = tempRoot();
    const path = join(root, "review.json");
    const review: FailureReviewRecord = {
      schemaVersion: 1,
      reviewId: "review:run-1",
      runId: "run-1",
      disposition: "pending",
      downstreamEffects: [],
      independentFindings: [],
    };
    saveReviewRecord(path, review);
    const before = readFileSync(path, "utf8");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => saveReviewRecord(path, cyclic as unknown as FailureReviewRecord)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("representative failure case catalog", () => {
  test("contains 20 to 30 stable unique cases without live credentials", () => {
    const caseIds = defaultFailureCaseCatalog.map((item) => item.caseId);

    expect(caseIds.length).toBeGreaterThanOrEqual(20);
    expect(caseIds.length).toBeLessThanOrEqual(30);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(defaultFailureCaseCatalog.some((item) => item.sourceKind === "recorded")).toBe(true);
    expect(defaultFailureCaseCatalog.every((item) => item.mode === "mock")).toBe(true);
  });

  test("keeps recorded coverage in minimum and live review batches", () => {
    for (const [size, includeLive] of [[20, false], [24, false], [20, true], [24, true]] as const) {
      const selected = selectFailureCases(size, includeLive);
      expect(selected).toHaveLength(size);
      expect(selected.some((item) => item.sourceKind === "mock")).toBe(true);
      expect(selected.some((item) => item.sourceKind === "recorded")).toBe(true);
      expect(selected.some((item) => item.sourceKind === "live")).toBe(includeLive);
    }
  });

  test("executes a mock case through the workflow-backed eval runner", async () => {
    const definition = requiredCase("mock:bad-deploy-latency:baseline");
    const record = await executeFailureCase(definition, "2026-09-28T20:00:00.000Z");

    expect(record.sourceKind).toBe("mock");
    expect(record.outcome.run_status).toBe("completed");
    expect(record.outcome.states).toEqual(expect.arrayContaining(["received", "context_gathered", "scored"]));
    expect(objectValue(record.outcome.safety).status).toBe("approval_required");
  });

  test("keeps malformed mock output reviewable as a recoverable run", async () => {
    const definition = requiredCase("mock:checkout-payment-timeout:malformed-json");
    const record = await executeFailureCase(definition, "2026-09-28T20:00:00.000Z");

    expect(record.outcome.run_status).toBe("recoverable_failure");
    expect(objectValue(record.outcome.validation).valid).toBe(false);
  });

  test("executes recorded cases through Grafana and recorded Loki inputs", async () => {
    const definition = requiredCase("recorded:capacity-saturation:baseline");
    const record = await executeFailureCase(definition, "2026-09-28T20:00:00.000Z");

    expect(record.sourceKind).toBe("recorded");
    expect(record.outcome.run_status).toBe("completed");
    expect(objectValue(record.outcome.investigation).steps).toBeInstanceOf(Array);
    expect(record.outcome.evidence).toBeInstanceOf(Array);
    expect(objectValue(record.outcome.mitigation_control).status).toBe("approval_required");
  });
});

describe("failure review CLI", () => {
  test("generates, inspects, annotates, validates, and summarizes a local batch", async () => {
    const root = tempRoot();
    const generated = await runFailureReviewCli([
      "generate",
      "--change",
      "cli-contract",
      "--size",
      "20",
      "--batch-id",
      "batch-cli-contract",
      "--root",
      root,
      "--json",
    ]);
    const generation = JSON.parse(generated.stdout) as Record<string, unknown>;
    const batchDirectory = join(root, "batch-cli-contract");
    const manifest = JSON.parse(readFileSync(join(batchDirectory, "manifest.json"), "utf8")) as {
      runIds: string[];
      status: string;
      changeLabel: string;
      requestedSize: number;
      repositoryRevision: string;
      repositoryDirty: boolean;
    };

    expect(generated.exitCode).toBe(0);
    expect(generation).toMatchObject({ batch_id: "batch-cli-contract", run_count: 20 });
    expect(manifest).toMatchObject({
      status: "complete",
      changeLabel: "cli-contract",
      requestedSize: 20,
    });
    expect(manifest.repositoryRevision).toMatch(/^[0-9a-f]+$/);
    expect(typeof manifest.repositoryDirty).toBe("boolean");
    expect(readdirSync(join(batchDirectory, "runs"))).toHaveLength(20);
    expect(readdirSync(join(batchDirectory, "reviews"))).toHaveLength(20);

    const runId = manifest.runIds[0];
    expect(runId).toBeTruthy();
    const listed = await runFailureReviewCli(["list", "batch-cli-contract", "--root", root, "--json"]);
    const shown = await runFailureReviewCli(["show", "batch-cli-contract", runId!, "--root", root, "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).reviews).toHaveLength(20);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout).run.outcome.states).toBeInstanceOf(Array);
    expect(JSON.parse(shown.stdout).run.outcome.investigation.steps).toBeInstanceOf(Array);

    const annotationPath = join(root, "annotation.json");
    writeFileSync(annotationPath, JSON.stringify({
      schemaVersion: 1,
      reviewId: `review:${runId}`,
      runId,
      disposition: "acceptable",
      observation: "No material failure in this run.",
      downstreamEffects: [],
      independentFindings: [],
      followUpDisposition: "none",
    }));
    const annotated = await runFailureReviewCli([
      "annotate",
      "batch-cli-contract",
      runId!,
      "--input",
      annotationPath,
      "--root",
      root,
      "--json",
    ]);
    expect(annotated.exitCode).toBe(0);
    expect(JSON.parse(annotated.stdout).review.disposition).toBe("acceptable");

    const invalid = await runFailureReviewCli([
      "annotate",
      "batch-cli-contract",
      runId!,
      "--input",
      join(root, "missing.json"),
      "--root",
      root,
    ]);
    const shownAfterInvalid = await runFailureReviewCli([
      "show",
      "batch-cli-contract",
      runId!,
      "--root",
      root,
      "--json",
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("Failure review error:");
    expect(invalid.stderr).not.toContain("at ");
    expect(JSON.parse(shownAfterInvalid.stdout).review.disposition).toBe("acceptable");

    const validation = await runFailureReviewCli([
      "validate",
      "batch-cli-contract",
      "--root",
      root,
      "--json",
    ]);
    expect(validation.exitCode).toBe(1);
    expect(JSON.parse(validation.stdout).errors).toContain(
      "19 review(s) are still pending.",
    );

    const firstSummary = await runFailureReviewCli([
      "summarize",
      "batch-cli-contract",
      "--root",
      root,
    ]);
    const secondSummary = await runFailureReviewCli([
      "summarize",
      "batch-cli-contract",
      "--root",
      root,
    ]);
    expect(firstSummary.exitCode).toBe(0);
    expect(secondSummary.stdout).toBe(firstSummary.stdout);
    expect(firstSummary.stdout).toContain("# Failure review batch: batch-cli-contract");
    expect(firstSummary.stdout).toContain("Pending: 19");
  }, 30_000);

  test("promotes reviewed sources through the CLI", async () => {
    const root = tempRoot();
    const batch = createReviewedFailureBatch(root);
    const taxonomyPath = join(root, "failure-taxonomy.json");
    const caseDirectory = join(root, "failure-cases");
    const result = await runFailureReviewCli([
      "promote",
      batch.manifest.batchId,
      ...batch.manifest.runIds,
      "--root",
      root,
      "--taxonomy",
      taxonomyPath,
      "--case-dir",
      caseDirectory,
      "--mode-id",
      "unsupported-evidence-citation",
      "--name",
      "Unsupported evidence citation",
      "--definition",
      "The decision cites evidence absent from the run.",
      "--distinguishing-notes",
      "Use for invalid citations, not weak valid evidence.",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).mode).toMatchObject({
      id: "unsupported-evidence-citation",
      revision: 1,
      status: "active",
    });
    expect(readdirSync(caseDirectory)).toHaveLength(2);
  });

  test("rejects live generation before creating a batch unless explicitly enabled", async () => {
    const root = tempRoot();
    const result = await runFailureReviewCli([
      "generate",
      "--change",
      "live-preflight",
      "--size",
      "20",
      "--batch-id",
      "live-preflight",
      "--root",
      root,
      "--live",
    ], { RUN_LIVE_FLUE_EVALS: undefined });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("RUN_LIVE_FLUE_EVALS=1");
    expect(() => readFileSync(join(root, "live-preflight", "manifest.json"))).toThrow();
  });
});

describe("failure taxonomy promotion", () => {
  test("activates a named mode from two reviewed sources and preserves revisions", () => {
    const workspace = tempRoot();
    const batch = createReviewedFailureBatch(workspace);
    const taxonomyPath = join(workspace, "failure-taxonomy.json");
    const caseDirectory = join(workspace, "failure-cases");
    const promoted = promoteFailureMode({
      batch,
      runIds: batch.manifest.runIds,
      taxonomyPath,
      caseDirectory,
      modeId: "unsupported-evidence-citation",
      name: "Unsupported evidence citation",
      definition: "The bounded decision cites evidence that the run did not establish.",
      distinguishingNotes: "Use only when the citation itself is invalid, not when valid evidence is merely weak.",
    });

    expect(promoted.mode).toMatchObject({
      id: "unsupported-evidence-citation",
      revision: 1,
      status: "active",
    });
    expect(promoted.mode.sourceCaseIds).toHaveLength(2);
    const firstSnapshot = loadPromotedCase(join(caseDirectory, `${promoted.mode.sourceCaseIds[0]}.json`));
    expect(firstSnapshot.failureMode).toEqual({ id: "unsupported-evidence-citation", revision: 1 });
    expect(firstSnapshot.outcome).not.toHaveProperty("api_key");

    const revised = reviseFailureMode(taxonomyPath, {
      modeId: "unsupported-evidence-citation",
      definition: "The decision cites an identifier absent from the run evidence package.",
      distinguishingNotes: "Do not use for weak but valid evidence.",
      sourceCaseIds: promoted.mode.sourceCaseIds,
      caseDirectory,
    });
    const retired = retireFailureMode(taxonomyPath, "unsupported-evidence-citation");
    const taxonomy = loadFailureTaxonomy(taxonomyPath);

    expect(revised.revision).toBe(2);
    expect(retired).toMatchObject({ revision: 3, status: "retired" });
    expect(findFailureMode(taxonomy, "unsupported-evidence-citation", 1)?.definition).toBe(
      "The bounded decision cites evidence that the run did not establish.",
    );
    expect(firstSnapshot.failureMode).toEqual({ id: "unsupported-evidence-citation", revision: 1 });
    expect(validateFailureRegressionRegistry([{
      ...failureRegressionCases[0]!,
      failureMode: { id: "unsupported-evidence-citation", revision: 2 },
      sourceCaseIds: promoted.mode.sourceCaseIds,
    }], { taxonomyPath, caseDirectory })).toEqual([]);
  });

  test("rejects duplicate and dangling sources when revising a failure mode", () => {
    const workspace = tempRoot();
    const batch = createReviewedFailureBatch(workspace);
    const taxonomyPath = join(workspace, "failure-taxonomy.json");
    const caseDirectory = join(workspace, "failure-cases");
    const promoted = promoteFailureMode({
      batch,
      runIds: batch.manifest.runIds,
      taxonomyPath,
      caseDirectory,
      modeId: "unsupported-evidence-citation",
      name: "Unsupported evidence citation",
      definition: "The decision cites evidence absent from the run.",
      distinguishingNotes: "Use for invalid citations, not weak valid evidence.",
    });

    expect(() => reviseFailureMode(taxonomyPath, {
      modeId: promoted.mode.id,
      definition: "Revised definition.",
      distinguishingNotes: "Revised notes.",
      sourceCaseIds: [promoted.mode.sourceCaseIds[0]!, promoted.mode.sourceCaseIds[0]!],
      caseDirectory,
    })).toThrow("at least two source cases");
    expect(() => reviseFailureMode(taxonomyPath, {
      modeId: promoted.mode.id,
      definition: "Revised definition.",
      distinguishingNotes: "Revised notes.",
      sourceCaseIds: [promoted.mode.sourceCaseIds[0]!, "missing-case"],
      caseDirectory,
    })).toThrow();
  });

  test("keeps one source as an uncategorized candidate and rejects unsafe promotion", () => {
    const workspace = tempRoot();
    const batch = createReviewedFailureBatch(workspace);
    const caseDirectory = join(workspace, "failure-cases");
    const candidate = promoteCandidateObservation({
      batch,
      runId: batch.manifest.runIds[0]!,
      caseDirectory,
    });

    expect(candidate.failureMode).toBeUndefined();
    expect(() => promoteFailureMode({
      batch,
      runIds: [batch.manifest.runIds[0]!],
      taxonomyPath: join(workspace, "taxonomy.json"),
      caseDirectory,
      modeId: "single-source-mode",
      name: "Single source",
      definition: "A mode with only one source.",
      distinguishingNotes: "This must not activate.",
    })).toThrow("at least two source reviews");

    const unsafeRun = {
      ...batch.runs[0]!,
      runId: "run-secret",
      caseId: "mock:bad-deploy-latency:secret",
      outcome: { ...batch.runs[0]!.outcome, api_key: "do-not-copy" },
    };
    const unsafeReview = failedReview(unsafeRun.runId);
    const unsafeBatch = {
      manifest: { ...batch.manifest, runIds: [unsafeRun.runId] },
      runs: [unsafeRun],
      reviews: [unsafeReview],
    };
    expect(() => promoteCandidateObservation({
      batch: unsafeBatch,
      runId: unsafeRun.runId,
      caseDirectory,
    })).toThrow("credential-bearing key api_key");
  });
});

describe("failure regression provenance", () => {
  test("resolves every versioned regression to its mode revision and source cases", () => {
    expect(validateFailureRegressionRegistry(failureRegressionCases)).toEqual([]);
  });

  test("rejects dangling mode revisions and source cases before execution", () => {
    const invalid = [{
      ...failureRegressionCases[0]!,
      failureMode: { id: "missing-mode", revision: 99 },
      sourceCaseIds: ["missing-case"],
    }];

    expect(validateFailureRegressionRegistry(invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining("missing-mode revision 99"),
      expect.stringContaining("missing-case"),
    ]));
  });

  test("detects the same upstream defect when downstream wording changes", async () => {
    const regression = failureRegressionCases[0]!;
    const mockResponse = JSON.parse(JSON.stringify(regression.input.mockResponse)) as Record<string, unknown>;
    mockResponse.finding_summary = "Completely different downstream explanation text.";
    const result = await runIncidentTriage({ ...regression.input, mockResponse });

    expect(() => regression.assert(result.output)).not.toThrow();
  });
});

function sampleRun(): FailureRunRecord {
  return {
    schemaVersion: 1,
    runId: "run-1",
    caseId: "mock:bad-deploy-latency:baseline",
    sourceKind: "mock",
    scenarioName: "bad-deploy-latency",
    mode: "mock",
    generatedAt: "2026-09-28T20:00:00.000Z",
    fingerprint: "fingerprint",
    outcome: {
      run_id: "triage-run:bad-deploy-latency",
      run_status: "completed",
      states: ["received", "context_gathered", "scored"],
      investigation: {
        steps: [{ id: "deploy_lookup", status: "found", evidence_ids: ["deploy:0"] }],
      },
      evidence: [{ id: "deploy:0", source: "deploy", detail: "checkout-api deploy" }],
      safety: { status: "approval_required" },
      mitigation_control: { status: "approval_required", staged_action: { executed: false } },
    },
  };
}

function createReviewedFailureBatch(root: string) {
  createReviewBatch(root, {
    batchId: "batch-promotion",
    changeLabel: "taxonomy-contract",
    requestedSize: 2,
    repositoryRevision: "abc123",
    repositoryDirty: false,
    generatedAt: "2026-09-28T20:00:00.000Z",
  });
  const first = sampleRun();
  const second: FailureRunRecord = {
    ...sampleRun(),
    runId: "run-2",
    caseId: "mock:capacity-saturation:unknown-evidence",
    scenarioName: "capacity-saturation",
  };
  for (const run of [first, second]) {
    addRunToBatch(root, "batch-promotion", run);
    saveReviewRecord(
      reviewArtifactPath(reviewPaths(root, "batch-promotion").reviews, run.runId),
      failedReview(run.runId),
    );
  }
  completeReviewBatch(root, "batch-promotion");
  return loadReviewBatch(root, "batch-promotion");
}

function failedReview(runId: string): FailureReviewRecord {
  return {
    schemaVersion: 1,
    reviewId: `review:${runId}`,
    runId,
    disposition: "failed",
    observation: "The decision used unsupported evidence.",
    firstFailure: {
      phase: "context_gathered",
      stepId: "deploy_lookup",
      evidenceIds: ["deploy:0"],
      rationale: "The evidence package did not support the later decision.",
    },
    downstreamEffects: ["The recommendation became unreliable."],
    independentFindings: [],
    followUpDisposition: "candidate",
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "failure-discovery-"));
}

function requiredCase(caseId: string) {
  const definition = defaultFailureCaseCatalog.find((item) => item.caseId === caseId);
  if (!definition) {
    throw new Error(`Missing test case ${caseId}.`);
  }
  return definition;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function runFailureReviewCli(
  args: string[],
  envOverride: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FORCE_COLOR: "0",
    ...envOverride,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  const proc = spawn("npx", ["tsx", `${process.cwd()}/scripts/failure-review.ts`, ...args], {
    cwd: process.cwd(),
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    new Promise<number | null>((resolve) => proc.on("exit", resolve)),
  ]);
  return { stdout, stderr, exitCode };
}
