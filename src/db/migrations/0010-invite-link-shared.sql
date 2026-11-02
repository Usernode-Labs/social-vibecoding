-- Audit D03 (2 Nov 2026): when an invite link actually went out.
--
-- Opening the Invite pane makes your first link (features/app-context/
-- invite-pane.tsx), so a link existing never meant it was sent: looking at
-- the pane turned a project's Communities row into "Invite link out" and
-- its hub's Share it card into "Invite link sent". The pane now records
-- the first Copy or Share of a link here (POST /api/invite-links/:id/shared),
-- and those lines read it, or somebody having used the link.
ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;

-- A link made before this column cannot say whether it went out; it keeps
-- reading as out, as it did.
UPDATE community_invites SET shared_at = created_at WHERE shared_at IS NULL;
