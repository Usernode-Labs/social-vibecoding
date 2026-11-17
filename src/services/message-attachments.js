'use strict';

// Reading a chat message's attachments for the connector (request #6756).
//
// A message row from the transcript route already carries the render summary
// of what is attached to it (`metadata.attachments`, written by services/ws.js).
// The connector needs more than that summary has: the file's real content
// type, the size stored with it, and a picture's own width and height, and
// then a picture's bytes. It must not reach those through a route of its own:
// the transcript route stays the access check, and this module only enriches
// what that route already returned.
//
// It lives here, rather than in services/mcp-tools.js, because that module
// must reach the platform over loopback and never touch the database itself
// (tests/mcp-tools.test.js pins that). The two queries here are the same two
// guards the serve route uses: a message hidden by moderation, or deleted,
// gives up nothing, and an attachment is only ever read as part of the
// message id the caller asked about.

const log = require('./logger');

const ATTACHMENT_ID_RE = /^[a-f0-9]{32}$/;

// Every header the connector can read fits well inside this, and a page of
// screenshots therefore never pulls whole files to list their size.
const HEAD_BYTES = 65536;

// The rows behind one page's summaries: `{ id, kind, content_type, size_bytes,
// head }`, where `head` is the first bytes of a picture and null for every
// other kind. Only `messageIds` the transcript route already returned are
// asked about. Returns null when the table could not be read at all, so the
// caller can keep the route's summary instead of claiming nothing is there.
async function loadFacts(pool, messageIds) {
  const ids = [...new Set((messageIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  if (!pool || typeof pool.query !== 'function' || !ids.length) return null;
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.message_id, a.kind, a.content_type, a.size_bytes,
              CASE WHEN a.kind = 'image' THEN substring(a.data from 1 for ${HEAD_BYTES}) END AS head
         FROM chat_message_attachments a
        WHERE a.message_id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM chat_messages h
                           WHERE h.id = a.message_id
                             AND (h.moderation_hidden_at IS NOT NULL OR h.deleted_at IS NOT NULL))`,
      [ids]
    );
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    log.warn('message-attachments', 'attachment facts query failed', { count: ids.length, err: err.message });
    return null;
  }
}

// One attachment's bytes. `{ data }`, or `{ reason: 'not_found' | 'unavailable' }`.
async function readBytes(pool, { attachmentId, messageId }) {
  if (!pool || typeof pool.query !== 'function') return { reason: 'unavailable' };
  if (!ATTACHMENT_ID_RE.test(String(attachmentId)) || !Number.isInteger(messageId)) {
    return { reason: 'not_found' };
  }
  try {
    const { rows } = await pool.query(
      `SELECT a.data
         FROM chat_message_attachments a
        WHERE a.id = $1 AND a.message_id = $2
          AND NOT EXISTS (SELECT 1 FROM chat_messages h
                           WHERE h.id = a.message_id
                             AND (h.moderation_hidden_at IS NOT NULL OR h.deleted_at IS NOT NULL))`,
      [attachmentId, messageId]
    );
    const data = rows && rows.length ? rows[0].data : null;
    if (!data || !data.length) return { reason: 'not_found' };
    return { data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
  } catch (err) {
    log.warn('message-attachments', 'attachment bytes read failed', { attachmentId, err: err.message });
    return { reason: 'unavailable' };
  }
}

module.exports = {
  ATTACHMENT_ID_RE,
  loadFacts,
  readBytes,
};
