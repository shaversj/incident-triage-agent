# Dependency Outage Runbook

Use when service symptoms correlate with an unhealthy upstream dependency.

Safe guidance:

- Gather dependency-specific logs and verification signals.
- Escalate to the dependency owner with impact, evidence, and urgency.
- Avoid rolling back the caller unless caller deploy evidence is stronger than dependency evidence.
- Verify recovery by checking downstream timeout rate and caller latency.
