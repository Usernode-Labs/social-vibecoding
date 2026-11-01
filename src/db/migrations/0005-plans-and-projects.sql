-- Threads, one loop (phase C2): a design posts as a plan, Homeroom bot
-- builds from a person's plan, and a new project is made from a private
-- thread.

-- "Looks good", answered with a card (homeroom-bot-mayor.js, offer kind
-- 'post_design'): Post as a plan on #N, or New request. What it posts is
-- the private thread's design (`private_thread_id`) at `design_version`;
-- the request it posts on is `source_issue_number`, none for a new one.
-- Its button carries only yes or no: the number is always the server's.
ALTER TABLE homeroom_bot_dm_actions
  ADD COLUMN IF NOT EXISTS private_thread_id BIGINT REFERENCES private_threads(id) ON DELETE CASCADE;
ALTER TABLE homeroom_bot_dm_actions ADD COLUMN IF NOT EXISTS design_version INTEGER;
CREATE INDEX IF NOT EXISTS homeroom_bot_dm_actions_private_thread_idx
  ON homeroom_bot_dm_actions (private_thread_id) WHERE private_thread_id IS NOT NULL;
ALTER TABLE homeroom_bot_dm_actions DROP CONSTRAINT IF EXISTS homeroom_bot_dm_actions_kind_check;
ALTER TABLE homeroom_bot_dm_actions ADD CONSTRAINT homeroom_bot_dm_actions_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design'));

-- The plan a change was built from (homeroom-bot.js buildLive): a person's
-- plan on its request, or the bot's own plan its requester said Build it
-- to. The request's page draws the plan with that change (threads.js
-- builtFrom, request-head.tsx plansByChange). No foreign key: a session's
-- delete would scan every session for it.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS built_from_session_id INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS built_from_version INTEGER;

-- A project made from a private thread's design (POST /api/apps `design`):
-- its first request is filed with that design as its plan, which the bot
-- builds the first version from (homeroom-bot-dm.js fileFirstRequest).
ALTER TABLE homeroom_bot_first_versions
  ADD COLUMN IF NOT EXISTS design_thread_id BIGINT REFERENCES private_threads(id) ON DELETE SET NULL;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS design_version INTEGER;
