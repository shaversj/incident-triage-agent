import type { Scenario, WorkflowState } from "./domain";
import type { EvidencePackage, MockOperationalTools } from "./evidence";
import type { LLMDecisionClient, ValidationResult } from "./llm";
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
  ) {}

  async run(scenario: Scenario): Promise<TriageRun> {
    const run: TriageRun = { scenario, states: [] };

    transition(run, "received");
    run.evidencePackage = this.tools.buildEvidencePackage(scenario);
    transition(run, "context_gathered");

    transition(run, "llm_decision_requested");
    run.validation = await this.llmClient.decide(run.evidencePackage);

    if (!run.validation.valid || !run.validation.decision) {
      transition(run, "recoverable_failure");
      transition(run, "scored");
      run.scorecard = scoreRun(run);
      return run;
    }

    transition(run, "decision_validated");
    run.safety = evaluateSafety(run.validation.decision, run.evidencePackage);

    if (run.safety.status === "approval_required") {
      transition(run, "approval_pending");
      transition(run, "simulated_action_recorded");
    } else if (run.safety.status === "needs_human_input") {
      transition(run, "human_input_needed");
    } else {
      transition(run, "verification_ready");
    }

    transition(run, "scored");
    run.scorecard = scoreRun(run);
    return run;
  }
}

function transition(run: TriageRun, state: WorkflowState): void {
  run.states.push(state);
}
