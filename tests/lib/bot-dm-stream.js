'use strict';

// #6207 (3 Nov 2026): Main Chat no longer lists a request's news
// (conversations.js REQUEST_NEWS), but the demo fixtures still write it, and
// the suites that pin what a fixture holds read it here, in the shape
// listMessages answers, oldest first.
//
// 14 Nov 2026: Main Chat is gone, and what a fixture used to say there is
// in threads: the first messages (a hello, a thread's opener, a request's
// card from before), the moments an older message marked as shown in the
// chat too, and what is said in Earlier chat and in a first version's
// thread, which hold what Main held. The replies in a "+" thread and under
// a request's card stay out, as they always were: their own suites read
// them.
const conversations = require('../../src/services/conversations');

async function dmStream(pool, viewer, conversationId) {
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL
        AND (thread_root_id IS NULL OR (metadata->'homeroomBot'->>'alsoInChat') = 'true'
             OR EXISTS (SELECT 1 FROM private_threads p
                         WHERE p.root_message_id = conversation_messages.thread_root_id
                           AND p.kind IN ('earlier', 'first_version')))
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
