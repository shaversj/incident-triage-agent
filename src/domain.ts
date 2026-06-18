import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const incidentClasses = [
  "dependency_outage",
  "bad_deploy",
  "capacity_saturation",
  "noisy_alert",
  "insufficient_context",
  "unknown",
] as const;

export type IncidentClass = (typeof incidentClasses)[number];

export const nextActions = [
  "escalate_owner",
  "request_rollback_approval",
  "apply_runbook_step_with_approval",
  "continue_monitoring",
  "ask_human",
  "gather_more_context",
] as const;

export type NextAction = (typeof nextActions)[number];

export const workflowStates = [
  "received",
  "context_gathered",
  "llm_decision_requested",
  "decision_validated",
  "recoverable_failure",
  "human_input_needed",
  "approval_pending",
  "verification_ready",
  "simulated_action_recorded",
  "scored",
] as const;

export type WorkflowState = (typeof workflowStates)[number];

export const sourceTiers = [
  "current_signal",
  "operational_context",
  "guidance",
  "historical_context",
] as const;

export type SourceTier = (typeof sourceTiers)[number];

export const prohibitedIncidentFields = new Set([
  "suspected_causes",
  "recommended_actions",
  "requires_approval",
]);

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

export interface RecentChange {
  time: string;
  service: string;
  change: string;
}

export interface Incident {
  incidentId: string;
  title: string;
  severity: string;
  status: string;
  startedAt: string;
  service: string;
  symptoms: string[];
  alerts: string[];
  recentChanges: RecentChange[];
  logSignals: string[];
  runbookRefs: string[];
  priorIncidentRefs: string[];
  verificationSignals: string[];
}

export interface EvalExpectation {
  incidentClass: IncidentClass;
  allowedNextActions: NextAction[];
  requiredEvidencePrefixes: string[];
  approvalRequired: boolean;
}

export interface Scenario {
  name: string;
  incident: Incident;
  expected: EvalExpectation;
}

export function validateRawIncidentPayload(payload: Record<string, unknown>): void {
  const present = Object.keys(payload)
    .filter((key) => prohibitedIncidentFields.has(key))
    .sort();
  if (present.length > 0) {
    throw new FixtureError(`Raw incident fixture contains prohibited answer fields: ${present.join(", ")}.`);
  }
}

export function loadScenario(fixturesDir: string, name: string): Scenario {
  const scenarioPath = join(fixturesDir, "scenarios", `${name}.json`);
  if (!existsSync(scenarioPath)) {
    throw new FixtureError(`Unknown scenario: ${name}.`);
  }
  const payload = parseJsonObject(readFileSync(scenarioPath, "utf8"), `scenario ${name}`);
  return {
    name,
    incident: parseIncident(readObject(payload.incident, "incident")),
    expected: parseExpected(readObject(payload.expected, "expected")),
  };
}

export function listScenarios(fixturesDir: string): string[] {
  const scenariosDir = join(fixturesDir, "scenarios");
  if (!existsSync(scenariosDir)) {
    return [];
  }
  return readdirSync(scenariosDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

export function parseIncidentClass(value: unknown): IncidentClass {
  if (isOneOf(value, incidentClasses)) {
    return value;
  }
  throw new FixtureError("Incident class is missing or unsupported.");
}

export function parseNextAction(value: unknown): NextAction {
  if (isOneOf(value, nextActions)) {
    return value;
  }
  throw new FixtureError("Next action is missing or unsupported.");
}

function parseIncident(payload: Record<string, unknown>): Incident {
  validateRawIncidentPayload(payload);
  return {
    incidentId: readString(payload.incident_id, "incident_id"),
    title: readString(payload.title, "title"),
    severity: readString(payload.severity, "severity"),
    status: readString(payload.status, "status"),
    startedAt: readString(payload.started_at, "started_at"),
    service: readString(payload.service, "service"),
    symptoms: readStringArray(payload.symptoms, "symptoms"),
    alerts: readStringArray(payload.alerts, "alerts"),
    recentChanges: readRecentChanges(payload.recent_changes),
    logSignals: readStringArray(payload.log_signals, "log_signals"),
    runbookRefs: readStringArray(payload.runbook_refs, "runbook_refs"),
    priorIncidentRefs: readStringArray(payload.prior_incident_refs, "prior_incident_refs"),
    verificationSignals: readStringArray(payload.verification_signals, "verification_signals"),
  };
}

function parseExpected(payload: Record<string, unknown>): EvalExpectation {
  return {
    incidentClass: parseIncidentClass(payload.incident_class),
    allowedNextActions: readArray(payload.allowed_next_actions, "allowed_next_actions").map(parseNextAction),
    requiredEvidencePrefixes: readStringArray(payload.required_evidence_prefixes, "required_evidence_prefixes"),
    approvalRequired: Boolean(payload.approval_required ?? false),
  };
}

function readRecentChanges(value: unknown): RecentChange[] {
  return readArray(value ?? [], "recent_changes").map((item) => {
    const payload = readObject(item, "recent_changes item");
    return {
      time: readString(payload.time, "time"),
      service: readString(payload.service, "service"),
      change: readString(payload.change, "change"),
    };
  });
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    return readObject(JSON.parse(text), label);
  } catch (error) {
    if (error instanceof FixtureError) {
      throw error;
    }
    throw new FixtureError(`Could not parse ${label}.`);
  }
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FixtureError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new FixtureError(`${label} must be an array.`);
  }
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  const array = readArray(value ?? [], label);
  if (!array.every((item) => typeof item === "string")) {
    throw new FixtureError(`${label} must be an array of strings.`);
  }
  return array;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new FixtureError(`${label} must be a string.`);
  }
  return value;
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}
