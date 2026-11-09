-- Invite links with no cap and no end by default, and the leaked-link guard
-- (services/community-invites.js GUARD).
--
-- A new link works for any number of people and never expires unless its
-- maker chooses a limit or an end date. Both columns already allow NULL for
-- that (the baseline's WP-D lines); what changes is the default, which the
-- service now asks for itself. A link made before this keeps its limit and
-- its end date: no existing row is touched.
ALTER TABLE community_invites ALTER COLUMN max_uses DROP DEFAULT;

-- THE GUARD. Joins through one link are counted over a rolling 24 hours,
-- from `reopened_at` when its maker opened it again since. At 20 its maker
-- is told once in that window (`busy_noticed_at`, with a one-tap Turn off);
-- at 100 the link PAUSES (`paused_at`): new joins through it are refused
-- until its maker opens it again, which clears the pause and restarts the
-- count from then. Somebody already queued on it still joins when let in:
-- a pause refuses new joins, never one already made. The redeem path counts
-- and pauses under the link's row lock, so two joins at once cannot both
-- slip past the line.
ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS busy_noticed_at TIMESTAMPTZ;

-- The guard's count: one link's redemptions since a moment.
CREATE INDEX IF NOT EXISTS idx_community_invite_redemptions_invite_created
  ON community_invite_redemptions (invite_id, created_at);
