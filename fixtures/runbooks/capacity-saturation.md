# Capacity Saturation Runbook

Use when resource saturation and queue depth rise without a correlated deploy.

Safe guidance:

- Confirm sustained load and resource pressure.
- Stage scaling or throttling steps for approval.
- Avoid rollback unless a deploy is implicated.
- Verify recovery by checking CPU, queue depth, and latency.
