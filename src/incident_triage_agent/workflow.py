from __future__ import annotations

from loguru import logger

from .domain import Scenario, TriageRun, WorkflowState
from .llm import LLMClient
from .policy import evaluate_safety
from .scoring import score_run
from .tools import MockOperationalTools


log = logger.bind(component="workflow")


class TriageWorkflow:
    def __init__(self, tools: MockOperationalTools, llm_client: LLMClient) -> None:
        self.tools = tools
        self.llm_client = llm_client

    def run(self, scenario: Scenario) -> TriageRun:
        log.info("Starting workflow for scenario '{}'.", scenario.name)
        run = TriageRun(scenario=scenario)
        run.transition(WorkflowState.RECEIVED)
        log.debug("State transition: {}.", WorkflowState.RECEIVED.value)

        run.evidence_package = self.tools.build_evidence_package(scenario)
        run.transition(WorkflowState.CONTEXT_GATHERED)
        log.debug("State transition: {}.", WorkflowState.CONTEXT_GATHERED.value)

        run.transition(WorkflowState.LLM_DECISION_REQUESTED)
        log.debug("State transition: {}.", WorkflowState.LLM_DECISION_REQUESTED.value)
        run.validation = self.llm_client.decide(run.evidence_package)

        if not run.validation.valid or not run.validation.decision:
            run.transition(WorkflowState.RECOVERABLE_FAILURE)
            log.warning("State transition: {}.", WorkflowState.RECOVERABLE_FAILURE.value)
            run.transition(WorkflowState.SCORED)
            log.debug("State transition: {}.", WorkflowState.SCORED.value)
            run.scorecard = score_run(run)
            return run

        run.transition(WorkflowState.DECISION_VALIDATED)
        log.debug("State transition: {}.", WorkflowState.DECISION_VALIDATED.value)
        run.safety = evaluate_safety(run.validation.decision, run.evidence_package)

        if run.safety.status == "approval_required":
            run.transition(WorkflowState.APPROVAL_PENDING)
            log.debug("State transition: {}.", WorkflowState.APPROVAL_PENDING.value)
            run.transition(WorkflowState.SIMULATED_ACTION_RECORDED)
            log.debug("State transition: {}.", WorkflowState.SIMULATED_ACTION_RECORDED.value)
        elif run.safety.status == "needs_human_input":
            run.transition(WorkflowState.HUMAN_INPUT_NEEDED)
            log.debug("State transition: {}.", WorkflowState.HUMAN_INPUT_NEEDED.value)
        else:
            run.transition(WorkflowState.VERIFICATION_READY)
            log.debug("State transition: {}.", WorkflowState.VERIFICATION_READY.value)

        run.transition(WorkflowState.SCORED)
        log.debug("State transition: {}.", WorkflowState.SCORED.value)
        run.scorecard = score_run(run)
        log.info("Workflow complete for scenario '{}'.", scenario.name)
        return run
