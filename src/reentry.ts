import { createHash } from "node:crypto";
import * as v from "valibot";
import type { Incident } from "./domain";
import type { Evidence, EvidencePackage } from "./evidence";
import type { TriageDecision } from "./llm";

export const evidenceCanonicalizationVersion = "v1";

export type MaterialityOutcome = "first_observation" | "material" | "not_material";
export type MaterialityBasis =
  | "no_baseline"
  | "equivalent"
  | "deterministic_policy"
  | "classifier"
  | "classifier_fallback";

export interface CanonicalEvidenceItem {
  fingerprint: string;
  source: string;
  sourceTier: Evidence["sourceTier"];
  summary: string;
  detail: string;
}

export interface CanonicalEvidencePackage {
  version: typeof evidenceCanonicalizationVersion;
  digest: string;
  incidentFacts: IncidentFacts;
  evidence: CanonicalEvidenceItem[];
  missingContext: string[];
}

export interface EvidenceDeltaItem {
  ref: string;
  fingerprint: string;
  source: string;
  sourceTier: Evidence["sourceTier"];
  summary: string;
}

export interface IncidentFactChange {
  ref: string;
  field: keyof IncidentFacts;
  before: string;
  after: string;
}

export interface EvidenceDelta {
  added: EvidenceDeltaItem[];
  removed: EvidenceDeltaItem[];
  incidentChanges: IncidentFactChange[];
  addedMissingContext: string[];
  resolvedMissingContext: string[];
}

export interface MaterialityDecision {
  outcome: MaterialityOutcome;
  basis: MaterialityBasis;
  rationale: string;
  citedDeltaRefs: string[];
}

export interface MaterialityClassifierInput {
  authority: "materiality_only";
  priorDecision?: Pick<TriageDecision, "incidentClass" | "nextAction" | "confidence">;
  incidentFacts: IncidentFacts;
  addedEvidence: EvidenceDeltaItem[];
  removedEvidence: EvidenceDeltaItem[];
  incidentChanges: IncidentFactChange[];
  addedMissingContext: string[];
  resolvedMissingContext: string[];
  deltaRefs: string[];
}

export interface EvidenceMaterialityClassifier {
  classify(input: MaterialityClassifierInput): Promise<unknown>;
}

export interface EvidenceReentryResult {
  candidate: CanonicalEvidencePackage;
  prior?: CanonicalEvidencePackage;
  delta: EvidenceDelta;
  decision: MaterialityDecision;
}

interface IncidentFacts {
  title: string;
  severity: string;
  status: string;
  service: string;
}

const classifierSchema = v.object({
  material: v.boolean(),
  rationale: v.string(),
  evidence_refs: v.array(v.string()),
});

const maxRationaleLength = 500;
const maxSummaryLength = 240;

export function canonicalizeEvidencePackage(package_: EvidencePackage): CanonicalEvidencePackage {
  const evidence = package_.evidence
    .map(canonicalEvidence)
    .sort((left, right) => canonicalItemText(left).localeCompare(canonicalItemText(right)));
  const incidentFacts = canonicalIncidentFacts(package_.incident);
  const missingContext = orderedUnique(package_.missingContext.map(normalizeText));
  const canonical = {
    version: evidenceCanonicalizationVersion,
    incidentFacts,
    evidence: evidence.map(({ fingerprint: _fingerprint, ...item }) => item),
    missingContext,
  } as const;
  return {
    ...canonical,
    evidence,
    digest: sha256(stableJson(canonical)),
  };
}

export async function evaluateEvidenceReentry(input: {
  candidate: EvidencePackage;
  prior?: EvidencePackage;
  priorDecision?: TriageDecision;
  classifier?: EvidenceMaterialityClassifier;
}): Promise<EvidenceReentryResult> {
  const candidate = canonicalizeEvidencePackage(input.candidate);
  if (!input.prior) {
    return {
      candidate,
      delta: emptyDelta(),
      decision: decision(
        "first_observation",
        "no_baseline",
        "No retained evidence baseline exists for this incident.",
      ),
    };
  }

  const prior = canonicalizeEvidencePackage(input.prior);
  const delta = evidenceDelta(prior, candidate);
  if (prior.digest === candidate.digest) {
    return {
      prior,
      candidate,
      delta,
      decision: decision("not_material", "equivalent", "The incident evidence is unchanged."),
    };
  }

  if (isDeterministicallyMaterial(delta)) {
    return {
      prior,
      candidate,
      delta,
      decision: decision(
        "material",
        "deterministic_policy",
        "The update adds current operational evidence, resolves missing context, or changes a material incident fact.",
        deltaRefs(delta),
      ),
    };
  }

  if (!input.classifier) {
    return {
      prior,
      candidate,
      delta,
      decision: classifierFallback("No materiality classifier is configured."),
    };
  }

  try {
    const refs = deltaRefs(delta);
    const classifierInput: MaterialityClassifierInput = {
      authority: "materiality_only",
      incidentFacts: candidate.incidentFacts,
      addedEvidence: delta.added,
      removedEvidence: delta.removed,
      incidentChanges: delta.incidentChanges,
      addedMissingContext: delta.addedMissingContext,
      resolvedMissingContext: delta.resolvedMissingContext,
      deltaRefs: refs,
    };
    if (input.priorDecision) {
      classifierInput.priorDecision = boundedPriorDecision(input.priorDecision);
    }
    const raw = await input.classifier.classify(classifierInput);
    const parsed = v.parse(classifierSchema, raw);
    const cited = orderedUnique(parsed.evidence_refs);
    if (parsed.rationale.trim().length === 0 || parsed.rationale.length > maxRationaleLength) {
      throw new Error("Materiality rationale is empty or too long.");
    }
    if (cited.length === 0 || cited.some((ref) => !refs.includes(ref))) {
      throw new Error("Materiality classifier cited evidence outside the delta.");
    }
    return {
      prior,
      candidate,
      delta,
      decision: decision(
        parsed.material ? "material" : "not_material",
        "classifier",
        parsed.rationale.trim(),
        cited,
      ),
    };
  } catch {
    return {
      prior,
      candidate,
      delta,
      decision: classifierFallback("Materiality classification was unavailable or invalid."),
    };
  }
}

function evidenceDelta(prior: CanonicalEvidencePackage, candidate: CanonicalEvidencePackage): EvidenceDelta {
  return {
    added: multisetDifference(candidate.evidence, prior.evidence, "added"),
    removed: multisetDifference(prior.evidence, candidate.evidence, "removed"),
    incidentChanges: incidentFactChanges(prior.incidentFacts, candidate.incidentFacts),
    addedMissingContext: candidate.missingContext.filter((value) => !prior.missingContext.includes(value)),
    resolvedMissingContext: prior.missingContext.filter((value) => !candidate.missingContext.includes(value)),
  };
}

function multisetDifference(
  values: CanonicalEvidenceItem[],
  baseline: CanonicalEvidenceItem[],
  direction: "added" | "removed",
): EvidenceDeltaItem[] {
  const remaining = new Map<string, number>();
  for (const item of baseline) {
    remaining.set(item.fingerprint, (remaining.get(item.fingerprint) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  const difference: EvidenceDeltaItem[] = [];
  for (const item of values) {
    const count = remaining.get(item.fingerprint) ?? 0;
    if (count > 0) {
      remaining.set(item.fingerprint, count - 1);
      continue;
    }
    const occurrence = (occurrences.get(item.fingerprint) ?? 0) + 1;
    occurrences.set(item.fingerprint, occurrence);
    difference.push({
      ref: `${direction}:${item.fingerprint.slice(0, 12)}:${occurrence}`,
      fingerprint: item.fingerprint,
      source: item.source,
      sourceTier: item.sourceTier,
      summary: safeSummary(item.summary),
    });
  }
  return difference;
}

function incidentFactChanges(prior: IncidentFacts, candidate: IncidentFacts): IncidentFactChange[] {
  const fields: Array<keyof IncidentFacts> = ["title", "severity", "status", "service"];
  return fields.flatMap((field) => prior[field] === candidate[field]
    ? []
    : [{ ref: `incident:${field}`, field, before: prior[field], after: candidate[field] }]);
}

function isDeterministicallyMaterial(delta: EvidenceDelta): boolean {
  return delta.added.some((item) =>
    item.sourceTier === "current_signal" || item.sourceTier === "operational_context"
  ) ||
    delta.resolvedMissingContext.length > 0 ||
    delta.incidentChanges.some((change) =>
      change.field === "severity" || change.field === "status" || change.field === "service"
    );
}

function deltaRefs(delta: EvidenceDelta): string[] {
  return [
    ...delta.added.map((item) => item.ref),
    ...delta.removed.map((item) => item.ref),
    ...delta.incidentChanges.map((item) => item.ref),
    ...delta.addedMissingContext.map((item) => `missing-added:${item}`),
    ...delta.resolvedMissingContext.map((item) => `missing-resolved:${item}`),
  ];
}

function canonicalEvidence(evidence: Evidence): CanonicalEvidenceItem {
  const item = {
    source: normalizeText(evidence.source),
    sourceTier: evidence.sourceTier,
    summary: normalizeText(evidence.summary),
    detail: normalizeText(evidence.detail),
  };
  return { ...item, fingerprint: sha256(stableJson(item)) };
}

function canonicalIncidentFacts(incident: Incident): IncidentFacts {
  return {
    title: normalizeText(incident.title),
    severity: normalizeText(incident.severity),
    status: normalizeText(incident.status),
    service: normalizeText(incident.service),
  };
}

function boundedPriorDecision(
  decision_: TriageDecision,
): Pick<TriageDecision, "incidentClass" | "nextAction" | "confidence"> {
  return {
    incidentClass: decision_.incidentClass,
    nextAction: decision_.nextAction,
    confidence: decision_.confidence,
  };
}

function decision(
  outcome: MaterialityOutcome,
  basis: MaterialityBasis,
  rationale: string,
  citedDeltaRefs: string[] = [],
): MaterialityDecision {
  return { outcome, basis, rationale: rationale.slice(0, maxRationaleLength), citedDeltaRefs };
}

function classifierFallback(rationale: string): MaterialityDecision {
  return decision("material", "classifier_fallback", rationale);
}

function emptyDelta(): EvidenceDelta {
  return {
    added: [],
    removed: [],
    incidentChanges: [],
    addedMissingContext: [],
    resolvedMissingContext: [],
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function safeSummary(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, maxSummaryLength);
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalItemText(item: CanonicalEvidenceItem): string {
  return `${item.source}\0${item.sourceTier}\0${item.summary}\0${item.detail}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
