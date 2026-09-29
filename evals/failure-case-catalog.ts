import type { IncidentTriageEvalInput } from "./harness";
import { runIncidentTriage } from "./harness";
import { fingerprintJson, type FailureRunRecord, type ReviewSourceKind } from "./failure-discovery";
import { mockDecisionForName } from "../src/mock-decisions";
import {
  runRecordedTriageScenario,
  type RecordedScenarioName,
} from "../scripts/run-recorded-triage";

export interface FailureCaseDefinition {
  caseId: string;
  sourceKind: ReviewSourceKind;
  scenarioName: string;
  mode: "mock" | "live";
  description: string;
  mockResponse?: object;
  mockResponseText?: string;
}

const canonicalScenarios = [
  "checkout-payment-timeout",
  "bad-deploy-latency",
  "capacity-saturation",
  "noisy-alert",
] as const;

const recordedScenarios = [
  "checkout-payment-timeout",
  "capacity-saturation",
  "bad-deploy-latency",
] as const satisfies readonly RecordedScenarioName[];

export const defaultFailureCaseCatalog: FailureCaseDefinition[] = [
  ...canonicalScenarios.map((scenarioName) => mockCase(
    scenarioName,
    "baseline",
    "Canonical bounded mock response.",
  )),
  ...canonicalScenarios.map((scenarioName) => mockCase(
    scenarioName,
    "malformed-json",
    "Provider returns malformed JSON.",
    { mockResponseText: "{not json" },
  )),
  ...canonicalScenarios.map((scenarioName) => mockCase(
    scenarioName,
    "unknown-evidence",
    "Decision cites evidence that the workflow did not gather.",
    { mockResponse: withUnknownEvidence(mockDecisionForName(scenarioName)) },
  )),
  ...canonicalScenarios.map((scenarioName) => mockCase(
    scenarioName,
    "missing-rationale",
    "Explanation omits the recommendation rationale.",
    { mockResponse: withoutRecommendationRationale(mockDecisionForName(scenarioName)) },
  )),
  ...canonicalScenarios.map((scenarioName) => mockCase(
    scenarioName,
    "missing-next-action",
    "Bounded decision omits the required next action.",
    { mockResponse: withoutNextAction(mockDecisionForName(scenarioName)) },
  )),
  mockCase(
    "noisy-alert",
    "missing-runbook-context",
    "Approval-sensitive recommendation lacks runbook evidence.",
    { mockResponse: missingRunbookApprovalDecision() },
  ),
  ...recordedScenarios.map((scenarioName) => ({
    caseId: `recorded:${scenarioName}:baseline`,
    sourceKind: "recorded" as const,
    scenarioName,
    mode: "mock" as const,
    description: "Recorded Grafana webhook and Loki-shaped log replay.",
  })),
];

export async function executeFailureCase(
  definition: FailureCaseDefinition,
  generatedAt = new Date().toISOString(),
): Promise<FailureRunRecord> {
  const outcome = definition.sourceKind === "recorded"
    ? await executeRecordedCase(definition)
    : await executeWorkflowCase(definition);
  const runId = `review-run:${definition.caseId}`;
  return {
    schemaVersion: 1,
    runId,
    caseId: definition.caseId,
    sourceKind: definition.sourceKind,
    scenarioName: definition.scenarioName,
    mode: definition.mode,
    generatedAt,
    fingerprint: fingerprintJson({
      caseId: definition.caseId,
      sourceKind: definition.sourceKind,
      scenarioName: definition.scenarioName,
      mode: definition.mode,
      outcome,
    }),
    outcome,
  };
}

async function executeWorkflowCase(definition: FailureCaseDefinition): Promise<Record<string, unknown>> {
  const input: IncidentTriageEvalInput = {
    scenarioName: definition.scenarioName,
    mode: definition.mode,
  };
  if (definition.mockResponse !== undefined) {
    input.mockResponse = definition.mockResponse;
  }
  if (definition.mockResponseText !== undefined) {
    input.mockResponseText = definition.mockResponseText;
  }
  const result = await runIncidentTriage(input);
  return result.output as Record<string, unknown>;
}

async function executeRecordedCase(definition: FailureCaseDefinition): Promise<Record<string, unknown>> {
  if (!isRecordedScenarioName(definition.scenarioName)) {
    throw new Error(`Recorded case uses unsupported scenario ${definition.scenarioName}.`);
  }
  const result = await runRecordedTriageScenario(definition.scenarioName, {
    live: definition.mode === "live",
  });
  return {
    ...result.response,
    recorded_input: result.input,
    recorded_status_code: result.statusCode,
  };
}

function mockCase(
  scenarioName: string,
  variant: string,
  description: string,
  override: Pick<FailureCaseDefinition, "mockResponse" | "mockResponseText"> = {},
): FailureCaseDefinition {
  return {
    caseId: `mock:${scenarioName}:${variant}`,
    sourceKind: "mock",
    scenarioName,
    mode: "mock",
    description,
    ...override,
  };
}

function withUnknownEvidence(response: object): object {
  const clone = cloneObject(response);
  const decision = objectValue(clone.decision);
  decision.evidence_ids = ["unknown:0"];
  clone.decision = decision;
  return clone;
}

function withoutRecommendationRationale(response: object): object {
  const clone = cloneObject(response);
  const recommendation = objectValue(clone.recommendation);
  recommendation.rationale = "";
  clone.recommendation = recommendation;
  return clone;
}

function withoutNextAction(response: object): object {
  const clone = cloneObject(response);
  const decision = objectValue(clone.decision);
  delete decision.next_action;
  clone.decision = decision;
  return clone;
}

function missingRunbookApprovalDecision(): object {
  return {
    analysis: {
      hypotheses: [{
        label: "capacity_saturation",
        status: "supported",
        supporting_evidence_ids: ["alert:0", "log:0", "verification:0"],
        contradicting_evidence_ids: [],
      }],
    },
    finding_summary: "Capacity pressure is possible, but runbook context is missing.",
    recommendation: {
      rationale: "Ask a human before applying an ungrounded runbook step.",
      evidence_ids: ["alert:0", "log:0", "verification:0"],
    },
    decision: {
      incident_class: "capacity_saturation",
      next_action: "apply_runbook_step_with_approval",
      confidence: 0.75,
      evidence_ids: ["alert:0", "log:0", "verification:0"],
      caveats: ["No runbook evidence was found."],
      verification_plan: ["Check latency."],
    },
  };
}

function cloneObject(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecordedScenarioName(value: string): value is RecordedScenarioName {
  return recordedScenarios.includes(value as RecordedScenarioName);
}
