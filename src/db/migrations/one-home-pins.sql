-- One Home (#6361): pinning an app and joining its community are separate.
--
-- Until now an app_favorites row (an app on Home's My apps) joined the app's
-- community (the app_favorites_join_community trigger), and joining wrote one
-- back, so My apps and a person's communities were one set drawn twice. Home
-- now pins the two separately: Pinned apps reads app_favorites, as My apps
-- did, and Pinned communities reads home_community_pins. Either can be pinned
-- without joining. Joining pins the community (services/communities.js join,
-- an invite link below, an accepted invite in services/collab-invites.js);
-- leaving unpins it and leaves the app where it is.
DROP TRIGGER IF EXISTS app_favorites_join_community ON app_favorites;
DROP FUNCTION IF EXISTS sync_favorite_community_member();

-- The communities a person pinned to Home, in their order. The account's,
-- so it follows them to every device; signed out, Home keeps the same list
-- on the device and moves it here at sign-in (services/home-pins.js
-- importPins). Unlike community_pins (the desktop sidebar's four), no
-- membership is needed: a person can follow a community before joining it.
--
-- Not staging:private: it says only which communities a person keeps on
-- their own Home, as app_favorites does for apps.
CREATE TABLE IF NOT EXISTS home_community_pins (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  pinned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, community_id)
);
CREATE INDEX IF NOT EXISTS idx_home_community_pins_community ON home_community_pins (community_id);

-- Who has a stake in an app, for the notifications that ask (the vote digest,
-- a new request, a change put up for a vote): a MEMBER of its community who
-- keeps it on Home, as the app or as the community. Each query adds the app's
-- creator itself, as before. Before this change a pinned app always meant a
-- member (the trigger above), so this is the same audience; it keeps out
-- somebody who only follows a community and could not vote yet.
CREATE OR REPLACE VIEW app_stakes AS
  SELECT a.id AS app_id, m.user_id
    FROM apps a
    JOIN community_members m ON m.community_id = a.community_id
   WHERE EXISTS (SELECT 1 FROM app_favorites f WHERE f.app_id = a.id AND f.user_id = m.user_id)
      OR EXISTS (SELECT 1 FROM home_community_pins p WHERE p.community_id = a.community_id AND p.user_id = m.user_id);

-- Nobody's Home empties. Every community already on someone's My apps, through
-- an app they pinned or one they build, is pinned for them, in My apps' order.
INSERT INTO home_community_pins (community_id, user_id, position, pinned_at)
SELECT DISTINCT ON (a.community_id, f.user_id)
       a.community_id, f.user_id, COALESCE(f.sort_order, 100000), f.created_at
  FROM app_favorites f
  JOIN apps a ON a.id = f.app_id
  JOIN community_members m ON m.community_id = a.community_id AND m.user_id = f.user_id
 WHERE NOT f.hidden AND a.community_id IS NOT NULL
 ORDER BY a.community_id, f.user_id, f.sort_order NULLS LAST
ON CONFLICT (user_id, community_id) DO NOTHING;

INSERT INTO home_community_pins (community_id, user_id, position, pinned_at)
SELECT DISTINCT ON (a.community_id, c.user_id)
       a.community_id, c.user_id, 100000, COALESCE(c.accepted_at, NOW())
  FROM app_collaborators c
  JOIN apps a ON a.id = c.app_id
  JOIN community_members m ON m.community_id = a.community_id AND m.user_id = c.user_id
 WHERE c.status = 'member' AND a.community_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM app_favorites h
                    WHERE h.app_id = c.app_id AND h.user_id = c.user_id AND h.hidden)
 ORDER BY a.community_id, c.user_id
ON CONFLICT (user_id, community_id) DO NOTHING;

-- An invite link joins its community and pins the community, not the app.
CREATE OR REPLACE FUNCTION apply_community_invite(p_redemption INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT x.id, x.user_id, i.app_id, i.created_by, i.revoked_at,
         a.community_id, a.collab_visibility, a.self_hosted
    INTO r
    FROM community_invite_redemptions x
    JOIN community_invites i ON i.id = x.invite_id
    JOIN apps a ON a.id = i.app_id
   WHERE x.id = p_redemption AND x.applied_at IS NULL AND x.status <> 'cancelled';
  IF NOT FOUND OR r.revoked_at IS NOT NULL OR r.community_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF NOT community_invite_maker_holds((SELECT invite_id FROM community_invite_redemptions WHERE id = r.id)) THEN
    RETURN FALSE;
  END IF;
  -- Building by invitation: the link is the maker's collaborator invite,
  -- accepted. The collaborator trigger joins the community from this row.
  IF r.collab_visibility = 'private' AND NOT r.self_hosted THEN
    INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at, accepted_via)
    VALUES (r.app_id, r.user_id, 'member', r.created_by, NOW(), 'link')
    ON CONFLICT (app_id, user_id) DO UPDATE
      SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW()),
          accepted_via = 'link'
      WHERE app_collaborators.status <> 'member';
  END IF;
  INSERT INTO community_members (community_id, user_id, source)
  VALUES (r.community_id, r.user_id, 'joined')
  ON CONFLICT (community_id, user_id) DO NOTHING;
  -- One Home (#6361): joining pins the community to Home, not its app.
  INSERT INTO home_community_pins (community_id, user_id, position)
  SELECT r.community_id, r.user_id, COALESCE(MAX(p.position) + 1, 0)
    FROM home_community_pins p WHERE p.user_id = r.user_id
  ON CONFLICT (user_id, community_id) DO NOTHING;
  UPDATE community_invite_redemptions
     SET status = 'joined', applied_at = NOW()
   WHERE id = r.id;
  RETURN TRUE;
END;
$$;

-- A project's maker finds its community on Home, as a joiner does: the
-- membership the creator's collaborator row writes (source 'creator', in
-- sync_collaborator_community_member) pins the community too, last.
CREATE OR REPLACE FUNCTION pin_created_community() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO home_community_pins (community_id, user_id, position)
  VALUES (NEW.community_id, NEW.user_id,
          COALESCE((SELECT MAX(position) + 1 FROM home_community_pins WHERE user_id = NEW.user_id), 0))
  ON CONFLICT (user_id, community_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS community_members_pin_created ON community_members;
CREATE TRIGGER community_members_pin_created
  AFTER INSERT ON community_members
  FOR EACH ROW WHEN (NEW.source = 'creator')
  EXECUTE FUNCTION pin_created_community();
