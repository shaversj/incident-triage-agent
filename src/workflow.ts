import type { Scenario, WorkflowState } from "./domain";
import type { EvidencePackage, MockOperationalTools } from "./evidence";
import type { LLMDecisionClient, ValidationResult } from "./llm";
import { noopLogger, type TriageLogger } from "./logger";
import { evaluateSafety, type SafetyResult } from "./policy";
import { scoreRun, type Scorecard } from "./scoring";

export interface TriageRun {
  scenario: Scenario;
  states: WorkflowState[];
  evidencePackage?: EvidencePackage;
  validation?: ValidationResult;
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
    const run: TriageRun = { scenario, states: [] };

    this.transition(run, "received");
    run.evidencePackage = this.tools.buildEvidencePackage(scenario);
    this.logger.info({
      component: "tools",
      scenario: scenario.name,
      evidenceCount: run.evidencePackage.evidence.length,
      missingContextCount: run.evidencePackage.missingContext.length,
    }, "Evidence package ready");
    this.transition(run, "context_gathered");

    this.transition(run, "llm_decision_requested");
    run.validation = await this.llmClient.decide(run.evidencePackage);

    if (!run.validation.valid || !run.validation.decision) {
      this.logger.warn({ component: "llm", errors: run.validation.errors }, "LLM decision validation failed");
      this.transition(run, "recoverable_failure");
      this.transition(run, "scored");
      run.scorecard = scoreRun(run);
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
