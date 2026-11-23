-- 20 Nov 2026 (live-draft review, C): a live draft survives Propose. Its
-- proposal goes up for a vote as a change of its own (a chat_sessions row
-- whose branch starts at the draft's head), and the draft keeps its own
-- branch, its own preview and its edits. Edits after Propose stay on the
-- draft until its author taps Update proposal, which moves the proposal's
-- head to the draft's (services/live-drafts.js updateProposal).
--
--   proposal_session_id  the change the draft was proposed as; NULL until
--                        Propose, and on every draft proposed before this
--                        (those were proposed as the draft's own change and
--                        are never edited again)
--   proposed_head_sha    the draft's head the proposal is at now: the edits
--                        after it are the ones "not in the proposal yet"
--   proposed_at          when it was proposed, or last updated
--
-- Only ADDS nullable columns, so a build from before keeps reading and
-- writing live_drafts as it did: to it, a draft in state 'proposed' is not
-- open, exactly as before. The state CHECK and the one-open-draft index are
-- untouched.
ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS proposal_session_id INTEGER
  REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS proposed_head_sha VARCHAR(40);
ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS live_drafts_proposal_session_idx
  ON live_drafts (proposal_session_id) WHERE proposal_session_id IS NOT NULL;
