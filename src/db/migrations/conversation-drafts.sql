-- Saved drafts in the chat with Homeroom bot: the list the agent chats have
-- (chat_session_drafts, agent_session_drafts), for a person's own chat with
-- the bot. While the bot works on their message, what they type next is
-- saved here instead of sent, and sent later by a tap, never on its own
-- (routes/conversations.js, the bot-drafts routes; the composer's rule is
-- frontend/src/features/messages/bot-stop.ts).
--
-- One list per person, per conversation, per place in it: thread_root_id is
-- the main-stream message a thread hangs off, or 0 for the chat itself. It is
-- 0 and not NULL so the four columns can be the primary key; it carries no
-- foreign key for that reason, and needs none: the route only takes a root
-- that is a main-stream message of the conversation, and roots are only ever
-- soft-deleted, so a draft's rows leave with the conversation or the person.
--
-- draft_id is client-generated (`d<base36 time><rand>`), as in the two tables
-- above, so a save sent twice is one row. Text only, at most the composer's
-- own 8000 characters (conversation_messages.content's limit); 20 drafts per
-- list, enforced at insert time. saved_at orders the list, oldest first.
CREATE TABLE IF NOT EXISTS conversation_drafts (
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER     NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_root_id  INTEGER     NOT NULL DEFAULT 0 CHECK (thread_root_id >= 0),
  draft_id        VARCHAR(32) NOT NULL,
  content         TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8000),
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id, thread_root_id, draft_id)
);
-- The conversation's cascade finds its rows without reading every person's.
CREATE INDEX IF NOT EXISTS idx_conversation_drafts_conversation
  ON conversation_drafts (conversation_id);
-- Private like the conversation it belongs to: unsent words, and a foreign
-- key to the private conversations.
COMMENT ON TABLE conversation_drafts IS 'staging:private';
