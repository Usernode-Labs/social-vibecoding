-- 17 Nov 2026: which of the two things a go-ahead cannot settle a read found,
-- when it set `go_ahead_decides` false: 'operator_work' (work outside the
-- app) or 'destructive_db' (a database change that is not append-only).
--
-- The bare false was set far beyond those two (sign-in fixes, large requests,
-- product direction), and a stored one was said again to every later
-- go-ahead with no new read. Nullable: a run written before this change has
-- none, so its refusal is not said again and the request is read once more.

ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS go_ahead_blocker TEXT;
