-- Translate (services/mail/template-translate.js): one job per template or
-- layout version, kept here so its progress outlives the page that started it
-- and a second press while one runs finds it. `per_language` maps each locale
-- to 'pending', 'saved', 'failed: <reason>' or 'skipped: admin'. A row is
-- reused by the next press on the same version once it has finished.
-- `version_id` names an email_templates or email_layouts row, by `kind`.
CREATE TABLE IF NOT EXISTS email_translation_jobs (
  kind         TEXT NOT NULL CHECK (kind IN ('template', 'layout')),
  version_id   INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('running', 'done')),
  per_language JSONB NOT NULL DEFAULT '{}'::jsonb,
  overwrite    BOOLEAN NOT NULL DEFAULT FALSE,
  started_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, version_id)
);

-- A translation that stopped working with what it is sent with (a layout
-- saved since, a template it frames) is marked here with the reason instead
-- of refusing that save or being deleted: the sender skips it and uses the
-- English of that part, and an admin's own text is kept for them to fix.
-- Saving the translation again clears it.
ALTER TABLE email_template_translations ADD COLUMN IF NOT EXISTS unusable TEXT;
ALTER TABLE email_layout_translations ADD COLUMN IF NOT EXISTS unusable TEXT;
