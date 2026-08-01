CREATE TABLE IF NOT EXISTS incident_runs (
  run_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  scenario_name TEXT NOT NULL,
  service TEXT NOT NULL,
  run_status TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  safety_status TEXT,
  mitigation_status TEXT,
  evidence_ids JSONB NOT NULL,
  scorecard JSONB,
  retention_class TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS incident_runs_expires_at_idx
  ON incident_runs (expires_at);

CREATE TABLE IF NOT EXISTS evidence_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES incident_runs (run_id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL,
  evidence JSONB NOT NULL,
  missing_context JSONB NOT NULL,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_snapshots_expires_at_idx
  ON evidence_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS replay_keys (
  replay_key TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  signature TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS replay_keys_expires_at_idx
  ON replay_keys (expires_at);
