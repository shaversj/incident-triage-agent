import { expect } from "vitest";
import type { IncidentClass, NextAction, SourceTier, WorkflowState } from "../../src/domain";
import type { TriageRun } from "../../src/workflow";
import type { SafetyStatus } from "../../src/policy";

export function assertValidRunOutcome(
  run: TriageRun,
  options: {
    incidentClass?: IncidentClass | string;
    nextAction?: NextAction | string;
    evidencePrefixes?: string[];
    citedSources?: string[];
    citedTiers?: Array<SourceTier | string>;
    safetyStatus?: SafetyStatus | string;
    approvalRequired?: boolean;
    scorecardChecks?: string[];
  } = {},
): void {
  expect(run.validation, "expected run to include validation result").toBeDefined();
  expect(run.validation?.valid, `expected valid decision, got errors=${JSON.stringify(run.validation?.errors)}`).toBe(true);
  expect(run.validation?.decision, "expected valid run to include a decision").toBeDefined();
  expect(run.states, "expected decision_validated state").toContain("decision_validated" satisfies WorkflowState);
  expect(run.states, "expected scored state").toContain("scored" satisfies WorkflowState);

  const decision = run.validation?.decision;
  if (!decision) {
    throw new Error("expected decision");
  }
  if (options.incidentClass !== undefined) {
    expect(decision.incidentClass).toBe(value(options.incidentClass));
  }
  if (options.nextAction !== undefined) {
    expect(decision.nextAction).toBe(value(options.nextAction));
  }

  assertCitedPrefixes(decision.evidenceIds, options.evidencePrefixes ?? []);

  expect(run.evidencePackage, "expected run to include evidence package").toBeDefined();
  const provenance = run.evidencePackage?.provenanceSummary(decision.evidenceIds);
  expect(provenance).toBeDefined();
  if (!provenance) {
    throw new Error("expected provenance");
  }
  assertContainsAll(provenance.citedTiers.map(value), (options.citedTiers ?? []).map(value), "cited_tiers");
  assertContainsAll(provenance.citedSources, options.citedSources ?? [], "cited_sources");

  if (options.safetyStatus !== undefined || options.approvalRequired !== undefined) {
    expect(run.safety, "expected run to include safety result").toBeDefined();
    assertSafety(run.safety?.status, run.safety?.approvalRequired, options.safetyStatus, options.approvalRequired);
    if (run.safety?.approvalRequired) {
      expect(run.safety.stagedPayload, "expected approval-required outcome to include staged payload").toBeDefined();
      expect(run.safety.auditEvent, "expected approval-required outcome to include audit event").toBeDefined();
      expect(run.safety.auditEvent?.executed, "expected staged action to remain unexecuted").toBe(false);
    }
  }

  assertScorecardChecks(run.scorecard?.scores, options.scorecardChecks ?? []);
}

export function assertValidResponseOutcome(
  response: Record<string, any>,
  options: {
    incidentClass?: IncidentClass | string;
    nextAction?: NextAction | string;
    evidencePrefixes?: string[];
    citedSources?: string[];
    availableTiers?: Array<SourceTier | string>;
    citedTiers?: Array<SourceTier | string>;
    requireSafety?: boolean;
    safetyStatus?: SafetyStatus | string;
    approvalRequired?: boolean;
    scorecardChecks?: string[];
  } = {},
): void {
  expect(response.status, `expected ok response, got ${JSON.stringify(response)}`).toBe("ok");
  expect(response.validation, "expected response validation object").toEqual(expect.any(Object));
  expect(response.validation.valid, `expected valid response, got errors=${JSON.stringify(response.validation.errors)}`).toBe(true);
  expect(response.decision, "expected valid response to include decision").toEqual(expect.any(Object));

  if (options.incidentClass !== undefined) {
    expect(response.decision.incident_class).toBe(value(options.incidentClass));
  }
  if (options.nextAction !== undefined) {
    expect(response.decision.next_action).toBe(value(options.nextAction));
  }

  assertCitedPrefixes(response.decision.evidence_ids ?? [], options.evidencePrefixes ?? []);

  expect(response.provenance, "expected response provenance object").toEqual(expect.any(Object));
  assertContainsAll(response.provenance.available_tiers ?? [], (options.availableTiers ?? []).map(value), "available_tiers");
  assertContainsAll(response.provenance.cited_tiers ?? [], (options.citedTiers ?? []).map(value), "cited_tiers");
  assertContainsAll(response.provenance.cited_sources ?? [], options.citedSources ?? [], "cited_sources");

  if (options.requireSafety || options.safetyStatus !== undefined || options.approvalRequired !== undefined) {
    expect(response.safety, "expected response safety object").toEqual(expect.any(Object));
    assertSafety(response.safety.status, response.safety.approval_required, options.safetyStatus, options.approvalRequired);
    if (response.safety.audit_event !== undefined) {
      expect(response.safety.audit_event.executed, "expected safety result not to execute actions").not.toBe(true);
    }
    if (response.safety.approval_required) {
      expect(response.safety.audit_event, "expected approval-required response to include audit event").toEqual(expect.any(Object));
    }
  }

  assertScorecardChecks(response.scorecard?.scores, options.scorecardChecks ?? []);
}

export function assertRecoverableRun(run: TriageRun, errorContains?: string): void {
  expect(run.states, "expected recoverable_failure state").toContain("recoverable_failure" satisfies WorkflowState);
  expect(run.states, "expected scored state").toContain("scored" satisfies WorkflowState);
  expect(run.validation, "expected validation errors on recoverable run").toBeDefined();
  expect(run.validation?.valid, "expected recoverable run validation to be invalid").toBe(false);
  expect(run.validation?.decision, "expected recoverable run to omit trusted decision").toBeUndefined();
  if (errorContains !== undefined) {
    expect(run.validation?.errors.some((error) => error.includes(errorContains))).toBe(true);
  }
  expect(run.safety, "expected recoverable run to skip safety action").toBeUndefined();
  expect(run.scorecard, "expected recoverable run to include scorecard").toBeDefined();
}

export function assertRecoverableResponse(response: Record<string, any>, errorContains?: string): void {
  expect(response.status, `expected ok response, got ${JSON.stringify(response)}`).toBe("ok");
  expect(response.states, "expected recoverable_failure state").toContain("recoverable_failure");
  expect(response.validation, "expected response validation object").toEqual(expect.any(Object));
  expect(response.validation.valid, "expected response validation to be invalid").toBe(false);
  expect(response, "expected recoverable response to omit trusted decision").not.toHaveProperty("decision");
  expect(response, "expected recoverable response to skip safety action").not.toHaveProperty("safety");
  if (errorContains !== undefined) {
    expect((response.validation.errors ?? []).some((error: string) => error.includes(errorContains))).toBe(true);
  }
  expect(response, "expected recoverable response to include scorecard").toHaveProperty("scorecard");
}

export function assertIgnoredResponse(status: number, response: Record<string, unknown>, reason: string): void {
  expect(status).toBe(202);
  expect(response.status).toBe("ignored");
  expect(response.reason).toBe(reason);
  expect(response).not.toHaveProperty("decision");
  expect(response).not.toHaveProperty("safety");
}

function assertCitedPrefixes(evidenceIds: string[], prefixes: string[]): void {
  for (const prefix of prefixes) {
    expect(
      evidenceIds.some((evidenceId) => evidenceId.startsWith(prefix)),
      `expected cited evidence prefix ${prefix}, got ${evidenceIds.join(", ")}`,
    ).toBe(true);
  }
}

function assertContainsAll(actual: string[], expected: string[], label: string): void {
  for (const item of expected) {
    expect(actual, `expected ${label} to include ${item}, got ${actual.join(", ")}`).toContain(item);
  }
}

function assertSafety(
  actualStatus: unknown,
  actualApprovalRequired: unknown,
  expectedStatus?: SafetyStatus | string,
  expectedApprovalRequired?: boolean,
): void {
  if (expectedStatus !== undefined) {
    expect(actualStatus).toBe(value(expectedStatus));
  }
  if (expectedApprovalRequired !== undefined) {
    expect(actualApprovalRequired).toBe(expectedApprovalRequired);
  }
}

function assertScorecardChecks(scores: Record<string, boolean> | undefined, checks: string[]): void {
  if (checks.length === 0) {
    return;
  }
  expect(scores, "expected scorecard scores").toBeDefined();
  for (const check of checks) {
    expect(scores, `expected scorecard check ${check}`).toHaveProperty(check);
    expect(scores?.[check], `expected scorecard check ${check} to pass`).toBe(true);
  }
}

function value(input: { value: string } | string): string {
  return typeof input === "string" ? input : input.value;
}
