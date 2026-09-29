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
  input: IncidentTriageEvalInput & { mockResponse: object };
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
          snapshot.failureMode?.id !== regression.failureMode.id ||
          snapshot.failureMode.revision !== regression.failureMode.revision
        ) {
          errors.push(
            `Source case ${sourceCaseId} does not reference ${regression.failureMode.id} revision ${regression.failureMode.revision}.`,
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
