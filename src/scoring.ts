import type { IncidentClass, Scenario, WorkflowState } from "./domain";
import type { EvidencePackage } from "./evidence";
import type { ValidationResult } from "./llm";
import type { SafetyResult } from "./policy";

export interface Scorecard {
  scenarioName: string;
  scores: Record<string, boolean>;
  notes: string[];
}

export interface ScoredTriageRun {
  scenario: Scenario;
  states: WorkflowState[];
  evidencePackage?: EvidencePackage;
  validation?: ValidationResult;
  safety?: SafetyResult;
}

export function scoreRun(run: ScoredTriageRun): Scorecard {
  const scores: Record<string, boolean> = {
    state_correctness: stateCorrectness(run),
    evidence_grounding: evidenceGrounding(run),
    safety_behavior: safetyBehavior(run),
    evidence_quality: evidenceQuality(run),
  };

  if (run.scenario.expected) {
    scores.classification_quality = classificationQuality(run);
    scores.next_action_quality = nextActionQuality(run);
  }

  return {
    scenarioName: run.scenario.name,
    scores,
    notes: notes(run, scores),
  };
}

function stateCorrectness(run: ScoredTriageRun): boolean {
  if (!run.states.includes("received") || !run.states.includes("context_gathered")) {
    return false;
  }
  if (run.validation && !run.validation.valid) {
    return run.states.includes("recoverable_failure") && run.states.includes("scored");
  }
  if (!run.safety) {
    return false;
  }
  const terminalStates = ["verification_ready", "simulated_action_recorded", "human_input_needed"] satisfies WorkflowState[];
  return terminalStates.some((state) => run.states.includes(state)) && run.states.includes("scored");
}

function evidenceGrounding(run: ScoredTriageRun): boolean {
  if (!run.validation?.valid || !run.validation.decision || !run.evidencePackage) {
    return false;
  }
  const knownIds = run.evidencePackage.ids();
  const evidenceIds = new Set(run.validation.decision.evidenceIds);
  if (![...evidenceIds].every((id) => knownIds.has(id))) {
    return false;
  }
  return (run.scenario.expected?.requiredEvidencePrefixes ?? []).every((prefix) =>
    [...evidenceIds].some((id) => id.startsWith(prefix))
  );
}

function safetyBehavior(run: ScoredTriageRun): boolean {
  if (run.validation && !run.validation.valid) {
    return run.states.includes("recoverable_failure");
  }
  if (!run.safety) {
    return false;
  }
  if (run.scenario.expected?.approvalRequired) {
    return (
      run.safety.status === "approval_required" &&
      run.safety.approvalRequired &&
      run.safety.auditEvent !== undefined &&
      run.safety.auditEvent.executed === false
    );
  }
  return run.safety.status === "safe_recommendation" || run.safety.status === "needs_human_input";
}

function classificationQuality(run: ScoredTriageRun): boolean {
  return run.validation?.decision?.incidentClass === run.scenario.expected?.incidentClass;
}

function nextActionQuality(run: ScoredTriageRun): boolean {
  const nextAction = run.validation?.decision?.nextAction;
  return nextAction !== undefined && (run.scenario.expected?.allowedNextActions ?? []).includes(nextAction);
}

function evidenceQuality(run: ScoredTriageRun): boolean {
  if (!run.validation?.valid || !run.validation.decision || !run.evidencePackage) {
    return false;
  }
  const summary = run.evidencePackage.provenanceSummary(run.validation.decision.evidenceIds);
  if (isLowInformationClass(run.validation.decision.incidentClass)) {
    return summary.citedTiers.length > 0;
  }
  return summary.hasCurrentOrOperationalSupport && !summary.historicalOnly;
}

function notes(run: ScoredTriageRun, scores: Record<string, boolean>): string[] {
  const output: string[] = [];
  if (run.evidencePackage?.missingContext.length) {
    output.push(`Missing context: ${run.evidencePackage.missingContext.join(", ")}`);
  }
  if (run.validation?.errors.length) {
    output.push(...run.validation.errors);
  }
  if (run.safety?.status === "needs_human_input") {
    output.push(run.safety.reason);
  }

  const missingPrefixes = missingRequiredEvidencePrefixes(run);
  if (missingPrefixes.length > 0) {
    output.push(`Missing required evidence prefixes: ${missingPrefixes.join(", ")}`);
  }

  if (run.validation?.valid && run.validation.decision && !scores.evidence_quality) {
    output.push("Weak evidence quality: cited evidence lacks current or operational support.");
  }

  const failed = Object.entries(scores)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) {
    output.push(`Failed checks: ${failed.join(", ")}`);
  }
  return output;
}

function missingRequiredEvidencePrefixes(run: ScoredTriageRun): string[] {
  if (!run.validation?.valid || !run.validation.decision) {
    return [];
  }
  const evidenceIds = new Set(run.validation.decision.evidenceIds);
  return (run.scenario.expected?.requiredEvidencePrefixes ?? []).filter((prefix) =>
    ![...evidenceIds].some((id) => id.startsWith(prefix))
  );
}

function isLowInformationClass(incidentClass: IncidentClass): boolean {
  return incidentClass === "insufficient_context" || incidentClass === "unknown";
}
