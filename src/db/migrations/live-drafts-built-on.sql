-- 24 Nov 2026: a live draft can start from a proposal that is up for a vote
-- instead of from main (services/live-drafts.js open). Asked to "set the
-- preview to the proposal and make changes to it before voting", Homeroom
-- bot could only open a draft from main.
--
--   built_on_session_id  the proposal (a chat_sessions row) whose branch this
--                        draft's branch was made from; NULL for a draft made
--                        from main, as every draft before this one was.
--                        On the person's own proposal the draft is also
--                        linked to it (proposal_session_id), so Update
--                        proposal moves it. On someone else's it is not: the
--                        draft stays open, and its Propose makes the
--                        person's own proposal stacked on that one
--                        (chat_sessions.waits_for_session_id).
--
-- Only ADDS a nullable column, so a build from before keeps reading and
-- writing live_drafts as it did. The table stays staging:private.
ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS built_on_session_id INTEGER
  REFERENCES chat_sessions(id) ON DELETE SET NULL;
