import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FixtureError, type Incident } from "../domain";
import type { Evidence } from "../evidence";

export interface ServiceContextSource {
  serviceEvidence(incident: Incident): Evidence | undefined;
}

export interface RunbookContextSource {
  runbookEvidence(incident: Incident): Evidence[];
}

export interface ContextSources {
  services: ServiceContextSource;
  runbooks: RunbookContextSource;
}

export class FileServiceContextSource implements ServiceContextSource {
  constructor(private readonly fixturesDir: string) {}

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
}

export class FileRunbookContextSource implements RunbookContextSource {
  constructor(private readonly fixturesDir: string) {}

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
}

export function fileContextSources(fixturesDir: string): ContextSources {
  return {
    services: new FileServiceContextSource(fixturesDir),
    runbooks: new FileRunbookContextSource(fixturesDir),
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FixtureError(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new FixtureError(`${label} must be a non-empty string.`);
}
