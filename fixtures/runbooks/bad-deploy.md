# Bad Deploy Runbook

Use when symptoms begin shortly after a service deploy and dependency health is normal.

Safe guidance:

- Compare metrics before and after the deploy.
- Stage rollback or feature-flag disablement for approval.
- Do not execute production rollback without human approval.
- Verify recovery by checking latency, error budget burn, and customer-facing errors.
