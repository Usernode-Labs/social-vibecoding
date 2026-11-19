-- Request #6137: the name a person gives one of their connections in
-- Settings > Connectors, so two connections of the same tool can be told
-- apart ("Work laptop", "Phone"). A connection is a GRANT: one consent, whose
-- mcp_tokens rows are replaced on every refresh, so there is no single row to
-- carry a column and the name is keyed by grant_id here instead. Nothing that
-- issues, refreshes or revokes a credential reads or writes this table: only
-- PATCH /api/me/connectors/:id writes it and the Settings list reads it.
-- A missing row means "no name", which is what every connection had before
-- (the row then shows the tool's own name). Rows go with the account.
-- staging:private like mcp_tokens: text a person typed about their own setup.
CREATE TABLE IF NOT EXISTS mcp_grant_labels (
  grant_id   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mcp_grant_labels_user_idx ON mcp_grant_labels (user_id);
COMMENT ON TABLE mcp_grant_labels IS 'staging:private';
