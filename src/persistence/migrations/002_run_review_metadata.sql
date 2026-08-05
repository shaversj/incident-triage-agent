ALTER TABLE incident_runs
  ADD COLUMN IF NOT EXISTS incident_title TEXT,
  ADD COLUMN IF NOT EXISTS severity TEXT,
  ADD COLUMN IF NOT EXISTS incident_status TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incident_runs_created_at_idx
  ON incident_runs (created_at DESC);
