-- #6211: one note in a request's discussion when it is a duplicate of, part
-- of, or overlaps another open request, with a choice for its requester.
--
-- The pair of requests is the key: a note goes out once per pair, whichever
-- request is read first, and a re-read of either one claims nothing new.
-- `issue_number` is the request the note was said in (the one just read);
-- `low_issue` and `high_issue` name the pair in one order, so the pair is
-- the same whichever way round it is found. `offer_id` is the choice card in
-- the note's message (bot_cards, place 'thread'), when there was somebody to
-- ask; a request whose filer has no account still gets the note, with no
-- card, and nothing there.
--
-- Append-only: the rows are a record of what was said, and the app's notes
-- of the last 24 hours are counted from `created_at` (10 a project a day).

CREATE TABLE IF NOT EXISTS homeroom_bot_overlap_offers (
  id SERIAL PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  low_issue INTEGER NOT NULL,
  high_issue INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('duplicate', 'part_of', 'overlaps')),
  issue_number INTEGER NOT NULL,
  offer_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, low_issue, high_issue)
);

CREATE INDEX IF NOT EXISTS homeroom_bot_overlap_offers_day_idx
  ON homeroom_bot_overlap_offers (app_id, created_at);

COMMENT ON TABLE homeroom_bot_overlap_offers IS 'staging:private';

-- An overlap's choice card is a bot card like any other thread offer.
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_kind_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design', 'copy_request', 'file_many', 'withdraw_change', 'try_again', 'overlap'));
