-- Homeroom bot's cards, in one store (5 Nov 2026, docs/plans/bot-one-model.md,
-- step 2, decision 3; src/services/bot-cards.js). Every offer it makes with
-- something to tap, wherever it is said: in a person's chat with the bot
-- (`place` 'dm': a conversation message, `message_id`) or in a project's
-- thread (`place` 'thread': a chat message, `chat_message_id`).
--
-- The chat's offer table is the store, renamed: its rows, open or decided,
-- stay as they are (no data is copied), and new offers of a project's thread
-- are written here too. Those said before in a thread stay answerable in
-- homeroom_bot_voice_offers until they are answered or 14 days old; a later
-- cleanup drops that table. A card expires 14 days after it is made
-- (`expires_at`): an open one already here, 14 days from this migration.
--
-- The old name stays a view of the chat's cards for one release, so a pod
-- of the build before this one, still serving while this one starts, reads
-- and writes the same rows; the cleanup drops it.

ALTER TABLE IF EXISTS homeroom_bot_dm_actions RENAME TO bot_cards;
ALTER TABLE bot_cards RENAME CONSTRAINT homeroom_bot_dm_actions_kind_check TO bot_cards_kind_check;
ALTER TABLE bot_cards RENAME CONSTRAINT homeroom_bot_dm_actions_status_check TO bot_cards_status_check;

ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS place TEXT NOT NULL DEFAULT 'dm';
ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS chat_message_id INTEGER UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE;
ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS args JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days';
-- A thread's offer may be for anybody its kind allows, and has no title.
ALTER TABLE bot_cards ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE bot_cards ALTER COLUMN title SET DEFAULT '';

ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_place_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_place_check CHECK (
  (place = 'dm' AND user_id IS NOT NULL AND chat_message_id IS NULL)
  OR (place = 'thread' AND message_id IS NULL AND conversation_id IS NULL)
);
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_kind_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design', 'copy_request', 'file_many', 'withdraw_change', 'try_again'));
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_status_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_status_check
  CHECK (status IN ('open', 'deciding', 'done', 'declined', 'failed', 'expired'));

-- Every card from now on has an id above every offer a thread holds already,
-- with room for the few a pod of the build before may still write there, so
-- an id names one row (homeroom-bot-voice.js OFFERS_SQL).
SELECT setval(pg_get_serial_sequence('bot_cards', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 0) FROM bot_cards),
                       (SELECT COALESCE(MAX(id), 0) FROM homeroom_bot_voice_offers)) + 1000000);

CREATE INDEX IF NOT EXISTS bot_cards_open_expiry_idx ON bot_cards (expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS bot_cards_thread_app_idx ON bot_cards (app_id, status, id) WHERE place = 'thread';
COMMENT ON TABLE bot_cards IS 'staging:private';

-- The old name, for the build before this one (see above).
CREATE OR REPLACE VIEW homeroom_bot_dm_actions AS
  SELECT id, user_id, conversation_id, message_id, app_id, kind, title, details, status, issue_number, error,
         created_at, decided_at, session_id, source_issue_number, target_message_id, decided_key,
         private_thread_id, design_version
    FROM bot_cards
   WHERE place = 'dm';
