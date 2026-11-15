-- 15 Nov 2026: agent chats (a person's conversation with the Mayor,
-- `agent_sessions`) and dev chats (a classic change's own chat) are retired.
-- A person works with Homeroom bot in its threads, or with their own coding
-- agent. What they and the agent said in those chats is copied, once, into
-- their chat with Homeroom bot: one finished thread per old conversation
-- (services/old-chat-move.js; db/migrate.js moveOldChatsToThreads runs it at
-- boot, a conversation at a time).
--
-- This table is where each one went: the thread's first message, and the
-- last `chat_session_messages` row copied, so a second run copies only what
-- an older instance wrote after the first. `source` 'agent' is an
-- agent_sessions id, 'session' a chat_sessions id. No foreign key to either:
-- the agent_sessions table is dropped by a later migration, and this row
-- outlives it so an old link still finds its thread
-- (GET /api/ai/where?agentChat=).
CREATE TABLE IF NOT EXISTS moved_chats (
  source          VARCHAR(8) NOT NULL CHECK (source IN ('agent', 'session')),
  source_id       INTEGER NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  through_id      INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS moved_chats_user_idx ON moved_chats (user_id);
COMMENT ON TABLE moved_chats IS 'staging:private';
