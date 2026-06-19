import { spawn } from "node:child_process";
import * as v from "valibot";
import type { AppConfig } from "./config";
import { redactSecret } from "./config";
import { incidentClasses, nextActions, type IncidentClass, type NextAction } from "./domain";
import type { EvidencePackage } from "./evidence";
import { noopLogger, type TriageLogger } from "./logger";

export const lowConfidenceThreshold = 0.55;

export interface TriageDecision {
  incidentClass: IncidentClass;
  nextAction: NextAction;
  confidence: number;
  evidenceIds: string[];
  caveats: string[];
  verificationPlan: string[];
}

export type HypothesisStatus = "supported" | "contradicted" | "inconclusive";

export interface EvidenceHypothesis {
  label: string;
  status: HypothesisStatus;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export interface TriageRecommendation {
  rationale: string;
  evidenceIds: string[];
}

export interface TriageExplanation {
  hypotheses?: EvidenceHypothesis[];
  findingSummary?: string;
  recommendation?: TriageRecommendation;
}

export type ExplanationValidationStatus = "valid" | "degraded" | "not_available";

export interface ExplanationValidation {
  status: ExplanationValidationStatus;
  warnings: string[];
}

export interface ValidationResult {
  decision?: TriageDecision;
  explanation?: TriageExplanation;
  explanationValidation?: ExplanationValidation;
  valid: boolean;
  errors: string[];
  rawText: string;
}

export interface LLMDecisionClient {
  decide(evidencePackage: EvidencePackage): Promise<ValidationResult>;
}

export class DecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionValidationError";
  }
}

export const incidentTriageDecisionSchema = v.object({
  incident_class: v.picklist(incidentClasses),
  next_action: v.picklist(nextActions),
  confidence: v.number(),
  evidence_ids: v.array(v.string()),
  caveats: v.array(v.string()),
  verification_plan: v.array(v.string()),
});

export const incidentTriageExpandedSchema = v.object({
  analysis: v.optional(v.object({
    hypotheses: v.array(v.object({
      label: v.string(),
      status: v.picklist(["supported", "contradicted", "inconclusive"]),
      supporting_evidence_ids: v.array(v.string()),
      contradicting_evidence_ids: v.array(v.string()),
    })),
  })),
  finding_summary: v.optional(v.string()),
  recommendation: v.optional(v.object({
    rationale: v.string(),
    evidence_ids: v.array(v.string()),
    next_action: v.optional(v.unknown()),
  })),
  decision: incidentTriageDecisionSchema,
});

export class StaticDecisionClient implements LLMDecisionClient {
  constructor(private readonly responses: Record<string, string>) {}

  async decide(evidencePackage: EvidencePackage): Promise<ValidationResult> {
    const text = this.responses[evidencePackage.scenarioName];
    if (text === undefined) {
      return {
        valid: false,
        errors: [`No static LLM response for scenario: ${evidencePackage.scenarioName}.`],
        rawText: "",
      };
    }
    return parseDecisionText(text, evidencePackage);
  }
}

export class FlueDecisionClient implements LLMDecisionClient {
  constructor(
    private readonly config: AppConfig,
    private readonly runSkill: (
      evidencePackage: EvidencePackage,
      config: AppConfig,
      logger: TriageLogger,
    ) => Promise<unknown> =
      runIncidentTriageSkill,
    private readonly logger: TriageLogger = noopLogger,
  ) {}

  async decide(evidencePackage: EvidencePackage): Promise<ValidationResult> {
    try {
      const payload = await this.runSkill(evidencePackage, this.config, this.logger);
      const result = validateTriagePayload(payload, evidencePackage);
      return {
        valid: true,
        errors: [],
        rawText: JSON.stringify(payload),
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        errors: [redactSecret(message, this.config)],
        rawText: "",
      };
    }
  }
}

export interface FlueCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

type FlueExecutor = (payload: unknown, config: AppConfig, logger: TriageLogger) => Promise<FlueCommandResult>;

export async function runIncidentTriageSkill(
  evidencePackage: EvidencePackage,
  config: AppConfig,
  loggerOrExecute: TriageLogger | ((payload: unknown, config: AppConfig) => Promise<FlueCommandResult>) = noopLogger,
  execute?: FlueExecutor,
): Promise<unknown> {
  const logger = typeof loggerOrExecute === "function" ? noopLogger : loggerOrExecute;
  const runFlue: FlueExecutor = typeof loggerOrExecute === "function"
    ? (payload, appConfig, _activeLogger) => loggerOrExecute(payload, appConfig)
    : (execute ?? executeFlueRun);
  const result = await runFlue({ evidencePackage }, config, logger);
  if (result.exitCode !== 0) {
    const errorText = result.stderr.trim() || result.stdout.trim() || `flue run exited with code ${result.exitCode}`;
    throw new DecisionValidationError(redactSecret(`Flue incident-triage workflow failed: ${errorText}`, config));
  }
  return parseFlueRunOutput(result.stdout);
}

export async function executeFlueRun(
  payload: unknown,
  config: AppConfig,
  logger: TriageLogger = noopLogger,
): Promise<FlueCommandResult> {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "flue",
    "run",
    "incident-triage",
    "--target",
    "node",
    "--payload",
    JSON.stringify(payload),
  ];
  logger.debug({
    component: "flue",
    command,
    payloadBytes: args.at(-1)?.length ?? 0,
  }, "Starting Flue incident-triage workflow process");
  const proc = spawn(command, args, {
    env: {
      ...process.env,
      MINIMAX_API_KEY: config.minimaxApiKey,
      MODEL_NAME: config.modelName,
      MINIMAX_BASE_URL: config.minimaxBaseUrl,
    },
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer | string) => {
      const value = String(chunk);
      stdout += value;
      logFlueChunk(logger, config, "stdout", value);
    });
    proc.stderr.on("data", (chunk: Buffer | string) => {
      const value = String(chunk);
      stderr += value;
      logFlueChunk(logger, config, "stderr", value);
    });
    proc.on("error", reject);
    proc.on("close", (exitCode) => {
      logger.debug({
        component: "flue",
        exitCode,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      }, "Flue incident-triage workflow process complete");
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function logFlueChunk(logger: TriageLogger, config: AppConfig, stream: "stdout" | "stderr", chunk: string): void {
  const redacted = redactSecret(chunk, config).trimEnd();
  if (!redacted) {
    return;
  }
  for (const line of redacted.split(/\r?\n/)) {
    if (line.trim()) {
      logger.debug({ component: "flue", stream }, line);
    }
  }
}

export function parseFlueRunOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new DecisionValidationError("Flue incident-triage workflow did not return JSON output.");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start >= 0) {
      return JSON.parse(trimmed.slice(start + 1));
    }
    throw new DecisionValidationError("Flue incident-triage workflow returned malformed JSON output.");
  }
}

export function parseDecisionText(text: string, evidencePackage?: EvidencePackage): ValidationResult {
  const cleaned = stripJsonFence(text);
  try {
    const payload = JSON.parse(cleaned) as unknown;
    const result = validateTriagePayload(payload, evidencePackage);
    return { ...result, valid: true, errors: [], rawText: text };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      rawText: text,
    };
  }
}

export function validateTriagePayload(payload: unknown, evidencePackage?: EvidencePackage): Omit<ValidationResult, "valid" | "errors" | "rawText"> {
  if (isRecord(payload) && "decision" in payload) {
    const decision = validateDecisionPayload(payload.decision, evidencePackage);
    return {
      decision,
      ...validateExplanationPayload(payload, evidencePackage),
    };
  }

  return {
    decision: validateDecisionPayload(payload, evidencePackage),
    explanationValidation: {
      status: "not_available",
      warnings: ["Expanded explanation layer was not returned; accepted legacy decision-only payload."],
    },
  };
}

export function validateDecisionPayload(payload: unknown, evidencePackage?: EvidencePackage): TriageDecision {
  const parsed = v.parse(incidentTriageDecisionSchema, payload);
  if (parsed.confidence < 0 || parsed.confidence > 1) {
    throw new DecisionValidationError("Decision confidence must be between 0 and 1.");
  }
  if (parsed.confidence < lowConfidenceThreshold) {
    throw new DecisionValidationError("Decision confidence is too low for workflow use.");
  }

  if (evidencePackage) {
    const knownIds = evidencePackage.ids();
    const unknown = parsed.evidence_ids.filter((id) => !knownIds.has(id)).sort();
    if (unknown.length > 0) {
      throw new DecisionValidationError(`Decision cited unknown evidence IDs: ${unknown.join(", ")}.`);
    }
  }

  return {
    incidentClass: parsed.incident_class,
    nextAction: parsed.next_action,
    confidence: parsed.confidence,
    evidenceIds: parsed.evidence_ids,
    caveats: parsed.caveats,
    verificationPlan: parsed.verification_plan,
  };
}

function validateExplanationPayload(
  payload: Record<string, unknown>,
  evidencePackage?: EvidencePackage,
): { explanation?: TriageExplanation; explanationValidation: ExplanationValidation } {
  const warnings: string[] = [];
  const explanation: TriageExplanation = {};

  const analysis = payload.analysis;
  if (!isRecord(analysis)) {
    warnings.push("Explanation analysis is missing or malformed.");
  } else if (!Array.isArray(analysis.hypotheses)) {
    warnings.push("Explanation hypotheses are missing or malformed.");
  } else {
    const hypotheses = analysis.hypotheses.flatMap((candidate, index) => {
      const hypothesis = validateHypothesis(candidate, index, evidencePackage);
      warnings.push(...hypothesis.warnings);
      return hypothesis.value ? [hypothesis.value] : [];
    });
    if (hypotheses.length > 0) {
      explanation.hypotheses = hypotheses;
    }
  }

  if (typeof payload.finding_summary === "string" && payload.finding_summary.trim()) {
    explanation.findingSummary = payload.finding_summary;
  } else {
    warnings.push("Explanation finding_summary is missing or malformed.");
  }

  const recommendation = validateRecommendation(payload.recommendation, evidencePackage);
  warnings.push(...recommendation.warnings);
  if (recommendation.value) {
    explanation.recommendation = recommendation.value;
  }

  warnings.push(...claimQualityWarnings(explanation, evidencePackage));

  const hasExplanation = Object.keys(explanation).length > 0;
  const result: { explanation?: TriageExplanation; explanationValidation: ExplanationValidation } = {
    explanationValidation: {
      status: warnings.length > 0 ? "degraded" : "valid",
      warnings,
    },
  };
  if (hasExplanation) {
    result.explanation = explanation;
  }
  return result;
}

function validateHypothesis(
  candidate: unknown,
  index: number,
  evidencePackage?: EvidencePackage,
): { value?: EvidenceHypothesis; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecord(candidate)) {
    return { warnings: [`Hypothesis ${index} is malformed.`] };
  }

  const label = candidate.label;
  const status = candidate.status;
  const supporting = candidate.supporting_evidence_ids;
  const contradicting = candidate.contradicting_evidence_ids;
  if (typeof label !== "string" || !label.trim()) {
    warnings.push(`Hypothesis ${index} label is missing or malformed.`);
  }
  if (!isHypothesisStatus(status)) {
    warnings.push(`Hypothesis ${index} status is missing or unsupported.`);
  }
  if (!isStringArray(supporting)) {
    warnings.push(`Hypothesis ${index} supporting_evidence_ids are missing or malformed.`);
  }
  if (!isStringArray(contradicting)) {
    warnings.push(`Hypothesis ${index} contradicting_evidence_ids are missing or malformed.`);
  }

  if (warnings.length > 0) {
    return { warnings };
  }

  const supportingEvidenceIds = supporting as string[];
  const contradictingEvidenceIds = contradicting as string[];
  const evidenceWarnings = unknownEvidenceWarnings(
    [...supportingEvidenceIds, ...contradictingEvidenceIds],
    evidencePackage,
    `Hypothesis ${index}`,
  );
  if (evidenceWarnings.length > 0) {
    return { warnings: evidenceWarnings };
  }

  return {
    value: {
      label: label as string,
      status: status as HypothesisStatus,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    },
    warnings: [],
  };
}

function validateRecommendation(
  candidate: unknown,
  evidencePackage?: EvidencePackage,
): { value?: TriageRecommendation; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecord(candidate)) {
    return { warnings: ["Recommendation is missing or malformed."] };
  }
  if ("next_action" in candidate) {
    warnings.push("Recommendation must not include next_action; use decision.next_action as the authoritative action.");
  }
  if (typeof candidate.rationale !== "string" || !candidate.rationale.trim()) {
    warnings.push("Recommendation rationale is missing or malformed.");
  }
  if (!isStringArray(candidate.evidence_ids)) {
    warnings.push("Recommendation evidence_ids are missing or malformed.");
  }
  if (warnings.length > 0) {
    return { warnings };
  }

  const evidenceIds = candidate.evidence_ids as string[];
  const evidenceWarnings = unknownEvidenceWarnings(evidenceIds, evidencePackage, "Recommendation");
  if (evidenceWarnings.length > 0) {
    return { warnings: evidenceWarnings };
  }

  return {
    value: {
      rationale: candidate.rationale as string,
      evidenceIds,
    },
    warnings: [],
  };
}

function unknownEvidenceWarnings(ids: string[], evidencePackage: EvidencePackage | undefined, label: string): string[] {
  if (!evidencePackage) {
    return [];
  }
  const knownIds = evidencePackage.ids();
  const unknown = ids.filter((id) => !knownIds.has(id)).sort();
  return unknown.length > 0 ? [`${label} cited unknown evidence IDs: ${unknown.join(", ")}.`] : [];
}

function claimQualityWarnings(explanation: TriageExplanation, evidencePackage?: EvidencePackage): string[] {
  if (!evidencePackage) {
    return [];
  }
  const text = [
    explanation.findingSummary,
    explanation.recommendation?.rationale,
    ...(explanation.hypotheses ?? []).map((hypothesis) => hypothesis.label),
  ].filter((value): value is string => typeof value === "string").join(" ");

  const warnings: string[] = [];
  if (claimsDeployWasMinutesBeforeIncident(text) && !hasDeployWithinMinutes(evidencePackage, 60)) {
    warnings.push("Explanation claims deploy timing in minutes, but supplied deploy evidence is not within 60 minutes of incident start.");
  }
  if (claimsPaymentGatewayOwner(text) && !hasServiceOwnerEvidence(evidencePackage, "payment-gateway")) {
    warnings.push("Explanation claims payment-gateway owner context, but supplied service ownership evidence does not identify payment-gateway ownership.");
  }
  return warnings;
}

function claimsDeployWasMinutesBeforeIncident(text: string): boolean {
  return /\bdeploy\w*\b[\s\S]{0,80}\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+minutes?\s+before\b/i.test(text) ||
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+minutes?\s+before[\s\S]{0,80}\bdeploy\w*\b/i.test(text);
}

function hasDeployWithinMinutes(evidencePackage: EvidencePackage, minutes: number): boolean {
  const incidentStart = Date.parse(evidencePackage.incident.startedAt);
  if (!Number.isFinite(incidentStart)) {
    return false;
  }
  return evidencePackage.incident.recentChanges.some((change) => {
    const changedAt = Date.parse(change.time);
    return Number.isFinite(changedAt) && Math.abs(incidentStart - changedAt) <= minutes * 60_000;
  });
}

function claimsPaymentGatewayOwner(text: string): boolean {
  return /\bpayment[-\s]?gateway\b[\s\S]{0,80}\bowner\b/i.test(text) ||
    /\bowner\b[\s\S]{0,80}\bpayment[-\s]?gateway\b/i.test(text);
}

function hasServiceOwnerEvidence(evidencePackage: EvidencePackage, serviceName: string): boolean {
  return evidencePackage.evidence.some((item) => item.evidenceId === `service:${serviceName}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return value === "supported" || value === "contradicted" || value === "inconclusive";
}

function stripJsonFence(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith("```")) {
    return stripped;
  }
  const lines = stripped.split(/\r?\n/);
  if (lines[0]?.startsWith("```")) {
    lines.shift();
  }
  if (lines.at(-1)?.trim() === "```") {
    lines.pop();
  }
  return lines.join("\n").trim();
}
