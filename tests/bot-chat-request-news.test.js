'use strict';

// WHAT A REQUEST'S NEWS IS (#6207, 3 Nov 2026; renamed from
// main-chat-request-news on 14 Nov 2026).
//
// A request's news from Homeroom bot (its activity card, plan, questions,
// building / ready / live lines) is on that request's page. The rule was
// written to keep it out of Main Chat's stream, unread count and preview; a
// first version's news stayed, having no request page. Main Chat is gone,
// and the same test (conversations.js REQUEST_NEWS) now decides what that
// removal leaves alone: old news in the chat that belongs to no thread is
// not moved under Earlier chat (earlier-chat.js), is not found by the bot
// page's search as a message of the chat (ai-search.js), and is still left
// out of the conversation's own stream, count and preview. The client kept
// a copy of the test for a message arriving live in that stream; it draws
// the stream on no screen now, and the copy is gone.
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

test('the server leaves a request\'s news out of the stream, the preview and the count; the client keeps no copy of the test', () => {
  // The client drew the bot chat's own stream once, and mirrored the test
  // for a message arriving live. It draws that stream nowhere now.
  const src = read('frontend/src/features/messages/bot-request.ts');
  assert.doesNotMatch(src, /isRequestNews|isBotNews|CONVERSATION_KINDS/);
  assert.doesNotMatch(read('frontend/src/features/messages/index.tsx'), /isRequestNews|isBotNews/);
  assert.ok(conversations.BOT_CONVERSATION_KINDS.has('filed') && !conversations.BOT_CONVERSATION_KINDS.has('activity'));
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
