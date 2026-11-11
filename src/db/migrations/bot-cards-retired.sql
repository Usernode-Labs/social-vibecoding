-- Homeroom bot, one model, step 3 (11 Nov 2026): one offer store, written
-- with its message (docs/plans/bot-one-model.md; src/services/bot-cards.js).
--
-- Every new card is written in the same transaction as the message that
-- shows its buttons (ws.sendBotMessage and homeroom-bot-dm.js sendDm take a
-- `card`), so a card whose buttons are on screen is always found by its id.
--
-- A card's buttons also go when the request or change it is about moves on
-- (bot-cards.js retireFor, from the standing in work_states): a vote on
-- closing the request opened, its build started, it closed, or a newer note
-- of the same kind took its place. `retired` is that card's status, and
-- `retired_reason` says which, for the line the buttons leave behind
-- ('close_vote', 'closed', 'building', 'moved_on', 'superseded').
ALTER TABLE bot_cards ADD COLUMN IF NOT EXISTS retired_reason TEXT;
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_status_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_status_check
  CHECK (status IN ('open', 'deciding', 'done', 'declined', 'failed', 'expired', 'retired'));

-- A thread card made before this, whose message was written but whose link
-- to it was lost (the separate write after the message, #6582), is linked
-- now: its message names it. A tap finds every card by its id from here on
-- (homeroom-bot-voice.js decideOffer), through its message.
UPDATE bot_cards c SET chat_message_id = m.id
  FROM chat_messages m
 WHERE c.place = 'thread' AND c.chat_message_id IS NULL AND c.status = 'open'
   AND m.app_id = c.app_id
   AND m.user_id IN (SELECT u.id FROM users u WHERE u.username = 'homeroom_bot')
   AND (m.metadata->'homeroomBot'->'offer'->>'id') = c.id::text
   AND NOT EXISTS (SELECT 1 FROM bot_cards x WHERE x.chat_message_id = m.id);
