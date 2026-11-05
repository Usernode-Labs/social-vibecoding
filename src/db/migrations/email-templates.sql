-- Email templates and layouts an admin can edit. Every edit is a new version
-- row: the previous live row becomes 'archived', and a partial unique index
-- allows one live, non-deleted row per template action (per family for
-- layouts), so two racing saves cannot both win. Deleting is soft
-- (deleted_at), so a delete can be undone. A layout "family" is the thread of
-- versions of one layout; it is not a row of its own, which is why
-- email_templates.layout_family_id has no foreign key and the store checks it.
-- A translation belongs to one version row, so a new version starts with none:
-- that is how an out-of-date translation is told from a current one.
CREATE SEQUENCE IF NOT EXISTS email_layout_family_seq;

CREATE TABLE IF NOT EXISTS email_layouts (
  id         SERIAL PRIMARY KEY,
  family_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('live', 'archived')),
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (family_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS email_layouts_one_live
  ON email_layouts (family_id) WHERE status = 'live' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS email_templates (
  id                SERIAL PRIMARY KEY,
  action            TEXT NOT NULL,
  name              TEXT NOT NULL,
  layout_family_id  INTEGER,
  version           INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('live', 'archived')),
  subject           TEXT NOT NULL,
  preheader         TEXT NOT NULL DEFAULT '',
  why               TEXT NOT NULL DEFAULT '',
  html              TEXT NOT NULL,
  text              TEXT NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (action, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_one_live
  ON email_templates (action) WHERE status = 'live' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_templates_layout_family ON email_templates (layout_family_id);

CREATE TABLE IF NOT EXISTS email_layout_translations (
  layout_id  INTEGER NOT NULL REFERENCES email_layouts(id) ON DELETE CASCADE,
  locale     TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  origin     TEXT NOT NULL CHECK (origin IN ('machine', 'admin')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (layout_id, locale)
);

CREATE TABLE IF NOT EXISTS email_template_translations (
  template_id INTEGER NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
  locale      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  preheader   TEXT NOT NULL DEFAULT '',
  why         TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL,
  text        TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('machine', 'admin')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (template_id, locale)
);

-- Images an admin uploads for use in a template, served by id.
CREATE TABLE IF NOT EXISTS email_images (
  id           VARCHAR(32) PRIMARY KEY,
  content_type TEXT NOT NULL,
  data         BYTEA NOT NULL,
  filename     TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
