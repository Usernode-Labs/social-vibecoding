-- 20 Nov 2026 (live-draft review, C): Homeroom bot offers a live draft's
-- Propose, and its Update proposal once it is up for a vote, as a card under
-- its reply (homeroom-bot-mayor.js offer_propose_draft). Only the person's tap
-- proposes or updates it (decideDraftProposal); the card names the draft in
-- `args` ({ draftId }).
--
--   propose_draft          Propose and Not yet: the draft put to the vote
--   update_draft_proposal  Update proposal and Not yet: the changes made
--                          since moved into its proposal
--
-- Only widens the kind list: the list is the one before it (invite-nudges)
-- with the two added, so a build from before reads and writes every row it
-- did, and never writes these.
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_kind_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design', 'copy_request', 'file_many', 'withdraw_change', 'try_again', 'overlap',
                  'run_shots', 'post_pictures_plan', 'invite_friends', 'propose_draft', 'update_draft_proposal'));
