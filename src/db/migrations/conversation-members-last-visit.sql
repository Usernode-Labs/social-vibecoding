-- #6426: when each person last looked at a conversation. Main Chat's
-- "Welcome back" card shows after 8 hours away, measured from the last visit
-- its read state recorded (services/conversations.js markRead). Nullable and
-- never backfilled: a member with no visit yet has no card to show.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMPTZ;
