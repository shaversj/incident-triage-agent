from __future__ import annotations

import json
from pathlib import Path

from loguru import logger

from .domain import Evidence, EvidencePackage, FixtureError, Incident, Scenario, SourceTier


log = logger.bind(component="tools")


class MockOperationalTools:
    def __init__(self, fixtures_dir: Path) -> None:
        self.fixtures_dir = fixtures_dir

    def build_evidence_package(self, scenario: Scenario) -> EvidencePackage:
        incident = scenario.incident
        log.debug("Building evidence package for scenario '{}'.", scenario.name)
        evidence: list[Evidence] = []
        missing: list[str] = []

        for source_name, records in (
            ("alerts", self.alert_evidence(incident)),
            ("symptoms", self.symptom_evidence(incident)),
            ("deploys", self.deploy_evidence(incident)),
            ("logs", self.log_evidence(incident)),
        ):
            log.debug("Collected {} {} evidence record(s).", len(records), source_name)
            evidence.extend(records)

        service = self.service_evidence(incident)
        if service:
            evidence.append(service)
            log.debug("Collected service ownership evidence for {}.", incident.service)
        else:
            missing.append(f"service:{incident.service}")
            log.warning("Missing service ownership evidence for {}.", incident.service)

        runbooks = self.runbook_evidence(incident)
        if runbooks:
            evidence.extend(runbooks)
            log.debug("Collected {} runbook evidence record(s).", len(runbooks))
        else:
            missing.append("runbook")
            log.warning("Missing runbook evidence.")

        prior = self.prior_incident_evidence(incident)
        if prior:
            evidence.extend(prior)
            log.debug("Collected {} prior incident evidence record(s).", len(prior))
        elif incident.prior_incident_refs:
            missing.append("prior_incident")
            log.warning("Prior incident references were present but no matching evidence was found.")

        verification = self.verification_evidence(incident)
        evidence.extend(verification)
        log.debug("Collected {} verification evidence record(s).", len(verification))
        if not incident.verification_signals:
            missing.append("verification")
            log.warning("Missing verification evidence.")

        package = EvidencePackage(
            scenario_name=scenario.name,
            incident=incident,
            evidence=tuple(evidence),
            missing_context=tuple(missing),
        )
        log.info(
            "Evidence package ready with {} evidence item(s) and {} missing context marker(s).",
            len(package.evidence),
            len(package.missing_context),
        )
        return package

    def alert_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(
                f"alert:{index}",
                "alert",
                SourceTier.CURRENT_SIGNAL,
                alert,
                f"Alert fired for {incident.service}: {alert}",
            )
            for index, alert in enumerate(incident.alerts)
        ]

    def symptom_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"symptom:{index}", "symptom", SourceTier.CURRENT_SIGNAL, symptom, symptom)
            for index, symptom in enumerate(incident.symptoms)
        ]

    def deploy_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(
                f"deploy:{index}",
                "deploy",
                SourceTier.OPERATIONAL_CONTEXT,
                f"{change.service} change at {change.time}",
                change.change,
            )
            for index, change in enumerate(incident.recent_changes)
        ]

    def log_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"log:{index}", "log", SourceTier.OPERATIONAL_CONTEXT, signal, signal)
            for index, signal in enumerate(incident.log_signals)
        ]

    def service_evidence(self, incident: Incident) -> Evidence | None:
        services_path = self.fixtures_dir / "services" / "services.json"
        if not services_path.exists():
            return None
        services = json.loads(services_path.read_text())
        service = services.get(incident.service)
        if not service:
            return None
        owner = service["owner"]
        escalation = service["escalation"]
        return Evidence(
            f"service:{incident.service}",
            "service",
            SourceTier.OPERATIONAL_CONTEXT,
            f"{incident.service} owned by {owner}",
            f"Escalation: {escalation}",
        )

    def runbook_evidence(self, incident: Incident) -> list[Evidence]:
        evidence: list[Evidence] = []
        for ref in incident.runbook_refs:
            path = self.fixtures_dir / "runbooks" / f"{ref}.md"
            if path.exists():
                text = path.read_text().strip()
                first_line = text.splitlines()[0].lstrip("# ").strip() if text else ref
                evidence.append(Evidence(f"runbook:{ref}", "runbook", SourceTier.GUIDANCE, first_line, text))
        return evidence

    def prior_incident_evidence(self, incident: Incident) -> list[Evidence]:
        prior_path = self.fixtures_dir / "prior_incidents" / "prior-incidents.json"
        if not prior_path.exists():
            return []
        prior_incidents = json.loads(prior_path.read_text())
        by_id = {item["incident_id"]: item for item in prior_incidents}
        evidence: list[Evidence] = []
        for ref in incident.prior_incident_refs:
            item = by_id.get(ref)
            if item:
                evidence.append(
                    Evidence(
                        f"prior:{ref}",
                        "prior_incident",
                        SourceTier.HISTORICAL_CONTEXT,
                        item["summary"],
                        item["resolution"],
                    )
                )
        return evidence

    def verification_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"verification:{index}", "verification", SourceTier.CURRENT_SIGNAL, signal, signal)
            for index, signal in enumerate(incident.verification_signals)
        ]


def load_tools(fixtures_dir: Path) -> MockOperationalTools:
    if not fixtures_dir.exists():
        raise FixtureError(f"Fixture directory does not exist: {fixtures_dir}.")
    return MockOperationalTools(fixtures_dir)
