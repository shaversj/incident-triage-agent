ALTER TABLE incident_runs
  ADD COLUMN IF NOT EXISTS parent_run_id TEXT REFERENCES incident_runs (run_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gate_decision_id TEXT;

CREATE INDEX IF NOT EXISTS incident_runs_incident_created_at_idx
  ON incident_runs (incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_gate_decisions (
  decision_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  baseline_key TEXT NOT NULL,
  prior_run_id TEXT,
  child_run_id TEXT,
  outcome TEXT NOT NULL,
  basis TEXT NOT NULL,
  delta JSONB NOT NULL,
  rationale TEXT NOT NULL,
  cited_delta_refs JSONB NOT NULL,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (incident_id, baseline_key, candidate_digest)
);

CREATE INDEX IF NOT EXISTS evidence_gate_decisions_incident_created_at_idx
  ON evidence_gate_decisions (incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS evidence_gate_decisions_expires_at_idx
  ON evidence_gate_decisions (expires_at);
