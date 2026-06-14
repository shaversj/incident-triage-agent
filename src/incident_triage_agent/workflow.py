from __future__ import annotations

from .domain import Scenario, TriageRun, WorkflowState
from .llm import LLMClient
from .policy import evaluate_safety
from .scoring import score_run
from .tools import MockOperationalTools


class TriageWorkflow:
    def __init__(self, tools: MockOperationalTools, llm_client: LLMClient) -> None:
        self.tools = tools
        self.llm_client = llm_client

    def run(self, scenario: Scenario) -> TriageRun:
        run = TriageRun(scenario=scenario)
        run.transition(WorkflowState.RECEIVED)

        run.evidence_package = self.tools.build_evidence_package(scenario)
        run.transition(WorkflowState.CONTEXT_GATHERED)

        run.transition(WorkflowState.LLM_DECISION_REQUESTED)
        run.validation = self.llm_client.decide(run.evidence_package)

        if not run.validation.valid or not run.validation.decision:
            run.transition(WorkflowState.RECOVERABLE_FAILURE)
            run.transition(WorkflowState.SCORED)
            run.scorecard = score_run(run)
            return run

        run.transition(WorkflowState.DECISION_VALIDATED)
        run.safety = evaluate_safety(run.validation.decision, run.evidence_package)

        if run.safety.status == "approval_required":
            run.transition(WorkflowState.APPROVAL_PENDING)
            run.transition(WorkflowState.SIMULATED_ACTION_RECORDED)
        elif run.safety.status == "needs_human_input":
            run.transition(WorkflowState.HUMAN_INPUT_NEEDED)
        else:
            run.transition(WorkflowState.VERIFICATION_READY)

        run.transition(WorkflowState.SCORED)
        run.scorecard = score_run(run)
        return run
