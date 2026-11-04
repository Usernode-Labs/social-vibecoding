-- #6251: what a request drafted in a chat carries besides its words, shown
-- on the draft before File it and kept in the filed request: the pictures
-- the person attached that belong with it, the open requests that overlap
-- (with how), where it happened, and one to three Done when checks.
-- { attachmentIds: [], related: [{ number, title, relation, why }],
--   context: { request?: { slug, name, number }, saw?, quoted? },
--   doneWhen: [], chatHref }. Nullable: older rows and every other kind of
-- action keep null.
ALTER TABLE homeroom_bot_dm_actions ADD COLUMN IF NOT EXISTS draft_extras JSONB;
