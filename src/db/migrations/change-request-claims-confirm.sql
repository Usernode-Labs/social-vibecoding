-- #6606: the request's filer can answer a change's claim the other way too.
-- `disputed_at` says "This doesn't close it"; `confirmed_at` says it does.
-- One answer per claim: the service refuses to write either after one holds.
ALTER TABLE change_request_claims
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
