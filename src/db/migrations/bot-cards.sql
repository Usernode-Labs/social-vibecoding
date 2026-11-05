-- Homeroom bot's cards, in one store (docs/plans/bot-one-model.md, step 2;
-- src/services/bot-cards.js). Every offer it makes and every card it draws
-- with something to tap: said on one message (a conversation message, or a
-- project thread's chat message), for one person (for_user_id) or anybody
-- its kind allows, open until decided or expired.
--
-- No foreign key to the messages or the change a card is about: a card is
-- written before its message, and is read by its id from that message's
-- metadata. A deleted person's or project's cards go with them.

CREATE TABLE IF NOT EXISTS bot_cards (
  id                       BIGSERIAL PRIMARY KEY,
  kind                     TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z_]{1,39}$'),
  for_user_id              INTEGER REFERENCES users(id) ON DELETE CASCADE,
  app_id                   INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  conversation_message_id  INTEGER,
  chat_message_id          INTEGER,
  payload                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined', 'expired')),
  choice                   TEXT,
  decided_by               INTEGER,
  decided_at               TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bot_cards_open_expiry_idx ON bot_cards (expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS bot_cards_conversation_message_idx ON bot_cards (conversation_message_id) WHERE conversation_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_cards_chat_message_idx ON bot_cards (chat_message_id) WHERE chat_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_cards_user_open_idx ON bot_cards (for_user_id, created_at DESC) WHERE status = 'open';
