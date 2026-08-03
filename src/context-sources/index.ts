import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

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
    const path = resolve(this.fixturesDir, "services", "services.json");
    const services = readJsonObjectIfPresent(path);
    if (!services) {
      return undefined;
    }
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
      if (!isRunbookRef(ref)) {
        continue;
      }
      const runbooksDir = resolve(this.fixturesDir, "runbooks");
      const path = resolve(runbooksDir, `${ref}.md`);
      if (!path.startsWith(`${runbooksDir}${sep}`)) {
        continue;
      }
      const text = readFileIfPresent(path)?.trim();
      if (!text) {
        continue;
      }
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

function readJsonObjectIfPresent(path: string): Record<string, unknown> | undefined {
  try {
    return readJsonObject(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRunbookRef(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new FixtureError(`${label} must be a non-empty string.`);
}
