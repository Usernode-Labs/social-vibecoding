'use strict';

// A PUBLIC PROJECT'S DISCUSSION, READ BY A VISITOR (26 Nov 2026).
//
// The signed-out project page draws the project's Discussion read-only
// (frontend/src/features/guest/guest-discussion.tsx): its #general messages
// as posts, each with its newest replies, what they carry, and how many
// reacted. Only what anybody could read on a public project, and nothing
// about the reader: no read position, no "your reaction", no names of who
// reacted. The routes (routes/public-api.js) gate the project
// (isPublicDirectoryApp: public, listed, not suspended, not the platform's
// own); every query here scopes to that one app's #general (its main stream
// and the reply threads under it), never a topic's channel or a change's
// thread, and leaves out what moderation hid.

/** Posts in one page, newest last. */
const POSTS_PER_PAGE = 30;
/** The newest replies sent with each post. */
const REPLIES_PER_POST = 3;
/** The most replies one thread read sends. */
const THREAD_MAX = 200;

const POST_KINDS = "('message', 'spec_share')";

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * What of a row's metadata a visitor may see: its files (named, sized, by
 * id) and a shared plan's title and change number. Nothing else rides along
 * (a reply's quote, a bot's working notes, a client key).
 */
function publicMetadata(metadata) {
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  const out = {};
  if (Array.isArray(m.attachments)) {
    out.attachments = m.attachments
      .filter((a) => a && /^[0-9a-f]{32}$/.test(String(a.id || '')))
      .map((a) => ({
        id: String(a.id),
        kind: String(a.kind || 'binary'),
        filename: String(a.filename || ''),
        sizeBytes: Number(a.sizeBytes) || 0,
      }));
  }
  if (m.specShare && typeof m.specShare === 'object') {
    out.specShare = {
      title: String(m.specShare.title || ''),
      prNumber: Number(m.specShare.prNumber) || null,
    };
  }
  return out;
}

function shapeRow(row, reactions, thread) {
  const deleted = !!row.deleted;
  return {
    id: Number(row.id),
    user_id: row.user_id == null ? null : Number(row.user_id),
    username: row.username || null,
    content: deleted ? '' : String(row.content || ''),
    msg_type: row.msg_type,
    metadata: deleted ? {} : publicMetadata(row.metadata),
    thread_type: row.thread_type || null,
    thread_ref: row.thread_ref == null ? null : Number(row.thread_ref),
    created_at: iso(row.created_at),
    deleted,
    reactions: reactions.get(Number(row.id)) || [],
    thread: thread || null,
  };
}

const ROW_COLUMNS = `m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata,
  m.thread_type, m.thread_ref, m.created_at, (m.deleted_at IS NOT NULL) AS deleted`;

async function reactionsFor(pool, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await pool.query(
    `SELECT mr.message_id, mr.emoji, COUNT(*)::int AS count
       FROM message_reactions mr
      WHERE mr.message_id = ANY($1::int[])
      GROUP BY mr.message_id, mr.emoji
      ORDER BY mr.message_id, MIN(mr.created_at)`,
    [ids]
  );
  for (const r of rows) {
    const id = Number(r.message_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({ emoji: r.emoji, count: Number(r.count) || 0 });
  }
  return map;
}

/**
 * One page of posts, newest last, before `before` (the newest page without
 * it): each with its reply count and newest replies, which ride in the same
 * list as the chat's own stream carries them.
 */
async function publicPosts(pool, appId, { before = null } = {}) {
  const cursor = Number.isSafeInteger(Number(before)) && Number(before) > 0 ? Number(before) : null;
  const { rows: posts } = await pool.query(
    `SELECT ${ROW_COLUMNS}
       FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.msg_type IN ${POST_KINDS}
        AND m.moderation_hidden_at IS NULL
        AND ($2::int IS NULL OR m.id < $2)
      ORDER BY m.id DESC
      LIMIT $3`,
    [appId, cursor, POSTS_PER_PAGE + 1]
  );
  const more = posts.length > POSTS_PER_PAGE;
  const page = posts.slice(0, POSTS_PER_PAGE).reverse();
  const ids = page.map((p) => Number(p.id));
  const threads = new Map();
  let replies = [];
  if (ids.length) {
    const { rows: counts } = await pool.query(
      `SELECT thread_ref AS root_id, COUNT(*)::int AS n, MAX(created_at) AS last_at
         FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'message' AND thread_ref = ANY($2::int[])
          AND deleted_at IS NULL AND moderation_hidden_at IS NULL
        GROUP BY thread_ref`,
      [appId, ids]
    );
    for (const c of counts) threads.set(Number(c.root_id), { reply_count: Number(c.n) || 0, last_reply_at: iso(c.last_at) });
    ({ rows: replies } = await pool.query(
      `SELECT * FROM (
         SELECT ${ROW_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY m.thread_ref ORDER BY m.id DESC) AS rn
           FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
          WHERE m.app_id = $1 AND m.thread_type = 'message' AND m.thread_ref = ANY($2::int[])
            AND m.msg_type = 'message' AND m.deleted_at IS NULL AND m.moderation_hidden_at IS NULL
       ) x WHERE x.rn <= $3
       ORDER BY x.id`,
      [appId, ids, REPLIES_PER_POST]
    ));
  }
  const reactions = await reactionsFor(pool, [...ids, ...replies.map((r) => Number(r.id))]);
  return {
    messages: [
      ...page.map((p) => shapeRow(p, reactions, threads.get(Number(p.id)))),
      ...replies.map((r) => shapeRow(r, reactions, null)),
    ],
    has_more_before: more,
  };
}

/** One post and its replies, oldest first, or null when the post is not one of this #general's. */
async function publicThread(pool, appId, rootId) {
  const id = Number(rootId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows: roots } = await pool.query(
    `SELECT ${ROW_COLUMNS}
       FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = $1 AND m.app_id = $2 AND m.thread_type IS NULL
        AND m.msg_type IN ${POST_KINDS} AND m.moderation_hidden_at IS NULL`,
    [id, appId]
  );
  if (!roots[0]) return null;
  const { rows: replies } = await pool.query(
    `SELECT * FROM (
       SELECT ${ROW_COLUMNS}
         FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.app_id = $1 AND m.thread_type = 'message' AND m.thread_ref = $2
          AND m.msg_type = 'message' AND m.deleted_at IS NULL AND m.moderation_hidden_at IS NULL
        ORDER BY m.id DESC
        LIMIT $3
     ) x ORDER BY x.id`,
    [appId, id, THREAD_MAX]
  );
  const reactions = await reactionsFor(pool, [id, ...replies.map((r) => Number(r.id))]);
  return {
    root: shapeRow(roots[0], reactions, { reply_count: replies.length, last_reply_at: replies.length ? iso(replies[replies.length - 1].created_at) : null }),
    messages: replies.map((r) => shapeRow(r, reactions, null)),
  };
}

/**
 * A file on one of this #general's live messages (a post, or a reply under
 * one), for a visitor: its bytes and how to send them, or null. A file on a
 * topic's message, a change's thread, a deleted or hidden message, or one
 * not yet sent is not this route's.
 */
async function publicAttachment(pool, appId, attId) {
  const id = String(attId || '');
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT a.kind, a.filename, a.content_type, a.data
       FROM chat_message_attachments a
       JOIN chat_messages m ON m.id = a.message_id
      WHERE a.id = $1 AND a.app_id = $2 AND m.app_id = $2
        AND m.deleted_at IS NULL AND m.moderation_hidden_at IS NULL
        AND (
          m.thread_type IS NULL
          OR (m.thread_type = 'message' AND EXISTS (
            SELECT 1 FROM chat_messages root
             WHERE root.id = m.thread_ref AND root.app_id = $2 AND root.thread_type IS NULL
          ))
        )`,
    [id, appId]
  );
  return rows[0] || null;
}

module.exports = {
  POSTS_PER_PAGE,
  REPLIES_PER_POST,
  THREAD_MAX,
  publicAttachment,
  publicMetadata,
  publicPosts,
  publicThread,
};
