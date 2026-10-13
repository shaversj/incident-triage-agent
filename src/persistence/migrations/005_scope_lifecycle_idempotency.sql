ALTER TABLE incident_verification_events
  DROP CONSTRAINT IF EXISTS incident_verification_events_source_event_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS incident_verification_events_incident_source_key_idx
  ON incident_verification_events (incident_id, source_event_key);

ALTER TABLE incident_recovery_events
  DROP CONSTRAINT IF EXISTS incident_recovery_events_source_event_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS incident_recovery_events_incident_class_source_key_idx
  ON incident_recovery_events (incident_id, failure_class, source_event_key);
