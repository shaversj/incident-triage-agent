import { FixtureError, type Incident, validateRawIncidentPayload } from "./domain";

export class GrafanaPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrafanaPayloadError";
  }
}

export interface GrafanaNormalizationResult {
  scenarioName: string;
  incident: Incident;
  lokiQueryLabels: Record<string, string>;
  startNs: number;
  endNs: number;
  ignored: boolean;
  ignoredReason: string;
}

const serviceLabels = ["service", "app", "job"] as const;

export function normalizeGrafanaPayload(payload: unknown): GrafanaNormalizationResult {
  const body = readObject(payload, "Grafana payload");
  rejectAnswerLikeFields(body);

  const alerts = body.alerts;
  if (!Array.isArray(alerts)) {
    throw new GrafanaPayloadError("Grafana payload must include an alerts array.");
  }
  if (alerts.length === 0) {
    throw new GrafanaPayloadError("Grafana payload did not include any alerts.");
  }

  const activeAlerts = alerts.filter((alert): alert is Record<string, unknown> =>
    isObject(alert) && alert.status === "firing"
  );
  const relevantAlerts = activeAlerts.length > 0 ? activeAlerts : alerts.filter(isObject);
  const [serviceKey, service] = extractService(body, alerts);
  const scenarioName = scenarioNameFor(body, relevantAlerts, service);
  const startedAt = earliestStart(relevantAlerts);
  const [startNs, endNs] = lokiWindowNs(startedAt);

  if (activeAlerts.length === 0) {
    return {
      scenarioName,
      incident: {
        incidentId: `GRAFANA-${firstFingerprint(alerts)}`,
        title: titleFor(body, service),
        severity: severityFor(body, relevantAlerts),
        status: "resolved",
        startedAt,
        service,
        symptoms: [],
        alerts: [],
        recentChanges: [],
        logSignals: [],
        runbookRefs: [],
        priorIncidentRefs: [],
        verificationSignals: [],
      },
      lokiQueryLabels: { [serviceKey]: service },
      startNs,
      endNs,
      ignored: true,
      ignoredReason: "resolved_alert",
    };
  }

  const incidentPayload = {
    incident_id: `GRAFANA-${firstFingerprint(activeAlerts)}`,
    title: titleFor(body, service),
    severity: severityFor(body, activeAlerts),
    status: "active",
    started_at: startedAt,
    service,
    symptoms: symptomsFor(activeAlerts),
    alerts: alertNames(activeAlerts),
    recent_changes: [],
    log_signals: [],
    runbook_refs: runbookRefs(activeAlerts),
    prior_incident_refs: [],
    verification_signals: verificationSignals(activeAlerts),
  };
  validateRawIncidentPayload(incidentPayload);

  return {
    scenarioName,
    incident: {
      incidentId: incidentPayload.incident_id,
      title: incidentPayload.title,
      severity: incidentPayload.severity,
      status: incidentPayload.status,
      startedAt: incidentPayload.started_at,
      service: incidentPayload.service,
      symptoms: incidentPayload.symptoms,
      alerts: incidentPayload.alerts,
      recentChanges: [],
      logSignals: [],
      runbookRefs: incidentPayload.runbook_refs,
      priorIncidentRefs: [],
      verificationSignals: incidentPayload.verification_signals,
    },
    lokiQueryLabels: { [serviceKey]: service },
    startNs,
    endNs,
    ignored: false,
    ignoredReason: "",
  };
}

function rejectAnswerLikeFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rejectAnswerLikeFields(item);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  try {
    validateRawIncidentPayload(value);
  } catch (error) {
    if (error instanceof FixtureError) {
      throw new FixtureError(`Grafana payload contains prohibited answer fields: ${error.message}`);
    }
    throw error;
  }
  for (const item of Object.values(value)) {
    rejectAnswerLikeFields(item);
  }
}

function extractService(payload: Record<string, unknown>, alerts: unknown[]): [string, string] {
  for (const key of ["commonLabels", "groupLabels"]) {
    const labels = payload[key];
    if (!isObject(labels)) {
      continue;
    }
    for (const serviceKey of serviceLabels) {
      if (labels[serviceKey]) {
        return [serviceKey, String(labels[serviceKey])];
      }
    }
  }

  for (const alert of alerts) {
    if (!isObject(alert) || !isObject(alert.labels)) {
      continue;
    }
    for (const serviceKey of serviceLabels) {
      if (alert.labels[serviceKey]) {
        return [serviceKey, String(alert.labels[serviceKey])];
      }
    }
  }
  throw new GrafanaPayloadError("Grafana payload did not include a service, app, or job label.");
}

function scenarioNameFor(payload: Record<string, unknown>, alerts: Record<string, unknown>[], service: string): string {
  for (const key of ["commonLabels", "groupLabels"]) {
    const labels = payload[key];
    if (isObject(labels) && labels.scenario) {
      return `grafana-${slug(String(labels.scenario))}`;
    }
  }
  for (const alert of alerts) {
    if (isObject(alert.labels) && alert.labels.scenario) {
      return `grafana-${slug(String(alert.labels.scenario))}`;
    }
  }
  return `grafana-${slug(service)}`;
}

function titleFor(payload: Record<string, unknown>, service: string): string {
  const commonAnnotations = payload.commonAnnotations;
  if (isObject(commonAnnotations) && commonAnnotations.summary) {
    return String(commonAnnotations.summary);
  }
  return String(payload.title ?? `Grafana alert for ${service}`).replace(/^\[[^\]]+\]\s*/, "").trim() ||
    `Grafana alert for ${service}`;
}

function severityFor(payload: Record<string, unknown>, alerts: Record<string, unknown>[]): string {
  const sources = [payload.commonLabels, payload.groupLabels, ...alerts.map((alert) => alert.labels)];
  for (const labels of sources) {
    if (isObject(labels) && labels.severity) {
      return String(labels.severity).toUpperCase();
    }
  }
  return "UNKNOWN";
}

function alertNames(alerts: Record<string, unknown>[]): string[] {
  return alerts.map((alert, index) =>
    isObject(alert.labels) && alert.labels.alertname ? String(alert.labels.alertname) : `grafana-alert-${index}`
  );
}

function symptomsFor(alerts: Record<string, unknown>[]): string[] {
  const symptoms: string[] = [];
  for (const alert of alerts) {
    if (isObject(alert.annotations)) {
      for (const key of ["summary", "description"]) {
        if (alert.annotations[key]) {
          symptoms.push(String(alert.annotations[key]));
        }
      }
    }
    if (isObject(alert.values)) {
      const rendered = Object.entries(alert.values)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ");
      if (rendered) {
        symptoms.push(`grafana_values: ${rendered}`);
      }
    }
  }
  return unique(symptoms);
}

function runbookRefs(alerts: Record<string, unknown>[]): string[] {
  return unique(alerts.flatMap((alert) => {
    const annotations = alert.annotations;
    if (!isObject(annotations)) {
      return [];
    }
    return ["runbook_ref", "runbook"].flatMap((key) =>
      annotations[key] ? [String(annotations[key])] : []
    );
  }));
}

function verificationSignals(alerts: Record<string, unknown>[]): string[] {
  const signals: string[] = [];
  for (const alert of alerts) {
    if (alert.fingerprint) {
      signals.push(`grafana:fingerprint:${String(alert.fingerprint)}`);
    }
    for (const key of ["generatorURL", "dashboardURL", "panelURL", "silenceURL"]) {
      if (alert[key]) {
        signals.push(`grafana:${key}:${String(alert[key])}`);
      }
    }
  }
  return unique(signals);
}

function earliestStart(alerts: Record<string, unknown>[]): string {
  const values = alerts
    .map((alert) => typeof alert.startsAt === "string" ? parseTime(alert.startsAt) : undefined)
    .filter((value): value is Date => value !== undefined);
  if (values.length === 0) {
    throw new GrafanaPayloadError("Grafana payload did not include startsAt on any alert.");
  }
  return new Date(Math.min(...values.map((value) => value.getTime()))).toISOString().replace(".000Z", "Z");
}

function lokiWindowNs(startsAt: string): [number, number] {
  const timestamp = parseTime(startsAt).getTime();
  const paddingMs = 10 * 60 * 1000;
  return [toNs(timestamp - paddingMs), toNs(timestamp + paddingMs)];
}

function firstFingerprint(alerts: unknown[]): string {
  for (const alert of alerts) {
    if (isObject(alert) && alert.fingerprint) {
      return slug(String(alert.fingerprint));
    }
  }
  return "unknown";
}

function parseTime(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GrafanaPayloadError(`Invalid Grafana startsAt value: ${value}.`);
  }
  return date;
}

function toNs(timestampMs: number): number {
  return timestampMs * 1_000_000;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new GrafanaPayloadError(`${label} must be a JSON object.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
