-- One press of Send is one comment, even when the send is slow (issue
-- #6730). The composer makes a random key when it first presses Send and
-- keeps reusing it while the words are unchanged, so a retry after a hung
-- spinner can be matched to the row the first attempt already stored. The
-- key means nothing else and is never shown; rows written without one
-- (bots, system entries, older clients, MCP post_message) stay NULL, and
-- the index is partial so they are not constrained at all.
--
-- The lookup and the index both include app_id and user_id: a key replayed
-- by someone else, or in another project, can never match.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_key VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client_key
  ON chat_messages (app_id, user_id, client_key)
  WHERE user_id IS NOT NULL AND client_key IS NOT NULL;
