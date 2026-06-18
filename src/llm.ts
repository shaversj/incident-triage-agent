import * as v from "valibot";
import type { AppConfig } from "./config";
import { incidentClasses, nextActions, type IncidentClass, type NextAction } from "./domain";
import type { EvidencePackage } from "./evidence";

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
    private readonly runSkill: (evidencePackage: EvidencePackage, config: AppConfig) => Promise<unknown>,
  ) {}

  async decide(evidencePackage: EvidencePackage): Promise<ValidationResult> {
    try {
      const payload = await this.runSkill(evidencePackage, this.config);
      const decision = validateDecisionPayload(payload, evidencePackage);
      return {
        decision,
        valid: true,
        errors: [],
        rawText: JSON.stringify(payload),
      };
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
        rawText: "",
      };
    }
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
