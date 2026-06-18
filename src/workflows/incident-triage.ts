import { createAgent, registerProvider, type FlueContext } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import type { AppConfig } from "../config";
import { incidentClasses, nextActions } from "../domain";
import type { EvidencePackage } from "../evidence";
import { incidentTriageDecisionSchema } from "../llm";

interface IncidentTriagePayload {
  evidencePackage: EvidencePackage;
}

export async function run({ init, payload }: FlueContext<IncidentTriagePayload>) {
  const config = configFromEnvironment();
  registerMiniMaxAnthropicProvider(config);
  const harness = await init(createIncidentTriageAgent(config));
  const session = await harness.session();
  const response = await session.skill("incident-triage", {
    args: {
      evidencePackage: evidencePackageForSkill(payload.evidencePackage),
      allowedIncidentClasses: incidentClasses,
      allowedNextActions: nextActions,
    },
    result: incidentTriageDecisionSchema,
  });
  return response.data;
}

function createIncidentTriageAgent(config: AppConfig) {
  return createAgent(() => ({
    model: `anthropic/${config.modelName}`,
    sandbox: local({ env: {} }),
  }));
}

function registerMiniMaxAnthropicProvider(config: AppConfig): void {
  registerProvider("anthropic", {
    baseUrl: `${config.minimaxBaseUrl.replace(/\/$/, "")}/anthropic`,
    apiKey: config.minimaxApiKey,
    headers: {
      "X-Api-Key": config.minimaxApiKey,
    },
  });
}

function evidencePackageForSkill(evidencePackage: EvidencePackage): Record<string, unknown> {
  return {
    scenario_name: evidencePackage.scenarioName,
    incident: evidencePackage.incident,
    missing_context: evidencePackage.missingContext,
    evidence: evidencePackage.evidence,
  };
}

function configFromEnvironment(): AppConfig {
  const minimaxApiKey = process.env.MINIMAX_API_KEY;
  const modelName = process.env.MODEL_NAME;
  if (!minimaxApiKey || !modelName) {
    throw new Error("Missing required MiniMax environment: MINIMAX_API_KEY, MODEL_NAME.");
  }
  const minimaxBaseUrl = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io";
  return {
    minimaxApiKey,
    modelName,
    minimaxBaseUrl,
    redacted: {
      MINIMAX_API_KEY: "<redacted>",
      MODEL_NAME: modelName,
      MINIMAX_BASE_URL: minimaxBaseUrl,
    },
  };
}
