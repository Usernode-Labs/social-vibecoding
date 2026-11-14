'use strict';

// A THREAD STARTED FROM NEW CHAT, AS THE SERVER TELLS IT APART (#6250, 4 Nov
// 2026; renamed from main-chat-private-thread on 14 Nov 2026).
//
// The rule was written for Main Chat: a thread started from the bot's "+"
// stayed out of Main altogether (its opener line and its replies), while one
// the bot opened from Main, from a request's page or from a captured screen
// kept its line there. Main Chat is gone and every conversation with the bot
// is a thread, so no screen draws that stream any more. What is still true,
// and still pinned here:
//
//   - the server's two predicates (conversations.js PLUS_THREAD_OPENER, the
//     line that opens such a thread; PLUS_THREAD_REPLY, a reply in one) still
//     shape the conversation's own stream, its preview and its count, which
//     an older client and the connector still read;
//   - the client's copy of the first (bot-request.ts isPlusThreadOpener)
//     reads a message the same way, for the thread's pane, which does not
//     draw that line (#6668);
//   - the client no longer reads the `alsoInChat` stamp that listed a
//     thread's reply in Main as well: a reply is never a position in a
//     conversation's own stream (bot-shared.ts inMainStream).
//
// The predicates run against PostgreSQL when one is reachable (as the
// repository's other *-postgres suites do), else that part skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const conversations = require('../src/services/conversations');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

// One row per message the chat with the bot holds. `reply` is the id of the
// message quoted above it, and `root` the thread it replies in.
const ROWS = [
  { id: 1, meta: null, reply: null, root: null, opener: false, plusReply: false, why: 'something the person wrote' },
  { id: 2, meta: { kind: 'opened_thread', changeKind: 'any' }, reply: null, root: null, opener: true, plusReply: false, why: 'a thread from the bot\'s "+"' },
  { id: 3, meta: { kind: 'opened_thread', changeKind: 'project' }, reply: 1, root: null, opener: false, plusReply: false, why: 'a thread the bot opened from Main, quoting what was said there' },
  { id: 4, meta: { kind: 'opened_about', aboutKind: 'request', aboutNumber: 18 }, reply: null, root: null, opener: false, plusReply: false, why: 'a thread about a request, opened from its page' },
  { id: 5, meta: { kind: 'opened_draft', draft: 'request' }, reply: 1, root: null, opener: false, plusReply: false, why: 'a draft the bot opened from Main' },
  { id: 6, meta: { kind: 'opened_design', designTitle: 'A screen' }, reply: null, root: null, opener: false, plusReply: false, why: 'a design thread from a captured screen' },
  { id: 7, meta: { kind: 'chat', moment: 'reply' }, reply: null, root: null, opener: false, plusReply: false, why: 'the bot\'s answer in Main' },
  { id: 8, meta: { kind: 'opened' }, reply: null, root: null, opener: false, plusReply: false, why: 'a kind with no trailing underscore' },
  { id: 9, meta: { kind: 'openedx_thread' }, reply: null, root: null, opener: false, plusReply: false, why: 'a kind that only starts with `opened`' },
  { id: 10, meta: { kind: 'activity', appSlug: 'garden', issueNumber: 6149 }, reply: null, root: null, opener: false, plusReply: false, why: 'a request\'s card, which opens its own thread' },
  { id: 11, meta: { kind: 'question', alsoInChat: true }, reply: null, root: 2, opener: false, plusReply: true, why: 'a ringing reply in a thread from the "+"' },
  { id: 12, meta: { kind: 'question', alsoInChat: true }, reply: null, root: 3, opener: false, plusReply: false, why: 'a ringing reply in a thread the bot opened from Main' },
];

test('the client and the server agree on which thread was started from New chat', () => {
  const { isPlusThreadOpener } = loadTsx('frontend/src/features/messages/bot-request.ts');
  const BOT = { id: 2, username: 'homeroom_bot', bot: true };
  const quote = { id: 9, sender: { id: 7, username: 'ada' }, content: '', deleted: false };
  const said = (meta, reply = null) => ({
    id: 1, conversationId: 1, sender: BOT, content: '', createdAt: '', reply,
    reactions: [], attachments: [], objects: [], metadata: meta ? { homeroomBot: meta } : null,
  });
  assert.equal(isPlusThreadOpener(said({ kind: 'opened_thread', changeKind: 'any' })), true, 'the bot\'s "+"');
  assert.equal(isPlusThreadOpener(said({ kind: 'opened_thread', changeKind: 'project' }, quote)), false,
    'opened from Main, it quotes what was said, and stays');
  assert.equal(isPlusThreadOpener(said({ kind: 'opened_about', aboutKind: 'request', aboutNumber: 18 })), false,
    'a thread from a request\'s page stays');
  assert.equal(isPlusThreadOpener(said({ kind: 'opened_draft', draft: 'request' }, quote)), false);
  assert.equal(isPlusThreadOpener(said({ kind: 'opened_design', designTitle: 'A screen' })), false);
  assert.equal(isPlusThreadOpener(said(null)), false);
  assert.equal(isPlusThreadOpener({ ...said({ kind: 'opened_thread' }), sender: { id: 7, username: 'ada' } }), false,
    'never a person\'s line');

  // A reply is never a position in the conversation's own stream, whatever
  // its thread started from and whatever stamp an old message carries.
  const shared = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const plus = { id: 2, senderUsername: 'homeroom_bot', content: 'New thread.', deleted: false, plusThread: true };
  const main = { ...plus, plusThread: undefined };
  const stamped = { threadRootId: 2, threadRoot: main, metadata: { homeroomBot: { kind: 'question', alsoInChat: true } } };
  assert.equal(shared.inMainStream(stamped), false);
  assert.equal(shared.inMainStream({ ...stamped, threadRoot: plus }), false);
  assert.equal(shared.inMainStream({ threadRootId: null }), true);
  assert.equal(shared.alsoInChat, undefined, 'the stamp has no reader');

  // #6668: the thread pane skips that line, so a "+" thread opens on what
  // the person wrote instead of on the bot's "New thread.". Nothing draws
  // the bot chat's own stream, so nothing else on the client asks.
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /\{root && !\(botChat && isPlusThreadOpener\(root\)\) \? <MessageRow /);
  assert.equal((index.match(/isPlusThreadOpener\(/g) || []).length, 1);
  // The stream, the preview and the unread count all leave the plus thread out.
  const server = read('src/services/conversations.js');
  assert.match(server, /const PLUS_THREAD_OPENER = `COALESCE\(m\.metadata->'homeroomBot'->>'kind' = 'opened_thread'\s+AND m\.reply_to_id IS NULL, FALSE\)`;/);
  assert.match(server, /const PLUS_THREAD_REPLY = `EXISTS \(SELECT 1 FROM conversation_messages plus_root\s+WHERE plus_root\.id = m\.thread_root_id\s+AND plus_root\.metadata->'homeroomBot'->>'kind' = 'opened_thread'\s+AND plus_root\.reply_to_id IS NULL\)`;/);
  assert.equal((server.match(/AND NOT \$\{PLUS_THREAD_OPENER\}/g) || []).length, 3, 'the main stream, the preview and the unread count');
  assert.equal((server.match(/ALSO_IN_CHAT\} AND NOT \$\{PLUS_THREAD_REPLY\}/g) || []).length, 3, 'the same three leave its replies out');
  assert.match(server, /AND NOT \$\{PLUS_THREAD_OPENER\}`;/, 'the main stream ends with it');
});

test('the predicates, run by PostgreSQL, take out a "+" thread and nothing else', { timeout: 30000 }, async (t) => {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return; }
  const pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  pool.on('error', () => {});
  t.after(() => pool.end().catch(() => {}));
  try { await pool.query('SELECT 1'); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return;
  }
  const values = ROWS.map((_, i) => `($${i * 4 + 1}::int, $${i * 4 + 2}::jsonb, $${i * 4 + 3}::int, $${i * 4 + 4}::int)`).join(', ');
  const params = ROWS.flatMap((r) => [r.id, r.meta ? JSON.stringify({ homeroomBot: r.meta }) : null, r.reply, r.root]);
  // The CTE stands in for the table the reply test looks its root up in.
  const { rows } = await pool.query(
    `WITH conversation_messages (id, metadata, reply_to_id, thread_root_id) AS (VALUES ${values})
     SELECT m.id, ${conversations.PLUS_THREAD_OPENER} AS opener, ${conversations.PLUS_THREAD_REPLY} AS plus_reply
       FROM conversation_messages m ORDER BY m.id`, params,
  );
  for (const row of ROWS) {
    const found = rows.find((r) => r.id === row.id);
    assert.equal(found.opener, row.opener, row.why);
    assert.equal(found.plus_reply, row.plusReply, row.why);
  }
});
