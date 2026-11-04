-- #6311: a request can be filed on Homeroom's own board as a copy, beside
-- the move, and the original stays open (homeroom-bot-move.js
-- copyToHomeroom). The person's chat with the bot may offer it there too,
-- so its action kind joins the check 0005 wrote.

ALTER TABLE homeroom_bot_dm_actions DROP CONSTRAINT IF EXISTS homeroom_bot_dm_actions_kind_check;
ALTER TABLE homeroom_bot_dm_actions ADD CONSTRAINT homeroom_bot_dm_actions_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design', 'copy_request'));
