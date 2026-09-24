'use strict';

// App channels (#2387): the conversation mechanics an app's group chat
// (`chat_messages`) shares between its three doors — the REST routes
// (routes/chat.js), the per-app socket (services/ws.js) and the Messages
// list (routes/messages-overview.js).
//
// ── Soft delete ────────────────────────────────────────────────────────
//
// An author takes back one of their own ordinary messages. The row stays —
// a transcript with a hole where a message was is harder to read than one
// that says "deleted", and a reply thread under it keeps its root — but
// everything it carried goes in ONE transaction: the text (cleared on the
// row, not merely hidden on read), its attachments' bytes, its reactions,
// everybody's bookmarks of it and every notification pointing at it. The
// REST DELETE and the socket's `{ type: 'delete' }` both reach this through
// ws.handleMessage, so there is one implementation of what "deleted" means.
//
// ── Reply threads ──────────────────────────────────────────────────────
//
// #194's thread scoping, one more type: thread_type 'message', thread_ref =
// the root's chat_messages.id. A root is a general-stream row of the same app
// (thread_type IS NULL) that a person wrote — an ordinary message or a shared
// spec card — which is also what makes nesting impossible: a reply has a
// thread_type, so it can never be a root. A reply never appears in the
// general stream for the same reason every topic thread's messages don't.
//
// ── The read cursor ────────────────────────────────────────────────────
//
// app_chat_reads is a per-person watermark over one app's general stream
// (see schema.sql). "Unread" is defined once, here and in the Messages list's
// SQL, and the two are pinned together by tests/app-chat-postgres.test.js:
// general stream, id above the cursor, written by another PERSON (system
// lines have no author and would bury the count under vote and conflict
// notices), not deleted, not by somebody the reader blocked.

const MESSAGE_THREAD = 'message';
const THREAD_ROOT_MSG_TYPES = Object.freeze(['message', 'spec_share']);
const MAX_PARTICIPANTS = 3;
// A thread's summary is recomputed per viewer who blocked one of its
// repliers. Bounded so a pathological thread cannot turn one reply into an
// unbounded fan of queries; beyond it those viewers get no summary frame and
// pick the count up on their next history load.
const MAX_SUMMARY_VARIANTS = 50;

function positiveInt(value) {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Deleted rows as a reader sees them ────────────────────────────────

// Metadata a deleted row may still carry. The quote and the attachment
// summary are content; anything else (none today on a 'message' row) is
// structural and survives.
function strippedMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const { attachments: _a, quote: _q, ...rest } = metadata;
  return rest;
}

// Shape one transcript row for the wire. `deleted_at` is read so the flag can
// be derived, and not sent: the client needs "is it deleted", not when.
function shapeRow(row) {
  const { deleted_at: deletedAt, ...rest } = row;
  const out = {
    ...rest,
    username: rest.username
      || (rest.msg_type === 'message' && rest.user_id == null ? 'Deleted user' : rest.username),
    deleted: !!deletedAt,
  };
  if (out.deleted) {
    out.content = '';
    out.metadata = strippedMetadata(out.metadata);
    out.edited_at = null;
  }
  return out;
}

// ── Reply threads ─────────────────────────────────────────────────────

/**
 * The root a reply thread hangs off, or null. `viewerId` hides a root whose
 * author the viewer blocked (they cannot see it in the general stream
 * either); pass null to skip that check.
 */
async function findThreadRoot(db, appId, rootId, viewerId = null) {
  const id = positiveInt(rootId);
  if (!id || !appId) return null;
  const { rows } = await db.query(
    `SELECT root.id, root.user_id, u.username, root.content, root.msg_type, root.metadata,
            root.thread_type, root.thread_ref, root.created_at, root.edited_at,
            root.posted_via, root.deleted_at
       FROM chat_messages root
       LEFT JOIN users u ON u.id = root.user_id
      WHERE root.id = $1 AND root.app_id = $2
        AND root.thread_type IS NULL
        AND root.msg_type IN ('message', 'spec_share')
        AND ($3::int IS NULL OR NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = root.user_id
        ))`,
    [id, appId, viewerId == null ? null : Number(viewerId)]
  );
  return rows[0] || null;
}

function shapeSummary(row) {
  const participants = Array.isArray(row.participants) ? row.participants : [];
  return {
    reply_count: Number(row.reply_count) || 0,
    last_reply_at: iso(row.last_reply_at),
    participants: participants
      .filter((p) => p && p.id != null)
      .slice(0, MAX_PARTICIPANTS)
      .map((p) => ({ id: Number(p.id), username: p.username || null })),
  };
}

/**
 * Thread summaries for a page of roots: Map<rootId, { reply_count,
 * last_reply_at, participants: [{ id, username }] }>. A root with no visible
 * reply is absent (the caller renders `thread: null`).
 *
 * Visible = not deleted, and — when `viewerId` is given — not written by
 * somebody that viewer blocked. `participants` is the up-to-three most recent
 * distinct repliers, newest first.
 */
async function threadSummaries(db, appId, rootIds, viewerId = null) {
  const ids = [...new Set((rootIds || []).map(positiveInt).filter(Boolean))];
  const out = new Map();
  if (!ids.length || !appId) return out;
  const { rows } = await db.query(
    `WITH replies AS (
       SELECT reply.thread_ref AS root_id, reply.id, reply.user_id, reply.created_at
         FROM chat_messages reply
        WHERE reply.app_id = $1
          AND reply.thread_type = 'message'
          AND reply.thread_ref = ANY($2::int[])
          AND reply.deleted_at IS NULL
          AND ($3::int IS NULL OR NOT EXISTS (
            SELECT 1 FROM user_blocks blocked
             WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = reply.user_id
          ))
     ),
     totals AS (
       SELECT root_id, COUNT(*)::int AS reply_count, MAX(created_at) AS last_reply_at
         FROM replies
        GROUP BY root_id
     ),
     repliers AS (
       SELECT root_id, user_id, MAX(id) AS last_id
         FROM replies
        WHERE user_id IS NOT NULL
        GROUP BY root_id, user_id
     ),
     ranked AS (
       SELECT root_id, user_id,
              ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY last_id DESC) AS recency
         FROM repliers
     )
     SELECT totals.root_id, totals.reply_count, totals.last_reply_at,
            COALESCE(
              json_agg(json_build_object('id', u.id, 'username', u.username)
                       ORDER BY ranked.recency)
                FILTER (WHERE u.id IS NOT NULL),
              '[]'::json
            ) AS participants
       FROM totals
       LEFT JOIN ranked ON ranked.root_id = totals.root_id AND ranked.recency <= 3
       LEFT JOIN users u ON u.id = ranked.user_id
      GROUP BY totals.root_id, totals.reply_count, totals.last_reply_at`,
    [appId, ids, viewerId == null ? null : Number(viewerId)]
  );
  for (const row of rows) {
    if (Number(row.reply_count) > 0) out.set(Number(row.root_id), shapeSummary(row));
  }
  return out;
}

/**
 * What the room hears about one thread after it changes: the summary as
 * everybody sees it, plus a per-viewer variant for each viewer who blocked
 * one of its repliers (their count and faces must not include that person).
 * `thread` null means no visible reply is left. `withheldFrom` are the
 * blockers past MAX_SUMMARY_VARIANTS: they get NO frame, never the base one,
 * which names the person they blocked.
 */
async function threadSummaryForRoom(db, appId, rootId) {
  const id = positiveInt(rootId);
  if (!id) return { thread: null, byViewer: {}, withheldFrom: [] };
  const base = await threadSummaries(db, appId, [id], null);
  const { rows } = await db.query(
    `SELECT DISTINCT blocked.blocker_id
       FROM chat_messages reply
       JOIN user_blocks blocked ON blocked.blocked_user_id = reply.user_id
      WHERE reply.app_id = $1 AND reply.thread_type = 'message'
        AND reply.thread_ref = $2 AND reply.deleted_at IS NULL
      ORDER BY blocked.blocker_id`,
    [appId, id]
  );
  const byViewer = {};
  const withheldFrom = [];
  for (const { blocker_id: viewerId } of rows) {
    if (Object.keys(byViewer).length >= MAX_SUMMARY_VARIANTS) { withheldFrom.push(viewerId); continue; }
    const mine = await threadSummaries(db, appId, [id], viewerId);
    byViewer[viewerId] = mine.get(id) || null;
  }
  return { thread: base.get(id) || null, byViewer, withheldFrom };
}

// ── Soft delete ───────────────────────────────────────────────────────

/**
 * Delete one of the caller's own messages. Returns
 *   { ok: true, alreadyDeleted, message: { id, thread_type, thread_ref,
 *     deleted_at }, clearedUserIds }
 * or { ok: false, code } with code 'not_found' | 'not_author'.
 *
 * Idempotent: deleting an already-deleted message of yours succeeds with
 * alreadyDeleted = true and changes nothing. Only ordinary 'message' rows
 * qualify — a system line, a vote notice or a spec card is not something
 * one person wrote and can take back. `clearedUserIds` are the people whose
 * notification rows went with it, so the caller can re-sync their bells.
 */
async function deleteOwnMessage(pool, { appId, userId, messageId }) {
  const id = positiveInt(messageId);
  if (!id || !appId || !userId) return { ok: false, code: 'not_found' };
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    // FOR UPDATE: serialises against an edit, a reaction or a report
    // (routes/content-reports.js takes FOR SHARE) racing the delete.
    const { rows } = await cx.query(
      `SELECT id, user_id, msg_type, thread_type, thread_ref, deleted_at
         FROM chat_messages
        WHERE id = $1 AND app_id = $2
        FOR UPDATE`,
      [id, appId]
    );
    const row = rows[0];
    if (!row) {
      await cx.query('ROLLBACK');
      return { ok: false, code: 'not_found' };
    }
    if (Number(row.user_id) !== Number(userId) || row.msg_type !== 'message') {
      await cx.query('ROLLBACK');
      return { ok: false, code: 'not_author' };
    }
    const message = {
      id: row.id,
      thread_type: row.thread_type || null,
      thread_ref: row.thread_ref ?? null,
      deleted_at: row.deleted_at || null,
    };
    if (row.deleted_at) {
      await cx.query('ROLLBACK');
      return { ok: true, alreadyDeleted: true, message, clearedUserIds: [] };
    }
    const { rows: updated } = await cx.query(
      `UPDATE chat_messages
          SET deleted_at = NOW(), content = '', edited_at = NULL,
              metadata = metadata - 'attachments' - 'quote'
        WHERE id = $1
        RETURNING deleted_at`,
      [id]
    );
    await cx.query('DELETE FROM chat_message_attachments WHERE message_id = $1', [id]);
    await cx.query('DELETE FROM message_reactions WHERE message_id = $1', [id]);
    await cx.query('DELETE FROM message_bookmarks WHERE message_id = $1', [id]);
    const { rows: cleared } = await cx.query(
      'DELETE FROM notifications WHERE chat_message_id = $1 RETURNING user_id',
      [id]
    );
    await cx.query('COMMIT');
    message.deleted_at = updated[0]?.deleted_at || null;
    return {
      ok: true,
      alreadyDeleted: false,
      message,
      clearedUserIds: [...new Set(cleared.map((r) => Number(r.user_id)))],
    };
  } catch (err) {
    try { await cx.query('ROLLBACK'); } catch { /* connection gone */ }
    throw err;
  } finally {
    cx.release();
  }
}

// ── The read cursor ───────────────────────────────────────────────────

async function unreadCount(db, appId, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS unread_count
       FROM chat_messages m
       JOIN app_chat_reads rc ON rc.app_id = m.app_id AND rc.user_id = $2
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.id > rc.last_read_message_id
        AND m.deleted_at IS NULL
        AND m.user_id IS NOT NULL AND m.user_id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.user_id
        )`,
    [appId, userId]
  );
  return rows[0]?.unread_count || 0;
}

/**
 * Move the cursor forward to `messageId`, never back. The message must be in
 * this app's general stream — a thread reply or another app's id would move a
 * watermark it does not belong to. Returns { ok, unread_count } or
 * { ok: false, code: 'not_found' }.
 */
async function markRead(db, { appId, userId, messageId }) {
  const id = positiveInt(messageId);
  if (!id) return { ok: false, code: 'not_found' };
  const { rows } = await db.query(
    `INSERT INTO app_chat_reads (app_id, user_id, last_read_message_id)
     SELECT $1, $2, target.id
       FROM chat_messages target
      WHERE target.id = $3 AND target.app_id = $1 AND target.thread_type IS NULL
     ON CONFLICT (app_id, user_id) DO UPDATE
       SET last_read_message_id = GREATEST(app_chat_reads.last_read_message_id,
                                           EXCLUDED.last_read_message_id),
           updated_at = NOW()
     RETURNING last_read_message_id`,
    [appId, userId, id]
  );
  if (!rows.length) return { ok: false, code: 'not_found' };
  return { ok: true, unread_count: await unreadCount(db, appId, userId) };
}

/**
 * Mark `messageId` and everything after it unread: the cursor moves back to
 * just before it. Back only — a message already unread stays so, and nothing
 * earlier is marked read as a side effect.
 */
async function markUnread(db, { appId, userId, messageId }) {
  const id = positiveInt(messageId);
  if (!id) return { ok: false, code: 'not_found' };
  const { rows } = await db.query(
    `INSERT INTO app_chat_reads (app_id, user_id, last_read_message_id)
     SELECT $1, $2, target.id - 1
       FROM chat_messages target
      WHERE target.id = $3 AND target.app_id = $1 AND target.thread_type IS NULL
     ON CONFLICT (app_id, user_id) DO UPDATE
       SET last_read_message_id = LEAST(app_chat_reads.last_read_message_id,
                                        EXCLUDED.last_read_message_id),
           updated_at = NOW()
     RETURNING last_read_message_id`,
    [appId, userId, id]
  );
  if (!rows.length) return { ok: false, code: 'not_found' };
  return { ok: true, unread_count: await unreadCount(db, appId, userId) };
}

/** A person posted `messageId` in the general stream: they have read to it. */
async function advanceReadCursor(db, appId, userId, messageId) {
  const id = positiveInt(messageId);
  if (!id || !appId || !userId) return;
  await db.query(
    `INSERT INTO app_chat_reads (app_id, user_id, last_read_message_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_id, user_id) DO UPDATE
       SET last_read_message_id = GREATEST(app_chat_reads.last_read_message_id,
                                           EXCLUDED.last_read_message_id),
           updated_at = NOW()`,
    [appId, userId, id]
  );
}

/**
 * Create the missing cursors for `appIds` at each app's newest general-stream
 * id — so an app the reader has never had a cursor for starts at zero unread
 * rather than at everything ever said. Existing cursors are untouched.
 */
async function ensureReadCursors(db, userId, appIds) {
  const ids = [...new Set((appIds || []).map(positiveInt).filter(Boolean))];
  if (!ids.length || !userId) return;
  await db.query(
    `INSERT INTO app_chat_reads (app_id, user_id, last_read_message_id)
     SELECT pending.app_id, $1,
            COALESCE((SELECT MAX(m.id) FROM chat_messages m
                       WHERE m.app_id = pending.app_id AND m.thread_type IS NULL), 0)
       FROM UNNEST($2::int[]) AS pending(app_id)
     ON CONFLICT (app_id, user_id) DO NOTHING`,
    [userId, ids]
  );
}

module.exports = {
  MESSAGE_THREAD,
  THREAD_ROOT_MSG_TYPES,
  MAX_PARTICIPANTS,
  positiveInt,
  strippedMetadata,
  shapeRow,
  findThreadRoot,
  threadSummaries,
  threadSummaryForRoom,
  deleteOwnMessage,
  unreadCount,
  markRead,
  markUnread,
  advanceReadCursor,
  ensureReadCursors,
};
