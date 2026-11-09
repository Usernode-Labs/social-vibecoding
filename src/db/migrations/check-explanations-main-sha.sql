-- The commit main was red at when a failed run's explanation was written
-- (services/checks-explanation.js, #6288). While main fails a test, a
-- change built on it fails the same test through no fault of its own, and
-- the sentence the Testing card shows must say so. Main's red is part of
-- what the sentence is about, so it belongs in the row's identity: when
-- main's red sha moves (a fix landed, or a new red), the stale sentence is
-- written again instead of claiming main's old failure. NULL when main was
-- green, or when the sentence was written before this column existed.

ALTER TABLE check_explanations ADD COLUMN IF NOT EXISTS main_sha VARCHAR(40);
