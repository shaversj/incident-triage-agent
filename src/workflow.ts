import type { Scenario, WorkflowState } from "./domain";
import type { EvidencePackage, InvestigationStep, MockOperationalTools } from "./evidence";
import type { ExplanationValidation, LLMDecisionClient, TriageExplanation, ValidationResult } from "./llm";
import { noopLogger, type TriageLogger } from "./logger";
import { evaluateSafety, type SafetyResult } from "./policy";
import { scoreRun, type Scorecard } from "./scoring";

export type RunStatus = "running" | "completed" | "recoverable_failure";

export interface InvestigationTrace {
  summary: string;
  steps: InvestigationStep[];
}

export interface TriageRun {
  runId: string;
  runStatus: RunStatus;
  scenario: Scenario;
  states: WorkflowState[];
  investigation?: InvestigationTrace;
  evidencePackage?: EvidencePackage;
  validation?: ValidationResult;
  explanation?: TriageExplanation;
  explanationValidation?: ExplanationValidation;
  safety?: SafetyResult;
  scorecard?: Scorecard;
}

export class TriageWorkflow {
  constructor(
    private readonly tools: MockOperationalTools,
    private readonly llmClient: LLMDecisionClient,
    private readonly logger: TriageLogger = noopLogger,
  ) {}

  async run(scenario: Scenario): Promise<TriageRun> {
    this.logger.info({ component: "workflow", scenario: scenario.name }, "Starting workflow");
    const run: TriageRun = { runId: `triage-run:${scenario.name}`, runStatus: "running", scenario, states: [] };

    this.transition(run, "received");
    run.evidencePackage = this.tools.buildEvidencePackage(scenario);
    run.investigation = buildInvestigationTrace(run.evidencePackage);
    this.logger.info({
      component: "tools",
      scenario: scenario.name,
      evidenceCount: run.evidencePackage.evidence.length,
      missingContextCount: run.evidencePackage.missingContext.length,
    }, "Evidence package ready");
    this.transition(run, "context_gathered");

    this.transition(run, "llm_decision_requested");
    run.validation = await this.llmClient.decide(run.evidencePackage);
    if (run.validation.explanation) {
      run.explanation = run.validation.explanation;
    }
    if (run.validation.explanationValidation) {
      run.explanationValidation = run.validation.explanationValidation;
    }

    if (!run.validation.valid || !run.validation.decision) {
      this.logger.warn({ component: "llm", errors: run.validation.errors }, "LLM decision validation failed");
      this.transition(run, "recoverable_failure");
      this.transition(run, "scored");
      run.scorecard = scoreRun(run);
      run.runStatus = "recoverable_failure";
      this.logger.info({ component: "scoring", passed: passedCount(run.scorecard), total: totalCount(run.scorecard) }, "Scorecard complete");
      return run;
    }

    this.logger.info({
      component: "llm",
      incidentClass: run.validation.decision.incidentClass,
      nextAction: run.validation.decision.nextAction,
      confidence: run.validation.decision.confidence,
    }, "LLM decision validated");
    this.transition(run, "decision_validated");
    run.safety = evaluateSafety(run.validation.decision, run.evidencePackage);
    this.logger.info({
      component: "policy",
      status: run.safety.status,
      approvalRequired: run.safety.approvalRequired,
    }, "Safety evaluated");

    if (run.safety.status === "approval_required") {
      this.transition(run, "approval_pending");
      this.transition(run, "simulated_action_recorded");
    } else if (run.safety.status === "needs_human_input") {
      this.transition(run, "human_input_needed");
    } else {
      this.transition(run, "verification_ready");
    }

    this.transition(run, "scored");
    run.scorecard = scoreRun(run);
    run.runStatus = "completed";
    this.logger.info({ component: "scoring", passed: passedCount(run.scorecard), total: totalCount(run.scorecard) }, "Scorecard complete");
    this.logger.info({ component: "workflow", scenario: scenario.name }, "Workflow complete");
    return run;
  }

  private transition(run: TriageRun, state: WorkflowState): void {
    run.states.push(state);
    this.logger.debug({ component: "workflow", state }, "State transition");
  }
}

function passedCount(scorecard: Scorecard): number {
  return Object.values(scorecard.scores).filter(Boolean).length;
}

function totalCount(scorecard: Scorecard): number {
  return Object.values(scorecard.scores).length;
}

function buildInvestigationTrace(evidencePackage: EvidencePackage): InvestigationTrace {
  const found = evidencePackage.investigationSteps.filter((step) => step.status === "found").length;
  const notFound = evidencePackage.investigationSteps.filter((step) => step.status === "not_found").length;
  const skipped = evidencePackage.investigationSteps.filter((step) => step.status === "skipped").length;
  const errored = evidencePackage.investigationSteps.filter((step) => step.status === "error").length;
  const statusParts = [
    `${found} found`,
    notFound > 0 ? `${notFound} not found` : undefined,
    skipped > 0 ? `${skipped} skipped` : undefined,
    errored > 0 ? `${errored} error` : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    summary: `Collected ${evidencePackage.evidence.length} evidence item(s) across ${evidencePackage.investigationSteps.length} investigation step(s): ${statusParts.join(", ")}.`,
    steps: evidencePackage.investigationSteps,
  };
}
