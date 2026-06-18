import { type Scenario } from "./domain";
import { PrebuiltOperationalTools, loadTools, type Evidence } from "./evidence";
import { GrafanaPayloadError, normalizeGrafanaPayload } from "./grafana";
import type { LLMDecisionClient } from "./llm";
import { TriageWorkflow, type TriageRun } from "./workflow";

export interface WebhookRuntime {
  fixturesDir: string;
  webhookSecret: string;
  llmClient: LLMDecisionClient;
  lokiClient?: LokiClientLike;
  lokiLimit: number;
}

export interface LokiClientLike {
  queryRange(
    labels: Record<string, string>,
    startNs: number,
    endNs: number,
    options: { limit?: number; direction?: "forward" | "backward" },
  ): Promise<LokiLogEntryLike[]>;
  toEvidence(entries: LokiLogEntryLike[]): Evidence[];
}

interface LokiLogEntryLike {
  timestampNs: string;
  line: string;
  labels: Record<string, string>;
}

export async function handleGrafanaWebhook(
  payload: unknown,
  providedSecret: string | undefined,
  runtime: WebhookRuntime,
): Promise<[number, Record<string, unknown>]> {
  if (runtime.webhookSecret && providedSecret !== runtime.webhookSecret) {
    return [401, { status: "error", error: "unauthorized" }];
  }

  let normalized;
  try {
    normalized = normalizeGrafanaPayload(payload);
  } catch (error) {
    if (error instanceof GrafanaPayloadError || error instanceof Error) {
      return [400, { status: "error", error: error.message }];
    }
    return [400, { status: "error", error: String(error) }];
  }

  if (normalized.ignored) {
    return [202, {
      status: "ignored",
      reason: normalized.ignoredReason,
      incident_id: normalized.incident.incidentId,
    }];
  }

  const extraMissing: string[] = [];
  let logEvidence: Evidence[] = [];
  if (runtime.lokiClient) {
    try {
      const entries = await runtime.lokiClient.queryRange(
        normalized.lokiQueryLabels,
        normalized.startNs,
        normalized.endNs,
        { limit: runtime.lokiLimit, direction: "forward" },
      );
      logEvidence = runtime.lokiClient.toEvidence(entries);
      if (logEvidence.length === 0) {
        extraMissing.push("logs");
      }
    } catch {
      extraMissing.push("logs");
    }
  } else {
    extraMissing.push("logs");
  }

  const tools = loadTools(runtime.fixturesDir);
  const package_ = tools.buildEvidencePackageFromIncident(
    normalized.scenarioName,
    normalized.incident,
    { logEvidence, extraMissingContext: extraMissing },
  );
  const scenario: Scenario = {
    name: normalized.scenarioName,
    incident: normalized.incident,
  };
  const workflow = new TriageWorkflow(new PrebuiltOperationalTools(package_), runtime.llmClient);
  const run = await workflow.run(scenario);
  return [200, runToResponse(run)];
}

export function runToResponse(run: TriageRun): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: "ok",
    incident: {
      incident_id: run.scenario.incident.incidentId,
      title: run.scenario.incident.title,
      severity: run.scenario.incident.severity,
      service: run.scenario.incident.service,
      status: run.scenario.incident.status,
      started_at: run.scenario.incident.startedAt,
    },
    scenario: run.scenario.name,
    states: run.states,
  };

  if (run.validation) {
    response.validation = {
      valid: run.validation.valid,
      errors: run.validation.errors,
    };
    if (run.validation.decision) {
      response.decision = {
        incident_class: run.validation.decision.incidentClass,
        next_action: run.validation.decision.nextAction,
        confidence: run.validation.decision.confidence,
        evidence_ids: run.validation.decision.evidenceIds,
        caveats: run.validation.decision.caveats,
        verification_plan: run.validation.decision.verificationPlan,
      };
    }
  }

  if (run.evidencePackage) {
    const provenance = run.evidencePackage.provenanceSummary(run.validation?.decision?.evidenceIds ?? []);
    response.evidence = run.evidencePackage.evidence.map((item) => ({
      evidence_id: item.evidenceId,
      source: item.source,
      source_tier: item.sourceTier,
      summary: item.summary,
    }));
    response.provenance = {
      available_tiers: provenance.availableTiers,
      cited_tiers: provenance.citedTiers,
      cited_sources: provenance.citedSources,
      cited_evidence_ids: provenance.citedEvidenceIds,
      missing_context: provenance.missingContext,
      support: provenance.historicalOnly ? "historical_only" : provenance.hasCurrentOrOperationalSupport ? "current_or_operational" : "none",
    };
  }

  if (run.safety) {
    response.safety = run.safety;
  }

  if (run.scorecard) {
    response.scorecard = {
      scenario_name: run.scorecard.scenarioName,
      scores: run.scorecard.scores,
      notes: run.scorecard.notes,
    };
  }

  return response;
}
