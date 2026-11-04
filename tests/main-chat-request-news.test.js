'use strict';

// #6207 (3 Nov 2026): Main Chat on the Homeroom bot page holds what you said
// there and the bot's replies to it. A request's news (its activity card,
// plan, questions, building / ready / live lines) is on that request's page,
// so Main's stream, its unread count and its preview leave it out, old and
// new; a first version's news stays, as it has no request page yet. The
// server's test is conversations.js REQUEST_NEWS; the client's copy, for a
// message that arrives live, is bot-request.ts isRequestNews.
//
// The predicate runs against PostgreSQL when one is reachable (as the
// repository's other *-postgres suites do), else that part skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const conversations = require('../src/services/conversations');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

// One row per kind of message the chat with the bot holds.
const ROWS = [
  { id: 1, meta: null, news: false, why: 'something the person wrote' },
  { id: 2, meta: { moment: 'reply', kind: 'chat', issueNumber: 6071 }, news: false, why: 'the bot\'s answer about a request, to what they wrote' },
  { id: 3, meta: { kind: 'activity', appSlug: 'garden', issueNumber: 6149 }, news: true, why: 'a request\'s activity card' },
  { id: 4, meta: { kind: 'plan', appSlug: 'garden', issueNumber: 6149, plan: { bullets: ['x'] } }, news: true, why: 'its plan' },
  { id: 5, meta: { kind: 'question', appSlug: 'garden', issueNumber: 6149 }, news: true, why: 'a question' },
  { id: 6, meta: { kind: 'merged', appSlug: 'garden', issueNumber: 6149 }, news: true, why: 'a live line' },
  { id: 7, meta: { kind: 'plan', appSlug: 'garden', issueNumber: 1, firstVersion: true }, news: false, why: 'a first version\'s plan' },
  { id: 8, meta: { kind: 'filed', appSlug: 'garden', issueNumber: 6071 }, news: false, why: '"Filed as #6071", which a reply started' },
  { id: 9, meta: { kind: 'hello_tour' }, news: false, why: 'a hello' },
];

test('the client and the server agree on what a request\'s news is', () => {
  const src = read('frontend/src/features/messages/bot-request.ts');
  assert.match(src, /export function isRequestNews\(message: ConversationMessage\): boolean \{\s+return isBotNews\(message\) && !message\.metadata\?\.homeroomBot\?\.firstVersion;\s+\}/);
  // The kinds that are conversation are one list, mirrored on both sides.
  const kinds = [...conversations.BOT_CONVERSATION_KINDS];
  const client = /const CONVERSATION_KINDS = new Set\(\[([\s\S]*?)\]\);/.exec(src)[1].match(/'([a-z_]+)'/g).map((k) => k.slice(1, -1));
  assert.deepEqual(client.sort(), kinds.sort());
  // Main draws none of it, live or read.
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /if \(botDm && isRequestNews\(message\)\) continue;/);
  // The stream, the preview and the unread count all leave it out.
  const server = read('src/services/conversations.js');
  assert.match(server, /dc\.kind = 'direct'\)\)\)\)\s+AND NOT \$\{REQUEST_NEWS\}\s+AND NOT \$\{PLUS_THREAD_OPENER\}`;/, 'the main stream');
  assert.equal((server.match(/AND m\.deleted_at IS NULL AND NOT \$\{REQUEST_NEWS\}/g) || []).length, 2, 'the preview and the unread count');
});

test('REQUEST_NEWS, run by PostgreSQL, takes out a request\'s news and nothing else', { timeout: 30000 }, async (t) => {
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
  const values = ROWS.map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::jsonb)`).join(', ');
  const params = ROWS.flatMap((r) => [r.id, r.meta ? JSON.stringify({ homeroomBot: r.meta }) : null]);
  const { rows } = await pool.query(
    `SELECT m.id, ${conversations.REQUEST_NEWS} AS news FROM (VALUES ${values}) AS m(id, metadata) ORDER BY m.id`, params,
  );
  for (const row of ROWS) {
    assert.equal(rows.find((r) => r.id === row.id).news, row.news, row.why);
  }
});
