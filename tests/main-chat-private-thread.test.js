'use strict';

// #6250 (4 Nov 2026): a private thread's ORIGIN decides what Main Chat shows
// of it (Evan, 4 Nov). A thread started from the bot's "+" stays out of Main
// altogether: its opener line and its replies are left out of Main's stream,
// its unread count and its preview, old and new, and the Homeroom bot page's
// list is the only way in. A thread the bot opened from Main, answering what
// the person said there, quotes that message (`reply_to_id`) and stays in
// Main as the way to its row; one opened from a request's page or a captured
// screen has its own kind (`opened_about`, `opened_design`) and stays too.
// The server's tests are conversations.js PLUS_THREAD_OPENER (the line) and
// PLUS_THREAD_REPLY (a reply in such a thread); the client's copies, for a
// message that arrives live, are bot-request.ts isPlusThreadOpener and
// bot-shared.ts alsoInChat (the root's `plusThread`).
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

test('the client and the server agree on which private thread stays out of Main Chat', () => {
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

  // A reply in a plus thread is not a position in Main, though it rings.
  const { alsoInChat, inMainStream } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const plus = { id: 2, senderUsername: 'homeroom_bot', content: 'New thread.', deleted: false, plusThread: true };
  const main = { ...plus, plusThread: undefined };
  const moment = { threadRootId: 2, threadRoot: main, metadata: { homeroomBot: { kind: 'question', alsoInChat: true } } };
  assert.equal(alsoInChat(moment), true, 'a moment in a Main-started thread is Main\'s');
  assert.equal(alsoInChat({ ...moment, threadRoot: plus }), false, 'a moment in a "+" thread stays out');
  assert.equal(inMainStream({ ...moment, threadRoot: plus }), false);

  // Main draws only the "+" thread's opener line out, live or read.
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /if \(botDm && isPlusThreadOpener\(message\)\) continue;/);
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
