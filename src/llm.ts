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

export interface ValidationResult {
  decision?: TriageDecision;
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
      const decision = validateDecisionPayload(payload, evidencePackage);
      return {
        decision,
        valid: true,
        errors: [],
        rawText: JSON.stringify(payload),
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
    const decision = validateDecisionPayload(payload, evidencePackage);
    return { decision, valid: true, errors: [], rawText: text };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      rawText: text,
    };
  }
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
