-- 27 Nov 2026 (runtime/wasm/README.md): Wasm previews, a pilot.
--
-- A project an admin switches to Wasm previews (platform_settings
-- 'wasm_previews', services/wasm-previews.js) gets, for each proposal
-- preview, a second preview from the same commit whose backend is a
-- WebAssembly module run on shared runners.
--
-- wasm_modules holds each compiled module once, named by its SHA-256: a
-- runner asks the platform for the module a pass names and checks the bytes
-- hash to that name (routes/wasm-internal.js). Modules are small (tens of KB
-- to a few MB); one is kept while a twin that serves names it, and the
-- sweep (services/wasm-runtime.js) drops the rest after a day.
--
-- chat_sessions.wasm_twin is the serving twin of a preview, as the preview
-- machine published it beside the Node preview's staging_* columns: its
-- database, module, address and when it started serving. NULL when the
-- preview has no twin. The gate reads it to sign each request's pass.

CREATE TABLE IF NOT EXISTS wasm_modules (
  sha256      TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       BYTEA NOT NULL,
  size        INTEGER NOT NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wasm_modules_used_at ON wasm_modules (used_at);

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS wasm_twin JSONB;
