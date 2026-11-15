-- #6684: a comment on a request while Homeroom bot builds it goes into the
-- build, is queued in the change's next update, or is offered as its own
-- request (services/homeroom-bot-steer.js, homeroom-bot-voice.js).
--
-- `origin` says where a note came from: NULL is a private chat with the bot,
-- 'request' a comment on the request's own discussion. A note from a request
-- needs no tap to go into the change's next update (the words are already
-- public on the request), so settleNotes forwards it by itself.
-- `chat_message_id` is the bot's reply carrying the note's card on the
-- request. `comment_id` is the person's own comment, which is the note.
ALTER TABLE homeroom_bot_build_notes
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS chat_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS comment_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE homeroom_bot_build_notes
    ADD CONSTRAINT homeroom_bot_build_notes_origin_check
    CHECK (origin IS NULL OR origin = 'request');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The notes from a request still waiting to be forwarded, found without a
-- scan of the table.
CREATE INDEX IF NOT EXISTS homeroom_bot_build_notes_missed_request_idx
  ON homeroom_bot_build_notes (app_id, issue_number)
  WHERE origin = 'request' AND state = 'missed';
