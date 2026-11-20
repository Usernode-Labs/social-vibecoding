-- Review B3 (19 Nov 2026): a stored work state's edges are safe.
--
-- Which derive wrote a row (services/work-state.js DERIVE_VERSION) gets a
-- column of its own. It was only the standing's `v`, so raising it made
-- every row that the sweep derived again count as changed: a push each, and
-- a new updated_at that reordered every list sorted by it. A release keeps
-- writing `v` as well, for the Pods of the release before it, which read
-- only that; the sweep reads the lower of the two (work-state.js versionOf).
-- Additive: a row from before has none, and reads as written by version 0.
ALTER TABLE work_states ADD COLUMN IF NOT EXISTS derive_version INTEGER;

-- The moment a stored work state rang its requester's bell, as one key: the
-- item, the stage with its why or reason, and since when (work-state.js
-- bellKeyOf). The bell is not rung again for a key whose row is still
-- unread, so a move that is stored twice (a stale write put right a few
-- seconds later) rings once. Additive and nullable: every other kind of
-- notification, and a bell a Pod of the release before this one rang, has
-- none. Read only beside the person's own unread rows
-- (idx_notifications_user_unread), so it needs no index of its own.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS bell_key TEXT;
