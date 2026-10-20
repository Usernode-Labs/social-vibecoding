'use strict';

// A channel's Mute, the viewer's own (#5303; schema.sql "Muted channels").
//
// Muting a channel quiets it for one person: its unread counts nowhere for
// them (services/places.js) and a small private group's "every message"
// ring passes them by (services/group-channel-notify.js). An @mention or a
// reply still reaches them, because being addressed is not channel activity
// (notification-preferences.js keeps a mention account-level for the same
// reason). Nothing is hidden: the channel and its messages are all there.
//
// Only #general for now: `channel_ref` 0. A topic's channel would be its
// registry row's id, which the table already has room for.

const GENERAL = 0;

/** The channel refs `userId` muted in `appId`, as a Set; empty without a viewer. */
async function mutedRefs(db, userId, appId) {
  if (!userId || !appId) return new Set();
  const { rows } = await db.query(
    'SELECT channel_ref FROM channel_mutes WHERE user_id = $1 AND app_id = $2',
    [userId, appId]
  );
  return new Set(rows.map((r) => Number(r.channel_ref)));
}

/** Of `userIds`, the ones who have not muted `ref` in `appId`. */
async function filterUnmuted(db, { userIds, appId, ref = GENERAL }) {
  const ids = (userIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length || !appId) return ids;
  const { rows } = await db.query(
    `SELECT user_id FROM channel_mutes
      WHERE app_id = $1 AND channel_ref = $2 AND user_id = ANY($3::int[])`,
    [appId, ref, ids]
  );
  const muted = new Set(rows.map((r) => Number(r.user_id)));
  return ids.filter((id) => !muted.has(id));
}

/** Mute or unmute `ref` in `appId` for `userId`. Resolves whether it is muted now. */
async function setMuted(db, { userId, appId, ref = GENERAL, muted }) {
  if (muted) {
    await db.query(
      `INSERT INTO channel_mutes (user_id, app_id, channel_ref) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, app_id, channel_ref) DO NOTHING`,
      [userId, appId, ref]
    );
    return true;
  }
  await db.query(
    'DELETE FROM channel_mutes WHERE user_id = $1 AND app_id = $2 AND channel_ref = $3',
    [userId, appId, ref]
  );
  return false;
}

module.exports = { GENERAL, mutedRefs, filterUnmuted, setMuted };
