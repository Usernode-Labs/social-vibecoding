-- Homeroom bot, one model, step 4's review (11 Nov 2026,
-- docs/plans/bot-one-model.md; src/services/bot-post.js).
--
-- A post's claim is held, not just made. Two passes asking for one post at
-- once used to both find its row pending and both say it (two messages,
-- two GitHub comments). The ask that writes the row, or takes over one a
-- crash left, holds it (`claimed_at`, `claimed_by`); another ask while it
-- is held says nothing, and a pending row is taken over only once its claim
-- has lapsed (bot-post.js CLAIM_LEASE_SECONDS), by one conditional UPDATE.
-- A post whose send failed lets go of its claim, so its retry takes it up
-- at once. A row from before has no claim: it is taken up by the first ask.
-- A durable work's own post (`claim_durable`: a run's, a look's, a turn's,
-- whose key names that work) is taken over at once by that work asked
-- again after a crash, as before: its runtime runs one attempt at a time.
ALTER TABLE bot_posts ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE bot_posts ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE bot_posts ADD COLUMN IF NOT EXISTS claim_durable BOOLEAN NOT NULL DEFAULT FALSE;

-- The place's last note is its newest message (bot-post.js LAST_NOTE_SQL),
-- not its newest row: the rows the bot-posts migration copied from
-- homeroom_bot_posts were written in no particular order.
DROP INDEX IF EXISTS idx_bot_posts_place;
CREATE INDEX IF NOT EXISTS idx_bot_posts_place_message
  ON bot_posts(app_id, place_type, place_ref, chat_message_id DESC) WHERE outcome = 'said';

-- A post's place is where its message is. A note said on a change alone
-- (live.postOnProposal before keys, and live.post's proposal-only answer)
-- was copied as the request's, with the change's message: the request's
-- last failure note must never be a message on another thread.
UPDATE bot_posts p
   SET place_type = m.thread_type, place_ref = m.thread_ref
  FROM chat_messages m
 WHERE m.id = p.chat_message_id AND m.thread_type IS NOT NULL AND m.thread_ref IS NOT NULL
   AND p.place_type <> 'dm'
   AND (p.place_type <> m.thread_type OR p.place_ref IS DISTINCT FROM m.thread_ref::bigint);

-- The words of the posts copied from before, digested as bot-post.js
-- digestOf does (the people tagged at the start left out, spaces folded),
-- so the first failure after the release that says what the last note
-- said is a repeat too. A note an older release rewrote ("(Tried 3
-- times.)") or one cut at the message limit still differs: that is said
-- once more, at most once per request.
UPDATE bot_posts p
   SET words_digest = left(encode(sha256(convert_to(NULLIF(btrim(regexp_replace(
         regexp_replace(m.content, '^(?:@[A-Za-z0-9_.-]+\s+)+', ''), '\s+', ' ', 'g'), ' '), ''), 'UTF8')), 'hex'), 32)
  FROM chat_messages m
 WHERE m.id = p.chat_message_id AND p.words_digest IS NULL AND p.place_type <> 'dm';
