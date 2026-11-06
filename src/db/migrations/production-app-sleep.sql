-- Operational idle state for an explicitly reviewed Kubernetes app pilot.
-- No request paths, identities or analytics are stored here. Runtime files,
-- database contents and the app's normal status are preserved during sleep.
CREATE TABLE app_runtime_sleep (
  app_id INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  last_request_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  asleep_at TIMESTAMPTZ,
  runtime_name TEXT,
  deployment_uid TEXT,
  CHECK ((asleep_at IS NULL) OR (runtime_name IS NOT NULL AND deployment_uid IS NOT NULL))
);

CREATE INDEX app_runtime_sleep_asleep_idx ON app_runtime_sleep (asleep_at)
  WHERE asleep_at IS NOT NULL;

COMMENT ON TABLE app_runtime_sleep IS 'staging:private';
