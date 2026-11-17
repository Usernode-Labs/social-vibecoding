-- #6771: a move offer may name a project other than Homeroom's own board.
--
-- A request filed on one project's board that is really about another app is
-- offered a move there (homeroom-bot-move.js resolveElsewhere, moveRequest).
-- The card that carries the offer records its target here. NULL keeps the
-- meaning every existing row already had: Homeroom's own board.
ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS target_app_id INTEGER REFERENCES apps(id) ON DELETE SET NULL;
