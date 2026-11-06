-- 6 Nov 2026 (#6395): whether a go-ahead from the person the bot's last note
-- named can settle a request it handed back, and the smaller first step the
-- read named. Both are nullable: a run written before this change has
-- neither, and is read once more when somebody says go ahead.
--
-- `go_ahead_decides` is false when a go-ahead would still leave the request
-- `person`: credentials, auth, billing, permissions, operator work outside
-- the app, a database change that is not append-only, or a change too big
-- for one build. The note then offers no Go ahead, and the chat's
-- start_request answers with the one plain line instead of queueing a read.
--
-- `first_step` is the part that can be built here, the same words the note
-- already offers as a button.

ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS go_ahead_decides BOOLEAN;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS first_step TEXT;
