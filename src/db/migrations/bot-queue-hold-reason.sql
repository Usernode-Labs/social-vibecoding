-- #6357: why a queued request is held, beside until when. A hold was only
-- ever read as its payer's week being used up ("On hold until Monday"), but
-- the bot-request workflow also holds a request for a day after its look
-- threw THROWN_TRIES times in a row (src/workflow/rules/bot-loop.ts), which
-- has nothing to do with building time. The workflow now records which one
-- it is (`allowance` or `cooldown`) and projects it here.
--
-- A hold written before this column existed has no reason: readers infer it
-- (homeroom-bot-progress.js holdOf). An allowance hold always lifts at the
-- week's reset, Monday 00:00 UTC, and a cooldown a day after its last try,
-- so a hold that ends exactly on that boundary is the allowance's and any
-- other is a cooldown.
ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS held_reason TEXT;
ALTER TABLE homeroom_bot_queue DROP CONSTRAINT IF EXISTS homeroom_bot_queue_held_reason_check;
ALTER TABLE homeroom_bot_queue ADD CONSTRAINT homeroom_bot_queue_held_reason_check
  CHECK (held_reason IS NULL OR held_reason IN ('allowance', 'cooldown'));
