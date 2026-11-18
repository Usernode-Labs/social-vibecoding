-- Homeroom bot's replies, laid out (18 Nov 2026): how each turn's laid-out
-- copy went, so the share of long replies that carry one can be read from
-- the records instead of from the messages.
--
-- html_status: what was sent beside the words.
--   'model'  the model's own copy, its words still the reply's;
--   'layout' made from the final words by the layout pass, in time;
--   'late'   made by the layout pass after the words were sent, and put on
--            the message when it landed;
--   'short'  none was needed: the reply is two short lines or less;
--   'failed' a long reply went as words: the layout pass failed, and why is
--            one of the turn's failures ('layout:timeout', 'layout:unfaithful');
--   'none'   a long reply went as words with no layout pass (an offer's line
--            over its draft, a screen handed to the designer).
-- NULL for a turn that answered with a fallback, and for every turn before.
-- html_model: what the model gave: 'kept', 'dropped' (its words no longer
-- matched the reply's) or 'none'.
ALTER TABLE homeroom_bot_dm_turns ADD COLUMN IF NOT EXISTS html_status TEXT;
ALTER TABLE homeroom_bot_dm_turns ADD COLUMN IF NOT EXISTS html_model TEXT;
ALTER TABLE homeroom_bot_voice_turns ADD COLUMN IF NOT EXISTS html_status TEXT;
ALTER TABLE homeroom_bot_voice_turns ADD COLUMN IF NOT EXISTS html_model TEXT;
