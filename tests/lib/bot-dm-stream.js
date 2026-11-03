'use strict';

// #6207 (3 Nov 2026): Main Chat no longer lists a request's news
// (conversations.js REQUEST_NEWS), but the demo fixtures still write it, and
// the suites that pin what a fixture holds read it here: every message of
// the conversation's main stream as it was written (roots, and moments also
// shown in the chat), in the shape listMessages answers, oldest first.
const conversations = require('../../src/services/conversations');

async function dmStream(pool, viewer, conversationId) {
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL
        AND (thread_root_id IS NULL OR (metadata->'homeroomBot'->>'alsoInChat') = 'true')
      ORDER BY id`,
    [conversationId],
  );
  const messages = [];
  for (const row of rows) {
    const message = await conversations.getMessage(pool, viewer, conversationId, Number(row.id));
    if (message) messages.push(message);
  }
  return { messages };
}

module.exports = { dmStream };
