-- 24 Nov 2026: a live draft's follow-up once its preview is built again
-- (services/live-drafts.js followUp). In one thread the bot said "say 'try
-- now' again and I will look" while the preview was being built, though the
-- preview reloads the person's view by itself. Now a turn whose save, or
-- whose look, met a preview being built arms one follow-up: once that
-- preview serves the draft's head, Homeroom looks at it and posts one line in
-- the thread, so nobody has to ask again.
--
--   followup_path      the page of the app to look at then ("/" when the
--                      turn named none), already checked as a path inside
--                      the app (preview-look.js previewPath)
--   followup_armed_at  when it was armed; NULL when none is waiting. A
--                      follow-up runs once and clears it, and one older
--                      than 15 minutes, or in a thread the person wrote in
--                      since, is dropped
--
-- Only ADDS nullable columns, so a build from before keeps reading and
-- writing live_drafts as it did. The table stays staging:private.
ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS followup_path TEXT;
ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS followup_armed_at TIMESTAMPTZ;
