'use strict';

// The app discussions the Messages screen lists beside a viewer's people.
//
//   GET /api/messages/app-discussions
//        → { discussions: [{ slug, name, channel, iconUrl, iconEmoji,
//                            lastMessage, lastAt, lastBy }, …] }
//
// ── They are CHANNELS now (#2783) ──────────────────────────────────────
//
// The Messages list is sectioned the way Discord's is: people and agents on
// top, then the channels — #general, and one channel per app the viewer is a
// member of. So this returns EVERY such app, including one nobody has
// spoken in yet (a channel with no messages is still a channel you are in),
// which is why `latest` is a LEFT JOIN and why the cap is a directory's
// rather than an inbox pane's. `channel` is the app's `#handle`, the name a
// `#name` reference in a message resolves against (see channelHandles).
//
// ── Why this exists (#2718) ────────────────────────────────────────────
//
// Messages was conversations only: the `conversations` domain, which is
// people talking to people. An app's own discussion — the general thread on
// its board, `chat_messages` with a null `thread_type` — lived nowhere else
// but inside that app, so the only way to know somebody had said something
// about an app you build was to open the app and look.
//
// The navigation change makes Messages the platform's ONE inbox: people,
// app discussions and agent chats in one list, told apart by a pill. That
// is the arrangement every host in the study lands on — Slack and Teams put
// a channel, a DM and a bot thread in one sidebar — and it is why this
// endpoint is a LIST OF DISCUSSIONS rather than a count: an inbox row has to
// say who said what, or it is a link with a badge.
//
// ── Scope, and why membership rather than visibility ───────────────────
//
// Apps the viewer is a MEMBER of, which is narrower than the visibility
// filter GET /api/apps uses. That is deliberate and it is the difference
// between an inbox and a directory: a public app you have never joined is
// something you can go and read, not something that belongs in your
// messages. It is also the same population the app's own board treats as the
// discussion's audience.
//
// Self-hosted rows keep the admin gate every other app read applies, so the
// platform's own discussion does not appear for everybody.
//
// ── One row per app, newest first ──────────────────────────────────────
//
// `DISTINCT ON (app_id) … ORDER BY app_id, created_at DESC, id DESC` is the
// latest message per app in one pass — the `id` tiebreak matters because
// `created_at` defaults to NOW() and two messages in the same transaction
// can share it. The outer order is by that timestamp, so the list arrives in
// the order an inbox wants it and the client does not re-sort.
//
// ── What it deliberately does NOT carry ────────────────────────────────
//
// AN UNREAD COUNT. `chat_messages` has no per-viewer read cursor — nothing
// in the schema records that somebody has seen an app's discussion — so a
// number here would be invented. The row says when the last thing was said
// and who said it, which is what an inbox row needs to be worth a tap, and
// the platform's one badge stays the bell's.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

/**
 * A backstop, not a page size: every app the viewer is a member of is a
 * channel in their list (#2783), and the heaviest real member is in far
 * fewer than this.
 */
const LIMIT = 500;

const DISCUSSIONS_SQL = `
  WITH mine AS (
    SELECT a.id, a.slug, a.name, a.icon_image_id, a.icon_emoji
      FROM apps a
      JOIN app_collaborators me
        ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
     WHERE (NOT a.self_hosted OR $2::boolean)
       AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = $1 AND b.app_id = a.id)
  ),
  latest AS (
    SELECT DISTINCT ON (m.app_id)
           m.app_id, m.content, m.created_at, m.user_id
      FROM chat_messages m
      JOIN mine ON mine.id = m.app_id
     WHERE m.thread_type IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks blocked
          WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = m.user_id
       )
     ORDER BY m.app_id, m.created_at DESC, m.id DESC
  )
  SELECT mine.slug,
         mine.name,
         mine.icon_image_id,
         mine.icon_emoji,
         latest.content    AS last_message,
         latest.created_at AS last_at,
         u.username        AS last_by
    FROM mine
    LEFT JOIN latest ON latest.app_id = mine.id
    LEFT JOIN users u ON u.id = latest.user_id
   ORDER BY latest.created_at DESC NULLS LAST, LOWER(mine.name), mine.slug
   LIMIT ${LIMIT}
`;

/**
 * One database row as the screen reads it.
 *
 * Exported and pure so a test can drive the shape without a database, which
 * is the same split workshop-overview.js makes for its demo overlay. The
 * icon is resolved here rather than in SQL because `/app-icons/<id>` is the
 * platform's own address for it and src/routes/apps.js already spells it that
 * way; two spellings of one URL is how a tile stops loading on one screen.
 */
function toDiscussion(row) {
  return {
    slug: row.slug,
    name: row.name || row.slug,
    channel: channelHandle(row.name) || row.slug,
    iconUrl: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
    iconEmoji: row.icon_emoji || null,
    lastMessage: typeof row.last_message === 'string' ? row.last_message : '',
    lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
    lastBy: row.last_by || null,
  };
}

/**
 * An app's name as a `#handle`: lower case, runs of anything else folded to
 * one hyphen — "Recipe Box!" is `#recipe-box`. Null when nothing is left.
 * The same fold the client uses to match a typed `#name`, so the two cannot
 * disagree about what a reference points at.
 */
function channelHandle(name) {
  const handle = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return /^[a-z]/.test(handle) ? handle : null;
}

/**
 * Make the handles unique within one viewer's list.
 *
 * Two apps can share a name, and `general` is the platform room's. The first
 * app to claim a handle keeps it; a later one — and any app named "General" —
 * falls back to its slug, which is unique by construction.
 */
function channelHandles(discussions) {
  const taken = new Set(['general']);
  return discussions.map((item) => {
    const channel = taken.has(item.channel) ? item.slug.toLowerCase() : item.channel;
    taken.add(channel);
    return { ...item, channel };
  });
}

function messagesOverviewRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/messages/app-discussions', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const { rows } = await pool.query(DISCUSSIONS_SQL, [req.user.id, !!req.user.isAdmin]);
      return res.json({ discussions: channelHandles(rows.map(toDiscussion)) });
    } catch (err) {
      log.error('messages-overview', 'Failed to read app discussions', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  messagesOverviewRoutes, toDiscussion, channelHandle, channelHandles, DISCUSSIONS_SQL, LIMIT,
};
