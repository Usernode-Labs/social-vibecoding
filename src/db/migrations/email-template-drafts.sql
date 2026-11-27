-- Email template drafts (Admin > Email templates). A draft is a version an
-- admin is still working on: it is saved, previewed and test-sent to the admin
-- like any version, but it is never sent to anyone. The sender reads only the
-- live row (services/mail/template-store.js snapshot), so a draft changes
-- nothing until an admin puts it live, which archives the live row as any
-- save does. One open draft per action, so the editor always knows which one
-- it is continuing.
ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_status_check;
ALTER TABLE email_templates ADD CONSTRAINT email_templates_status_check
  CHECK (status IN ('live', 'archived', 'draft'));
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_one_draft
  ON email_templates (action) WHERE status = 'draft' AND deleted_at IS NULL;
