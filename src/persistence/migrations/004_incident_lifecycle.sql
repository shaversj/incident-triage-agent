CREATE TABLE IF NOT EXISTS incident_verification_events (
  event_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'unresolved', 'inconclusive')),
  source TEXT NOT NULL CHECK (source IN ('operator', 'observability')),
  source_reference TEXT NOT NULL,
  evidence_ids JSONB NOT NULL,
  rationale TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS incident_verification_events_incident_created_at_idx
  ON incident_verification_events (incident_id, created_at);

CREATE INDEX IF NOT EXISTS incident_verification_events_expires_at_idx
  ON incident_verification_events (expires_at);

CREATE TABLE IF NOT EXISTS incident_recovery_budgets (
  incident_id TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit > 0),
  exhausted BOOLEAN NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (incident_id, failure_class)
);

CREATE INDEX IF NOT EXISTS incident_recovery_budgets_expires_at_idx
  ON incident_recovery_budgets (expires_at);

CREATE TABLE IF NOT EXISTS incident_recovery_events (
  event_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('attempt', 'exhausted', 'reset')),
  failure_class TEXT NOT NULL,
  run_id TEXT,
  attempt INTEGER,
  reason TEXT,
  actor TEXT,
  rationale TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS incident_recovery_events_incident_created_at_idx
  ON incident_recovery_events (incident_id, created_at);

CREATE INDEX IF NOT EXISTS incident_recovery_events_expires_at_idx
  ON incident_recovery_events (expires_at);

CREATE TABLE IF NOT EXISTS outcome_review_candidates (
  candidate_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  run_id TEXT,
  source_event_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('unresolved_mitigation', 'recovery_exhausted', 'corrected_finding', 'reasoned_rejection')
  ),
  rationale TEXT NOT NULL,
  evidence_ids JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'imported')),
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  imported_at TIMESTAMPTZ,
  UNIQUE (incident_id, category, source_event_id)
);

CREATE INDEX IF NOT EXISTS outcome_review_candidates_incident_created_at_idx
  ON outcome_review_candidates (incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS outcome_review_candidates_status_created_at_idx
  ON outcome_review_candidates (status, created_at DESC);

CREATE INDEX IF NOT EXISTS outcome_review_candidates_expires_at_idx
  ON outcome_review_candidates (expires_at);
