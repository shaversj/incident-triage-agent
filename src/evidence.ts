import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureError, type Incident, type Scenario, type SourceTier, sourceTiers } from "./domain";

export interface Evidence {
  evidenceId: string;
  source: string;
  sourceTier: SourceTier;
  summary: string;
  detail: string;
}

export const investigationStepKinds = [
  "inspect_alerts",
  "inspect_symptoms",
  "inspect_deploys",
  "inspect_logs",
  "inspect_service_owner",
  "inspect_runbooks",
  "inspect_prior_incidents",
  "inspect_verification_signals",
] as const;

export type InvestigationStepKind = (typeof investigationStepKinds)[number];

export const investigationStepStatuses = ["found", "not_found", "skipped", "error"] as const;

export type InvestigationStepStatus = (typeof investigationStepStatuses)[number];

export interface InvestigationStep {
  id: string;
  kind: InvestigationStepKind;
  status: InvestigationStepStatus;
  purpose: string;
  evidenceIds: string[];
}

export interface ProvenanceSummary {
  availableTiers: SourceTier[];
  citedTiers: SourceTier[];
  citedSources: string[];
  citedEvidenceIds: string[];
  missingContext: string[];
  hasCurrentOrOperationalSupport: boolean;
  historicalOnly: boolean;
}

export class EvidencePackage {
  constructor(
    readonly scenarioName: string,
    readonly incident: Incident,
    readonly evidence: Evidence[],
    readonly missingContext: string[] = [],
    readonly investigationSteps: InvestigationStep[] = [],
  ) {}

  ids(): Set<string> {
    return new Set(this.evidence.map((item) => item.evidenceId));
  }

  byId(): Map<string, Evidence> {
    return new Map(this.evidence.map((item) => [item.evidenceId, item]));
  }

  provenanceSummary(citedEvidenceIds: string[] = []): ProvenanceSummary {
    const evidenceById = this.byId();
    const cited = citedEvidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is Evidence => item !== undefined);
    const citedTiers = orderedTiers(cited.map((item) => item.sourceTier));
    return {
      availableTiers: orderedTiers(this.evidence.map((item) => item.sourceTier)),
      citedTiers,
      citedSources: orderedStrings(cited.map((item) => item.source)),
      citedEvidenceIds: cited.map((item) => item.evidenceId),
      missingContext: this.missingContext,
      hasCurrentOrOperationalSupport: citedTiers.some((tier) =>
        tier === "current_signal" || tier === "operational_context"
      ),
      historicalOnly: citedTiers.length > 0 && citedTiers.every((tier) => tier === "historical_context"),
    };
  }
}

export class MockOperationalTools {
  constructor(readonly fixturesDir: string) {}

  buildEvidencePackage(scenario: Scenario): EvidencePackage {
    return this.buildEvidencePackageFromIncident(scenario.name, scenario.incident);
  }

  buildEvidencePackageFromIncident(
    scenarioName: string,
    incident: Incident,
    options: { logEvidence?: Evidence[]; extraMissingContext?: string[] } = {},
  ): EvidencePackage {
    const evidence: Evidence[] = [];
    const missing = [...(options.extraMissingContext ?? [])];
    const steps: InvestigationStep[] = [];

    const alerts = this.alertEvidence(incident);
    evidence.push(...alerts);
    steps.push(investigationStep(steps.length, "inspect_alerts", "Inspect active alert names for the affected service.", alerts));

    const symptoms = this.symptomEvidence(incident);
    evidence.push(...symptoms);
    steps.push(investigationStep(steps.length, "inspect_symptoms", "Inspect reported symptoms and customer impact signals.", symptoms));

    const deploys = this.deployEvidence(incident);
    evidence.push(...deploys);
    steps.push(investigationStep(steps.length, "inspect_deploys", "Check deploy and recent-change evidence near the incident window.", deploys));

    const logs = options.logEvidence !== undefined ? options.logEvidence : this.logEvidence(incident);
    evidence.push(...logs);
    if (logs.length === 0) {
      missing.push("logs");
    }
    steps.push(investigationStep(steps.length, "inspect_logs", "Inspect operational log signals for the incident window.", logs));

    const service = this.serviceEvidence(incident);
    if (service) {
      evidence.push(service);
    } else {
      missing.push(`service:${incident.service}`);
    }
    steps.push(investigationStep(steps.length, "inspect_service_owner", `Look up owner and escalation metadata for ${incident.service}.`, service ? [service] : []));

    const runbooks = this.runbookEvidence(incident);
    if (runbooks.length > 0) {
      evidence.push(...runbooks);
    } else {
      missing.push("runbook");
    }
    steps.push(investigationStep(
      steps.length,
      "inspect_runbooks",
      "Load runbook guidance referenced by the incident.",
      runbooks,
      incident.runbookRefs.length === 0 ? "skipped" : undefined,
    ));

    const prior = this.priorIncidentEvidence(incident);
    if (prior.length > 0) {
      evidence.push(...prior);
    } else if (incident.priorIncidentRefs.length > 0) {
      missing.push("prior_incident");
    }
    steps.push(investigationStep(
      steps.length,
      "inspect_prior_incidents",
      "Load prior incident context referenced by the incident.",
      prior,
      incident.priorIncidentRefs.length === 0 ? "skipped" : undefined,
    ));

    const verification = this.verificationEvidence(incident);
    evidence.push(...verification);
    if (incident.verificationSignals.length === 0) {
      missing.push("verification");
    }
    steps.push(investigationStep(steps.length, "inspect_verification_signals", "Inspect verification and recovery signals.", verification));

    return new EvidencePackage(scenarioName, incident, evidence, orderedStrings(missing), steps);
  }

  alertEvidence(incident: Incident): Evidence[] {
    return incident.alerts.map((alert, index) => ({
      evidenceId: `alert:${index}`,
      source: "alert",
      sourceTier: "current_signal",
      summary: alert,
      detail: `Alert fired for ${incident.service}: ${alert}`,
    }));
  }

  symptomEvidence(incident: Incident): Evidence[] {
    return incident.symptoms.map((symptom, index) => ({
      evidenceId: `symptom:${index}`,
      source: "symptom",
      sourceTier: "current_signal",
      summary: symptom,
      detail: symptom,
    }));
  }

  deployEvidence(incident: Incident): Evidence[] {
    if (incident.recentChanges.length > 0) {
      return incident.recentChanges.map((change, index) => deployToEvidence(change.service, change.time, change.change, index));
    }
    return this.fixtureDeployEvidence(incident);
  }

  fixtureDeployEvidence(incident: Incident): Evidence[] {
    const path = join(this.fixturesDir, "deploys", "deploys.json");
    if (!existsSync(path)) {
      return [];
    }
    const deploys = readJsonArray(path);
    return deploys
      .filter((item) => readOptionalString(item.service) === incident.service)
      .map((item, index) => deployToEvidence(readString(item.service, "service"), readString(item.time, "time"), readString(item.change, "change"), index));
  }

  logEvidence(incident: Incident): Evidence[] {
    return incident.logSignals.map((signal, index) => ({
      evidenceId: `log:${index}`,
      source: "log",
      sourceTier: "operational_context",
      summary: signal,
      detail: signal,
    }));
  }

  serviceEvidence(incident: Incident): Evidence | undefined {
    const path = join(this.fixturesDir, "services", "services.json");
    if (!existsSync(path)) {
      return undefined;
    }
    const services = readJsonObject(path);
    const service = services[incident.service];
    if (!service || typeof service !== "object" || Array.isArray(service)) {
      return undefined;
    }
    const payload = service as Record<string, unknown>;
    const owner = readString(payload.owner, "owner");
    const escalation = readString(payload.escalation, "escalation");
    return {
      evidenceId: `service:${incident.service}`,
      source: "service",
      sourceTier: "operational_context",
      summary: `${incident.service} owned by ${owner}`,
      detail: `Escalation: ${escalation}`,
    };
  }

  runbookEvidence(incident: Incident): Evidence[] {
    const evidence: Evidence[] = [];
    for (const ref of incident.runbookRefs) {
      const path = join(this.fixturesDir, "runbooks", `${ref}.md`);
      if (!existsSync(path)) {
        continue;
      }
      const text = readFileSync(path, "utf8").trim();
      const firstLine = text.split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").trim() || ref;
      evidence.push({
        evidenceId: `runbook:${ref}`,
        source: "runbook",
        sourceTier: "guidance",
        summary: firstLine,
        detail: text,
      });
    }
    return evidence;
  }

  priorIncidentEvidence(incident: Incident): Evidence[] {
    const path = join(this.fixturesDir, "prior_incidents", "prior-incidents.json");
    if (!existsSync(path)) {
      return [];
    }
    const priorIncidents = readJsonArray(path);
    const byId = new Map(priorIncidents.map((item) => [readString(item.incident_id, "incident_id"), item]));
    return incident.priorIncidentRefs.flatMap((ref) => {
      const item = byId.get(ref);
      if (!item) {
        return [];
      }
      return [{
        evidenceId: `prior:${ref}`,
        source: "prior_incident",
        sourceTier: "historical_context" as const,
        summary: readString(item.summary, "summary"),
        detail: readString(item.resolution, "resolution"),
      }];
    });
  }

  verificationEvidence(incident: Incident): Evidence[] {
    return incident.verificationSignals.map((signal, index) => ({
      evidenceId: `verification:${index}`,
      source: "verification",
      sourceTier: "current_signal",
      summary: signal,
      detail: signal,
    }));
  }
}

export class PrebuiltOperationalTools extends MockOperationalTools {
  constructor(private readonly package_: EvidencePackage) {
    super("");
  }

  override buildEvidencePackage(_scenario: Scenario): EvidencePackage {
    return this.package_;
  }
}

export function loadTools(fixturesDir: string): MockOperationalTools {
  if (!existsSync(fixturesDir)) {
    throw new FixtureError(`Fixture directory does not exist: ${fixturesDir}.`);
  }
  return new MockOperationalTools(fixturesDir);
}

function deployToEvidence(service: string, time: string, change: string, index: number): Evidence {
  return {
    evidenceId: `deploy:${index}`,
    source: "deploy",
    sourceTier: "operational_context",
    summary: `${service} change at ${time}`,
    detail: change,
  };
}

function investigationStep(
  index: number,
  kind: InvestigationStepKind,
  purpose: string,
  evidence: Evidence[],
  emptyStatus: InvestigationStepStatus = "not_found",
): InvestigationStep {
  return {
    id: `step:${index}`,
    kind,
    status: evidence.length > 0 ? "found" : emptyStatus,
    purpose,
    evidenceIds: evidence.map((item) => item.evidenceId),
  };
}

function orderedTiers(values: SourceTier[]): SourceTier[] {
  const present = new Set(values);
  return sourceTiers.filter((tier) => present.has(tier));
}

function orderedStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FixtureError(`${path} must contain an object.`);
  }
  return parsed as Record<string, unknown>;
}

function readJsonArray(path: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    throw new FixtureError(`${path} must contain an array of objects.`);
  }
  return parsed as Record<string, unknown>[];
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new FixtureError(`${label} must be a string.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
