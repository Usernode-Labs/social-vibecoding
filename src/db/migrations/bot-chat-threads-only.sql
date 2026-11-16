-- 14 Nov 2026: Main Chat is removed. Every conversation with Homeroom bot is
-- a thread: in a person's chat with it, every message that is not a reply is
-- the first message of a thread the Homeroom bot page lists
-- (services/homeroom-bot-dm.js sendDm, services/private-threads.js).
--
-- 1. The threads the bot opens itself, beside the ones a person starts:
--      hello          the bot's one hello to a person, and what they ask under it
--      first_version  a new project's first version: "I'm setting up X now",
--                     its plan, its progress, live, and anything that stopped it
--      earlier        a person's Main Chat from before, moved once under one
--                     thread named "Earlier chat" (db/migrate.js
--                     moveMainChatToThreads); one per person
--      note           anything else the bot says with no thread named, and a
--                     message of its own from before that people replied under
ALTER TABLE private_threads DROP CONSTRAINT IF EXISTS private_threads_kind_check;
ALTER TABLE private_threads ADD CONSTRAINT private_threads_kind_check
  CHECK (kind IN ('draft_request', 'draft_reply', 'idea', 'ask', 'design',
                  'hello', 'first_version', 'earlier', 'note'));

CREATE UNIQUE INDEX IF NOT EXISTS private_threads_earlier_idx
  ON private_threads (user_id) WHERE kind = 'earlier';
CREATE INDEX IF NOT EXISTS private_threads_first_version_idx
  ON private_threads (user_id, app_id) WHERE kind = 'first_version';

-- 2. A thread carries its own unread. `last_read_message_id` is its owner's
-- cursor in it: every message of the thread above it (its first message or a
-- reply), from somebody else and not deleted, is unread
-- (services/private-threads.js unreadFor). NULL is a thread nothing of which
-- was read: one the bot opened. The chat's badge is the sum over a person's
-- threads that are not done (services/conversations.js botUnread).
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS last_read_message_id INTEGER;

-- The threads that exist start read, but for what their alerts still say is
-- unread: a thread's read state was its alerts until now
-- (services/conversations.js listThread), so the cursor stops just before
-- the first message an unread alert is about.
UPDATE private_threads p
   SET last_read_message_id = COALESCE(
         (SELECT MIN(m.id) - 1 FROM notifications n
            JOIN conversation_messages m ON m.id = n.conversation_message_id
           WHERE n.user_id = p.user_id AND n.read_at IS NULL AND m.deleted_at IS NULL
             AND (m.thread_root_id = p.root_message_id OR m.id = p.root_message_id)),
         (SELECT MAX(m.id) FROM conversation_messages m
           WHERE m.thread_root_id = p.root_message_id OR m.id = p.root_message_id),
         p.root_message_id)
 WHERE p.last_read_message_id IS NULL;

-- 3. The weekly account notices (close to this week's building time; on hold
-- until Monday, the person's time or the bot's budget) are bell rows now, not
-- chat messages (services/homeroom-bot-notices.js). Once a week each: this
-- row is the "once", written with the bell row.
CREATE TABLE IF NOT EXISTS homeroom_bot_notices (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            VARCHAR(24) NOT NULL CHECK (kind IN ('allowance_low', 'allowance', 'paused')),
  week            VARCHAR(8) NOT NULL,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, week)
);
COMMENT ON TABLE homeroom_bot_notices IS 'staging:private';

-- 4. The bring-a-friend nudge is a bell row too (kind 'invite_nudge', which
-- has no push category, so it wakes no phone, as the chat message rang
-- nothing). `notification_id` is that row; `card_id` and `message_id` stay
-- for the nudges sent as a chat card before, whose Not now still works.
ALTER TABLE invite_nudges ADD COLUMN IF NOT EXISTS notification_id
  INTEGER REFERENCES notifications(id) ON DELETE SET NULL;
