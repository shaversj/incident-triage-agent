import { join } from "node:path";
import { mockDecisionForName } from "../src/mock-decisions";
import { mockResponseWithUnknownEvidence } from "./failure-case-catalog";
import {
  findFailureMode,
  loadFailureTaxonomy,
  loadPromotedCase,
  type FailureModeReference,
} from "./failure-discovery";
import type {
  IncidentTriageEvalInput,
  IncidentTriageEvalOutput,
} from "./incident-triage-runner";

export interface FailureRegressionCase {
  id: string;
  name: string;
  failureMode: FailureModeReference;
  sourceCaseIds: string[];
  input: IncidentTriageEvalInput;
  assert(output: IncidentTriageEvalOutput): void;
}

export const failureRegressionCases: FailureRegressionCase[] = [
  {
    id: "unsupported-evidence-citation-remains-recoverable",
    name: "unsupported evidence citation remains a recoverable failure",
    failureMode: { id: "unsupported-evidence-citation", revision: 1 },
    sourceCaseIds: [
      "failure-case-2a1681883418bdcd",
      "failure-case-6bca99673e0fa92b",
    ],
    input: {
      scenarioName: "checkout-payment-timeout",
      mode: "mock",
      mockResponse: mockResponseWithUnknownEvidence(mockDecisionForName("checkout-payment-timeout")),
    },
    assert(output) {
      if (output.run_status !== "recoverable_failure") {
        throw new Error("Expected unsupported evidence to produce recoverable_failure.");
      }
      const validation = objectValue(output.validation);
      const errors = Array.isArray(validation.errors) ? validation.errors.map(String) : [];
      if (!errors.some((error) => error.includes("unknown evidence IDs"))) {
        throw new Error("Expected validation to identify the unsupported evidence citation.");
      }
      if (output.safety !== undefined || output.mitigation_control !== undefined) {
        throw new Error("Safety and mitigation must not run after evidence validation fails.");
      }
    },
  },
  {
    id: "provider-overload-remains-cleanly-recoverable",
    name: "provider overload remains a clean recoverable failure",
    failureMode: { id: "provider-overload-exhaustion", revision: 1 },
    sourceCaseIds: [
      "failure-case-011d7ed1a3d6ac86",
      "failure-case-0c0412c89487e280",
      "failure-case-6afed22102f3ab86",
    ],
    input: {
      scenarioName: "bad-deploy-latency",
      mode: "mock",
      mockFlueResult: {
        exitCode: 1,
        stdout: "",
        stderr: [
          "(node:999) ExperimentalWarning: SQLite is an experimental feature",
          "warn [flue:model-retry] Transient model error retries exhausted",
          "Error: skill failed: 529",
          '{"error":{"type":"overloaded_error"},"request_id":"provider-request-fixture"}',
        ].join("\n"),
      },
    },
    assert(output) {
      if (output.run_status !== "recoverable_failure") {
        throw new Error("Expected provider overload to produce recoverable_failure.");
      }
      const validation = objectValue(output.validation);
      const errors = Array.isArray(validation.errors) ? validation.errors.map(String) : [];
      const expected = "LLM provider is temporarily overloaded after retries; retry triage later.";
      if (!errors.includes(expected)) {
        throw new Error("Expected a stable operator-facing provider overload error.");
      }
      if (errors.some((error) => error.includes("provider-request-fixture") || error.includes("ExperimentalWarning"))) {
        throw new Error("Expected raw provider diagnostics to stay out of the operator error.");
      }
      if (output.safety !== undefined || output.mitigation_control !== undefined) {
        throw new Error("Safety and mitigation must not run after provider execution fails.");
      }
    },
  },
  {
    id: "duplicate-recommendation-action-remains-non-authoritative",
    name: "recommendation action duplication remains non-authoritative",
    failureMode: { id: "duplicate-recommendation-action", revision: 1 },
    sourceCaseIds: [
      "failure-case-c3d4868336e7d498",
      "failure-case-b6703886c0dd50eb",
      "failure-case-0cb9a8776e187180",
      "failure-case-5697e0fb63211c89",
    ],
    input: {
      scenarioName: "checkout-payment-timeout",
      mode: "mock",
      mockResponse: withDuplicateRecommendationAction(
        mockDecisionForName("checkout-payment-timeout"),
      ),
    },
    assert(output) {
      if (output.run_status !== "completed") {
        throw new Error("Expected duplicate recommendation action to preserve the bounded decision.");
      }
      const explanationValidation = objectValue(output.explanation_validation);
      const warnings = Array.isArray(explanationValidation.warnings)
        ? explanationValidation.warnings.map(String)
        : [];
      if (
        explanationValidation.status !== "degraded" ||
        !warnings.some((warning) => warning.includes("must not include next_action"))
      ) {
        throw new Error("Expected duplicate recommendation action to degrade the explanation.");
      }
      const recommendation = objectValue(output.recommendation);
      const decision = objectValue(output.decision);
      if ("next_action" in recommendation || decision.next_action !== "escalate_owner") {
        throw new Error("Expected decision.next_action to remain the only action authority.");
      }
    },
  },
];

export function validateFailureRegressionRegistry(
  cases: FailureRegressionCase[],
  options: {
    taxonomyPath?: string;
    caseDirectory?: string;
  } = {},
): string[] {
  const taxonomyPath = options.taxonomyPath ?? "evals/failure-taxonomy.json";
  const caseDirectory = options.caseDirectory ?? "evals/failure-cases";
  const errors: string[] = [];
  let taxonomy;
  try {
    taxonomy = loadFailureTaxonomy(taxonomyPath);
  } catch (error) {
    return [`Unable to load failure taxonomy: ${error instanceof Error ? error.message : String(error)}`];
  }
  const seenIds = new Set<string>();
  for (const regression of cases) {
    if (seenIds.has(regression.id)) {
      errors.push(`Regression id ${regression.id} is duplicated.`);
    }
    seenIds.add(regression.id);
    const mode = findFailureMode(
      taxonomy,
      regression.failureMode.id,
      regression.failureMode.revision,
    );
    if (!mode) {
      errors.push(
        `Regression ${regression.id} references missing mode ${regression.failureMode.id} revision ${regression.failureMode.revision}.`,
      );
    } else if (mode.status !== "active") {
      errors.push(
        `Regression ${regression.id} references non-active mode ${mode.id} revision ${mode.revision}.`,
      );
    }
    if (regression.input.mode === "live") {
      errors.push(`Regression ${regression.id} must not require live provider execution.`);
    }
    if (regression.sourceCaseIds.length === 0) {
      errors.push(`Regression ${regression.id} must reference at least one promoted source case.`);
    }
    for (const sourceCaseId of regression.sourceCaseIds) {
      if (mode && !mode.sourceCaseIds.includes(sourceCaseId)) {
        errors.push(`Mode ${mode.id} revision ${mode.revision} does not reference source case ${sourceCaseId}.`);
      }
      try {
        const snapshot = loadPromotedCase(join(caseDirectory, `${sourceCaseId}.json`));
        if (
          snapshot.failureMode &&
          (
            snapshot.failureMode.id !== regression.failureMode.id ||
            snapshot.failureMode.revision > regression.failureMode.revision
          )
        ) {
          errors.push(
            `Source case ${sourceCaseId} has incompatible failure-mode provenance for ${regression.failureMode.id} revision ${regression.failureMode.revision}.`,
          );
        }
      } catch (error) {
        errors.push(
          `Regression ${regression.id} references missing or invalid source case ${sourceCaseId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return errors;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function withDuplicateRecommendationAction(response: object): object {
  const clone = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  const recommendation = objectValue(clone.recommendation);
  const decision = objectValue(clone.decision);
  recommendation.next_action = decision.next_action;
  clone.recommendation = recommendation;
  return clone;
}
