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
} from "../evals/failure-case-catalog";
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

describe("representative failure case catalog", () => {
  test("contains 20 to 30 stable unique cases without live credentials", () => {
    const caseIds = defaultFailureCaseCatalog.map((item) => item.caseId);

    expect(caseIds.length).toBeGreaterThanOrEqual(20);
    expect(caseIds.length).toBeLessThanOrEqual(30);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(defaultFailureCaseCatalog.some((item) => item.sourceKind === "recorded")).toBe(true);
    expect(defaultFailureCaseCatalog.every((item) => item.mode === "mock")).toBe(true);
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

async function runFailureReviewCli(args: string[]) {
  const proc = spawn("npx", ["tsx", `${process.cwd()}/scripts/failure-review.ts`, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    new Promise<number | null>((resolve) => proc.on("exit", resolve)),
  ]);
  return { stdout, stderr, exitCode };
}
