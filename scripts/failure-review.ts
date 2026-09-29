import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import {
  defaultFailureCaseCatalog,
  executeFailureCase,
  liveFailureCaseCatalog,
  type FailureCaseDefinition,
} from "../evals/failure-case-catalog";
import {
  addRunToBatch,
  completeReviewBatch,
  createReviewBatch,
  defaultFailureReviewRoot,
  failureDiscoverySchemaVersion,
  fingerprintJson,
  latestFailureMode,
  loadFailureTaxonomy,
  loadReviewBatch,
  parseFailureReviewRecord,
  promoteCandidateObservation,
  promoteFailureMode,
  renderReviewBatchSummary,
  retireFailureMode,
  reviewArtifactPath,
  reviewPaths,
  reviewStage,
  saveReviewRecord,
  reviseFailureMode,
  validateReviewBatch,
  validateReviewRecord,
  type FailureRunRecord,
} from "../evals/failure-discovery";

interface ParsedArgs {
  command: string;
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case "generate":
        return await generateBatch(args);
      case "list":
        return listBatch(args);
      case "show":
        return showRun(args);
      case "annotate":
        return annotateRun(args);
      case "validate":
        return validateBatch(args);
      case "summarize":
        return summarizeBatch(args);
      case "promote":
        return promoteReviews(args);
      case "revise-mode":
        return reviseMode(args);
      case "retire-mode":
        return retireMode(args);
      default:
        throw new Error(`Unknown command: ${args.command || "(missing)"}.`);
    }
  } catch (error) {
    process.stderr.write(`Failure review error: ${safeMessage(error)}\n`);
    return 1;
  }
}

async function generateBatch(args: ParsedArgs): Promise<number> {
  const changeLabel = requiredOption(args, "--change");
  const size = integerOption(args, "--size", 24);
  if (size < 20 || size > 30) {
    throw new Error("--size must be between 20 and 30.");
  }
  const includeLive = args.flags.has("--live");
  if (includeLive) {
    if (process.env.RUN_LIVE_FLUE_EVALS !== "1") {
      throw new Error("--live requires RUN_LIVE_FLUE_EVALS=1.");
    }
    loadConfig(".env");
  }
  const catalog = selectedCatalog(size, includeLive);
  const root = option(args, "--root") ?? defaultFailureReviewRoot;
  const generatedAt = new Date().toISOString();
  const batchId = option(args, "--batch-id") ?? generatedBatchId(generatedAt);
  createReviewBatch(root, {
    batchId,
    changeLabel,
    requestedSize: size,
    repositoryRevision: gitOutput(["rev-parse", "HEAD"]),
    repositoryDirty: gitOutput(["status", "--porcelain"]).length > 0,
    generatedAt,
  });

  for (const definition of catalog) {
    const run = await executeReviewCase(definition, generatedAt);
    addRunToBatch(root, batchId, run);
  }
  const manifest = completeReviewBatch(root, batchId);
  const batch = loadReviewBatch(root, batchId);
  writeFileSync(reviewPaths(root, batchId).summary, renderReviewBatchSummary(batch));

  if (args.flags.has("--json")) {
    printJson({
      batch_id: batchId,
      status: manifest.status,
      run_count: manifest.runIds.length,
      root,
    });
  } else {
    process.stdout.write(`Generated ${manifest.runIds.length} review runs in ${reviewPaths(root, batchId).directory}.\n`);
  }
  return 0;
}

function listBatch(args: ParsedArgs): number {
  const batchId = requiredPositional(args, 0, "batch id");
  const batch = loadReviewBatch(rootOption(args), batchId);
  const reviewByRunId = new Map(batch.reviews.map((review) => [review.runId, review]));
  const reviews = batch.runs.map((run) => ({
    run_id: run.runId,
    case_id: run.caseId,
    source_kind: run.sourceKind,
    scenario_name: run.scenarioName,
    state: reviewStage(reviewByRunId.get(run.runId)!),
  }));
  if (args.flags.has("--json")) {
    printJson({ batch_id: batchId, reviews });
  } else {
    for (const review of reviews) {
      process.stdout.write(`${review.state.padEnd(11)} ${review.run_id} (${review.source_kind})\n`);
    }
  }
  return 0;
}

function showRun(args: ParsedArgs): number {
  const batchId = requiredPositional(args, 0, "batch id");
  const runId = requiredPositional(args, 1, "run id");
  const batch = loadReviewBatch(rootOption(args), batchId);
  const run = batch.runs.find((item) => item.runId === runId);
  const review = batch.reviews.find((item) => item.runId === runId);
  if (!run || !review) {
    throw new Error(`Unknown run ${runId} in batch ${batchId}.`);
  }
  if (args.flags.has("--json")) {
    printJson({ run, review });
  } else {
    process.stdout.write(renderRun(run, reviewStage(review)));
  }
  return 0;
}

function annotateRun(args: ParsedArgs): number {
  const batchId = requiredPositional(args, 0, "batch id");
  const runId = requiredPositional(args, 1, "run id");
  const input = requiredOption(args, "--input");
  const root = rootOption(args);
  const batch = loadReviewBatch(root, batchId);
  const run = batch.runs.find((item) => item.runId === runId);
  if (!run) {
    throw new Error(`Unknown run ${runId} in batch ${batchId}.`);
  }
  const payload = JSON.parse(input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8")) as unknown;
  const review = parseFailureReviewRecord(payload);
  const errors = validateReviewRecord(review, run);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
  const path = reviewArtifactPath(reviewPaths(root, batchId).reviews, runId);
  saveReviewRecord(path, review);
  if (args.flags.has("--json")) {
    printJson({ review });
  } else {
    process.stdout.write(`Saved ${reviewStage(review)} review for ${runId}.\n`);
  }
  return 0;
}

function validateBatch(args: ParsedArgs): number {
  const batchId = requiredPositional(args, 0, "batch id");
  const batch = loadReviewBatch(rootOption(args), batchId);
  const errors = validateReviewBatch(batch);
  if (args.flags.has("--json")) {
    printJson({ batch_id: batchId, valid: errors.length === 0, errors });
  } else if (errors.length === 0) {
    process.stdout.write(`Batch ${batchId} is valid.\n`);
  } else {
    process.stdout.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  }
  return errors.length === 0 ? 0 : 1;
}

function summarizeBatch(args: ParsedArgs): number {
  const batchId = requiredPositional(args, 0, "batch id");
  const root = rootOption(args);
  const summary = renderReviewBatchSummary(loadReviewBatch(root, batchId));
  writeFileSync(reviewPaths(root, batchId).summary, summary);
  process.stdout.write(summary);
  return 0;
}

function promoteReviews(args: ParsedArgs): number {
  const batchId = requiredPositional(args, 0, "batch id");
  const runIds = args.positionals.slice(1);
  if (runIds.length === 0) {
    throw new Error("At least one run id is required.");
  }
  const batch = loadReviewBatch(rootOption(args), batchId);
  const caseDirectory = option(args, "--case-dir") ?? "evals/failure-cases";
  if (args.flags.has("--candidate")) {
    if (runIds.length !== 1) {
      throw new Error("Candidate promotion accepts exactly one run id.");
    }
    const snapshot = promoteCandidateObservation({ batch, runId: runIds[0]!, caseDirectory });
    printResult(args, { case: snapshot }, `Promoted candidate ${snapshot.caseId}.`);
    return 0;
  }
  const result = promoteFailureMode({
    batch,
    runIds,
    taxonomyPath: option(args, "--taxonomy") ?? "evals/failure-taxonomy.json",
    caseDirectory,
    modeId: requiredOption(args, "--mode-id"),
    name: requiredOption(args, "--name"),
    definition: requiredOption(args, "--definition"),
    distinguishingNotes: requiredOption(args, "--distinguishing-notes"),
  });
  printResult(
    args,
    result,
    `Activated ${result.mode.id} revision ${result.mode.revision} from ${result.cases.length} sources.`,
  );
  return 0;
}

function reviseMode(args: ParsedArgs): number {
  const modeId = requiredPositional(args, 0, "mode id");
  const taxonomyPath = option(args, "--taxonomy") ?? "evals/failure-taxonomy.json";
  const taxonomy = loadFailureTaxonomy(taxonomyPath);
  const latest = latestFailureMode(taxonomy, modeId);
  if (!latest) {
    throw new Error(`Unknown failure mode ${modeId}.`);
  }
  const sourceCaseIds = args.positionals.slice(1);
  const revision = reviseFailureMode(taxonomyPath, {
    modeId,
    name: option(args, "--name") ?? latest.name,
    definition: requiredOption(args, "--definition"),
    distinguishingNotes: requiredOption(args, "--distinguishing-notes"),
    sourceCaseIds: sourceCaseIds.length > 0 ? sourceCaseIds : latest.sourceCaseIds,
  });
  printResult(args, { mode: revision }, `Revised ${modeId} to revision ${revision.revision}.`);
  return 0;
}

function retireMode(args: ParsedArgs): number {
  const modeId = requiredPositional(args, 0, "mode id");
  const retired = retireFailureMode(
    option(args, "--taxonomy") ?? "evals/failure-taxonomy.json",
    modeId,
  );
  printResult(args, { mode: retired }, `Retired ${modeId} at revision ${retired.revision}.`);
  return 0;
}

async function executeReviewCase(
  definition: FailureCaseDefinition,
  generatedAt: string,
): Promise<FailureRunRecord> {
  try {
    return await executeFailureCase(definition, generatedAt);
  } catch (error) {
    if (definition.sourceKind !== "live") {
      throw error;
    }
    const outcome: Record<string, unknown> = {
      status: "error",
      run_id: `review-run:${definition.caseId}`,
      run_status: "recoverable_failure",
      scenario: definition.scenarioName,
      states: ["received", "llm_decision_requested", "recoverable_failure"],
      validation: { valid: false, errors: ["Live provider request failed."] },
      evidence: [],
      investigation: { summary: "Live provider execution failed.", steps: [] },
    };
    return {
      schemaVersion: failureDiscoverySchemaVersion,
      runId: `review-run:${definition.caseId}`,
      caseId: definition.caseId,
      sourceKind: definition.sourceKind,
      scenarioName: definition.scenarioName,
      mode: definition.mode,
      generatedAt,
      fingerprint: fingerprintJson(outcome),
      outcome,
    };
  }
}

function selectedCatalog(size: number, includeLive: boolean): FailureCaseDefinition[] {
  const live = includeLive ? liveFailureCaseCatalog : [];
  const mockCount = size - live.length;
  if (mockCount < 0 || mockCount > defaultFailureCaseCatalog.length) {
    throw new Error(`Requested ${size} runs, but only ${defaultFailureCaseCatalog.length + live.length} stable cases are available.`);
  }
  return [...defaultFailureCaseCatalog.slice(0, mockCount), ...live];
}

function renderRun(run: FailureRunRecord, state: string): string {
  const outcome = run.outcome;
  const investigation = objectValue(outcome.investigation);
  const states = Array.isArray(outcome.states) ? outcome.states : [];
  const steps = Array.isArray(investigation.steps) ? investigation.steps : [];
  const evidence = Array.isArray(outcome.evidence) ? outcome.evidence : [];
  return [
    `Run: ${run.runId}`,
    `Case: ${run.caseId}`,
    `Source: ${run.sourceKind}`,
    `Review state: ${state}`,
    `Workflow states: ${states.join(" -> ")}`,
    "",
    "Investigation steps:",
    JSON.stringify(steps, null, 2),
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2),
    "",
    "Outcome:",
    JSON.stringify(outcome, null, 2),
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleanFlags = new Set(["--json", "--live", "--candidate"]);
  const valueFlags = new Set([
    "--change",
    "--size",
    "--batch-id",
    "--root",
    "--input",
    "--taxonomy",
    "--case-dir",
    "--mode-id",
    "--name",
    "--definition",
    "--distinguishing-notes",
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (booleanFlags.has(value)) {
      flags.add(value);
      continue;
    }
    if (valueFlags.has(value)) {
      const optionValue = rest[++index];
      if (!optionValue) {
        throw new Error(`${value} requires a value.`);
      }
      values.set(value, optionValue);
      continue;
    }
    if (value.startsWith("--")) {
      throw new Error(`Unknown option: ${value}.`);
    }
    positionals.push(value);
  }
  return { command, positionals, values, flags };
}

function rootOption(args: ParsedArgs): string {
  return option(args, "--root") ?? defaultFailureReviewRoot;
}

function option(args: ParsedArgs, name: string): string | undefined {
  return args.values.get(name);
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function integerOption(args: ParsedArgs, name: string, fallback: number): number {
  const value = option(args, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

function requiredPositional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function generatedBatchId(generatedAt: string): string {
  return `failure-review-${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printResult(args: ParsedArgs, value: unknown, message: string): void {
  if (args.flags.has("--json")) {
    printJson(value);
    return;
  }
  process.stdout.write(`${message}\n`);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/(api[_-]?key|token|secret|password)=?[^\s]*/gi, "$1=[redacted]");
  }
  return "Unknown failure review error.";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
