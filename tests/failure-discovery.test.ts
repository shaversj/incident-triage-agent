import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createReviewBatch,
  fingerprintJson,
  loadReviewRecord,
  reviewPaths,
  saveReviewRecord,
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

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "failure-discovery-"));
}
