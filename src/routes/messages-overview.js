'use strict';

// The app discussions the Messages screen lists beside a viewer's people.
//
//   GET /api/messages/app-discussions
//        → { discussions: [{ slug, name, channel, iconUrl, iconEmoji,
//                            lastMessage, lastAt, lastBy,
//                            section, unreadCount }, …] }
//
// ── They are CHANNELS now (#2783) ──────────────────────────────────────
//
// The Messages list is sectioned the way Discord's is: people and agents on
// top, then the channels — #general, and one channel per app. So this
// returns every app in scope, including one nobody has spoken in yet (a
// channel with no messages is still a channel you are in), which is why
// `latest` is a LEFT JOIN and why the cap is a directory's rather than an
// inbox pane's. `channel` is the app's `#handle`, the name a `#name`
// reference in a message resolves against (see channelHandles).
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
// ── Scope: "yours" and "more" (#2967) ──────────────────────────────────
//
// Two sections, and the line between them is Home's, so an app is "yours"
// here exactly when it is in Home's "Your apps" (frontend/src/features/home/
// home.js `isYours`):
//
//   yours  member (app_collaborators status 'member') and not hidden from
//          Your apps (an app_favorites row with hidden = TRUE), OR favorited
//          (an app_favorites row with hidden = FALSE) — a favorited app you
//          are not a member of included.
//   more   every other app the viewer has taken part in: posted or reacted
//          in its chat (any thread), voted on one of its proposals or
//          governance questions, proposed a change to it (a non-headless
//          session that was promoted), or filed a request on it — plus the
//          member apps they hid from Your apps.
//
// Membership alone was #2783's scope; #2967 widens it because an app you
// voted on or asked for something in is a conversation you are in, member
// or not. It is still an inbox and not a directory: an app you have never
// touched does not appear.
//
// ── Visibility ─────────────────────────────────────────────────────────
//
// Nothing here may list an app the viewer cannot open. Every row passes the
// same view rule the app routes apply (services/app-access.js
// checkAppAccess 'view'): a platform admin, a view-public app, or a member.
// A favorite or an old vote on an app that has since gone view-private is
// NOT enough. Self-hosted rows keep the admin gate every other app read
// applies, so the platform's own discussion does not appear for everybody.
//
// ── Order ──────────────────────────────────────────────────────────────
//
// Yours first, then more; inside each, the latest general-stream message
// newest first (a silent channel last), then name. `DISTINCT ON (app_id) …
// ORDER BY app_id, created_at DESC, id DESC` is the latest message per app in
// one pass — the `id` tiebreak matters because `created_at` defaults to
// NOW() and two messages in the same transaction can share it. A deleted
// message is not a preview (#2387): its text is gone.
//
// ── Unread (#2387) ─────────────────────────────────────────────────────
//
// `unreadCount` reads the viewer's app_chat_reads cursor: general-stream
// messages above it from other people, not deleted, not from anybody the
// viewer blocked (services/app-chat.js holds the same definition, and
// tests/app-chat-postgres.test.js pins the two together). An app the viewer
// has no cursor for yet gets one here, at its newest message, so it starts
// at 0 rather than at everything ever said.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appChat = require('../services/app-chat');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

/**
 * A backstop, not a page size: every app the viewer is in is a channel in
 * their list (#2783), and the heaviest real member is in far fewer than this.
 */
const LIMIT = 500;

const DISCUSSIONS_SQL = `
  WITH member AS (
    SELECT me.app_id
      FROM app_collaborators me
     WHERE me.user_id = $1 AND me.status = 'member'
  ),
  activity AS (
    SELECT posted.app_id
      FROM chat_messages posted
     WHERE posted.user_id = $1 AND posted.app_id IS NOT NULL
    UNION
    SELECT reacted.app_id
      FROM message_reactions reaction
      JOIN chat_messages reacted ON reacted.id = reaction.message_id
     WHERE reaction.user_id = $1
    UNION
    SELECT voted.app_id
      FROM pr_votes vote
      JOIN chat_sessions voted ON voted.id = vote.session_id
     WHERE vote.user_id = $1
    UNION
    SELECT decided.app_id
      FROM issue_votes vote
      JOIN issues decided ON decided.id = vote.issue_id
     WHERE vote.user_id = $1
    UNION
    SELECT proposed.app_id
      FROM chat_sessions proposed
     WHERE proposed.user_id = $1 AND proposed.is_headless = FALSE
       AND (proposed.promoted_at IS NOT NULL
            OR proposed.status IN ('promoted', 'merging', 'merged'))
    UNION
    SELECT filed.app_id
      FROM issues filed
     WHERE filed.created_by = $1
  ),
  mine AS (
    SELECT a.id, a.slug, a.name, a.icon_image_id, a.icon_emoji,
           CASE
             WHEN (member.app_id IS NOT NULL AND NOT COALESCE(fav.hidden, FALSE))
               OR (fav.app_id IS NOT NULL AND NOT fav.hidden)
             THEN 'yours'
             ELSE 'more'
           END AS section
      FROM apps a
      LEFT JOIN member ON member.app_id = a.id
      LEFT JOIN app_favorites fav ON fav.app_id = a.id AND fav.user_id = $1
     WHERE (NOT a.self_hosted OR $2::boolean)
       AND ($2::boolean OR a.view_visibility = 'public' OR member.app_id IS NOT NULL)
       AND (member.app_id IS NOT NULL
            OR (fav.app_id IS NOT NULL AND NOT fav.hidden)
            OR a.id IN (SELECT activity.app_id FROM activity))
  ),
  latest AS (
    SELECT DISTINCT ON (m.app_id)
           m.app_id, m.content, m.created_at, m.user_id
      FROM chat_messages m
      JOIN mine ON mine.id = m.app_id
     WHERE m.thread_type IS NULL
       AND m.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks blocked
          WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = m.user_id
       )
     ORDER BY m.app_id, m.created_at DESC, m.id DESC
  ),
  unread AS (
    SELECT m.app_id, COUNT(*)::int AS unread_count
      FROM chat_messages m
      JOIN mine ON mine.id = m.app_id
      JOIN app_chat_reads rc ON rc.app_id = m.app_id AND rc.user_id = $1
     WHERE m.thread_type IS NULL
       AND m.id > rc.last_read_message_id
       AND m.deleted_at IS NULL
       AND m.user_id IS NOT NULL AND m.user_id <> $1
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks blocked
          WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = m.user_id
       )
     GROUP BY m.app_id
  )
  SELECT mine.id            AS app_id,
         mine.slug,
         mine.name,
         mine.icon_image_id,
         mine.icon_emoji,
         mine.section,
         latest.content     AS last_message,
         latest.created_at  AS last_at,
         u.username         AS last_by,
         (rc.app_id IS NOT NULL) AS has_read_cursor,
         COALESCE(unread.unread_count, 0) AS unread_count
    FROM mine
    LEFT JOIN latest ON latest.app_id = mine.id
    LEFT JOIN users u ON u.id = latest.user_id
    LEFT JOIN app_chat_reads rc ON rc.app_id = mine.id AND rc.user_id = $1
    LEFT JOIN unread ON unread.app_id = mine.id
   ORDER BY (mine.section = 'yours') DESC,
            latest.created_at DESC NULLS LAST, LOWER(mine.name), mine.slug
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
    section: row.section === 'more' ? 'more' : 'yours',
    unreadCount: Math.max(0, Number(row.unread_count) || 0),
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
 * Make the handles unique within one viewer's list — both sections of it,
 * since a `#name` in a message resolves against the whole list.
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

/** The SQL's order, for a list the demo overlay has added to. */
function compareDiscussions(a, b) {
  const sa = a.section === 'more' ? 1 : 0;
  const sb = b.section === 'more' ? 1 : 0;
  if (sa !== sb) return sa - sb;
  const ta = a.lastAt ? Date.parse(a.lastAt) : null;
  const tb = b.lastAt ? Date.parse(b.lastAt) : null;
  if (ta !== tb) {
    if (ta == null) return 1;
    if (tb == null) return -1;
    return tb - ta;
  }
  const na = String(a.name || '').toLowerCase();
  const nb = String(b.name || '').toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  return a.slug < b.slug ? -1 : (a.slug > b.slug ? 1 : 0);
}

// ── Staging `?demo=1` (#2387, #2967) ───────────────────────────────────
//
// A declared check renders against a fresh staging database, where the
// tester is a member of one demo app and has favorited another (see
// seedStagingYourApps in src/db/migrate.js), both silent — so neither
// section's new fields had anything to show. Request-time only, a strict
// no-op outside staging, and real data always wins:
//
//   * a SILENT channel previews the mock transcript its chat serves under
//     the same flag (routes/chat.js stagingMockGroupChat) — its newest
//     human line — with DEMO_UNREAD of it unread;
//   * the "more" section gets DEMO_MORE: public apps the same seed creates,
//     so a row opens a real app (with the mock transcript), each with its
//     own unread count. Absent from the database → absent from the list;
//     an app already in the viewer's list keeps its real row.
const DEMO_UNREAD = 2;
const DEMO_MORE = Object.freeze([
  Object.freeze({ slug: 'staging-demo-word-garden', unreadCount: 3 }),
  Object.freeze({ slug: 'staging-demo-pixel-racer', unreadCount: 0 }),
]);

function demoPreview() {
  const { stagingMockGroupChat } = require('./chat');
  const human = stagingMockGroupChat(0, null)
    .filter((m) => m.msg_type === 'message' && !m.deleted);
  const newest = human[human.length - 1];
  return { lastMessage: newest.content, lastAt: newest.created_at, lastBy: newest.username };
}

async function withDemoDiscussions(pool, discussions) {
  const preview = demoPreview();
  const out = discussions.map((d) => (d.lastAt ? d : {
    ...d, ...preview, unreadCount: d.unreadCount || DEMO_UNREAD,
  }));
  const listed = new Set(out.map((d) => d.slug));
  const wanted = DEMO_MORE.filter((d) => !listed.has(d.slug));
  if (wanted.length) {
    const { rows } = await pool.query(
      `SELECT slug, name, icon_image_id, icon_emoji
         FROM apps
        WHERE slug = ANY($1::text[])
          AND view_visibility = 'public' AND NOT self_hosted`,
      [wanted.map((d) => d.slug)]
    );
    for (const row of rows) {
      const demo = wanted.find((d) => d.slug === row.slug);
      out.push({
        ...toDiscussion({ ...row, section: 'more' }),
        ...preview,
        unreadCount: demo.unreadCount,
      });
    }
  }
  return out.sort(compareDiscussions);
}

function messagesOverviewRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/messages/app-discussions', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const { rows } = await pool.query(DISCUSSIONS_SQL, [req.user.id, !!req.user.isAdmin]);
      // #2387: a first look at an app starts its cursor at its newest
      // message, so it reads 0 unread now and counts from here on. Best
      // effort: a failed write leaves the row at 0 and is retried next read.
      const missing = rows.filter((row) => !row.has_read_cursor).map((row) => row.app_id);
      if (missing.length) {
        try {
          await appChat.ensureReadCursors(pool, req.user.id, missing);
        } catch (err) {
          log.warn('messages-overview', 'Read cursor seed failed', { message: err.message });
        }
      }
      let discussions = rows.map(toDiscussion);
      if (IS_STAGING && req.query.demo === '1') {
        discussions = await withDemoDiscussions(pool, discussions);
      }
      return res.json({ discussions: channelHandles(discussions) });
    } catch (err) {
      log.error('messages-overview', 'Failed to read app discussions', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  messagesOverviewRoutes,
  toDiscussion,
  channelHandle,
  channelHandles,
  compareDiscussions,
  withDemoDiscussions,
  DISCUSSIONS_SQL,
  LIMIT,
  DEMO_MORE,
  DEMO_UNREAD,
};
