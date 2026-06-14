from __future__ import annotations

import json
from pathlib import Path

from .domain import Evidence, EvidencePackage, FixtureError, Incident, Scenario


class MockOperationalTools:
    def __init__(self, fixtures_dir: Path) -> None:
        self.fixtures_dir = fixtures_dir

    def build_evidence_package(self, scenario: Scenario) -> EvidencePackage:
        incident = scenario.incident
        evidence: list[Evidence] = []
        missing: list[str] = []

        evidence.extend(self.alert_evidence(incident))
        evidence.extend(self.symptom_evidence(incident))
        evidence.extend(self.deploy_evidence(incident))
        evidence.extend(self.log_evidence(incident))

        service = self.service_evidence(incident)
        if service:
            evidence.append(service)
        else:
            missing.append(f"service:{incident.service}")

        runbooks = self.runbook_evidence(incident)
        if runbooks:
            evidence.extend(runbooks)
        else:
            missing.append("runbook")

        prior = self.prior_incident_evidence(incident)
        if prior:
            evidence.extend(prior)
        elif incident.prior_incident_refs:
            missing.append("prior_incident")

        evidence.extend(self.verification_evidence(incident))
        if not incident.verification_signals:
            missing.append("verification")

        return EvidencePackage(
            scenario_name=scenario.name,
            incident=incident,
            evidence=tuple(evidence),
            missing_context=tuple(missing),
        )

    def alert_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"alert:{index}", "alert", alert, f"Alert fired for {incident.service}: {alert}")
            for index, alert in enumerate(incident.alerts)
        ]

    def symptom_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"symptom:{index}", "symptom", symptom, symptom)
            for index, symptom in enumerate(incident.symptoms)
        ]

    def deploy_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(
                f"deploy:{index}",
                "deploy",
                f"{change.service} change at {change.time}",
                change.change,
            )
            for index, change in enumerate(incident.recent_changes)
        ]

    def log_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"log:{index}", "log", signal, signal)
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
                evidence.append(Evidence(f"runbook:{ref}", "runbook", first_line, text))
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
                        item["summary"],
                        item["resolution"],
                    )
                )
        return evidence

    def verification_evidence(self, incident: Incident) -> list[Evidence]:
        return [
            Evidence(f"verification:{index}", "verification", signal, signal)
            for index, signal in enumerate(incident.verification_signals)
        ]


def load_tools(fixtures_dir: Path) -> MockOperationalTools:
    if not fixtures_dir.exists():
        raise FixtureError(f"Fixture directory does not exist: {fixtures_dir}.")
    return MockOperationalTools(fixtures_dir)
