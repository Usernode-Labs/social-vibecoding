'use strict';

// #6250 (4 Nov 2026): a private thread with Homeroom bot is kept in the page's
// list, and its opener line is never Main Chat. Main holds what the person
// said there and the bot's replies to it; the bot's line that opens a thread
// (metadata kind `opened_thread`, `opened_about`, `opened_draft` or
// `opened_design`) is the thread's own first line, so Main's stream, its
// unread count and its preview leave it out, old and new. The server's test is
// conversations.js PRIVATE_THREAD_OPENER; the client's copy, for a message
// that arrives live, is bot-request.ts isPrivateThreadOpener.
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
  { id: 1, meta: null, opener: false, why: 'something the person wrote' },
  { id: 2, meta: { kind: 'opened_thread', changeKind: 'any' }, opener: true, why: 'a thread from the bot\'s "+"' },
  { id: 3, meta: { kind: 'opened_about', aboutKind: 'request', aboutNumber: 18 }, opener: true, why: 'a thread about a request' },
  { id: 4, meta: { kind: 'opened_draft', draft: 'request' }, opener: true, why: 'a draft the bot opened' },
  { id: 5, meta: { kind: 'opened_design', designTitle: 'A screen' }, opener: true, why: 'a design thread' },
  { id: 6, meta: { kind: 'chat', moment: 'reply' }, opener: false, why: 'the bot\'s answer in Main' },
  { id: 7, meta: { kind: 'opened' }, opener: false, why: 'a kind with no trailing underscore' },
  { id: 8, meta: { kind: 'openedx_thread' }, opener: false, why: 'a kind that only starts with `opened`' },
  { id: 9, meta: { kind: 'activity', appSlug: 'garden', issueNumber: 6149 }, opener: false, why: 'a request\'s news' },
];

test('the client and the server agree on what opens a private thread', () => {
  const src = read('frontend/src/features/messages/bot-request.ts');
  assert.match(src, /export function isPrivateThreadOpener\(message: ConversationMessage\): boolean \{\s+const meta = message\.sender\.bot \? message\.metadata\?\.homeroomBot : null;\s+return !!meta && typeof meta\.kind === 'string' && meta\.kind\.startsWith\('opened_'\);\s+\}/);
  // Main draws none of them, live or read.
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /if \(botDm && isPrivateThreadOpener\(message\)\) continue;/);
  // The stream, the preview and the unread count all leave it out.
  const server = read('src/services/conversations.js');
  assert.match(server, /const PRIVATE_THREAD_OPENER = `\(m\.metadata->'homeroomBot' IS NOT NULL/);
  assert.match(server, /LEFT\(COALESCE\(m\.metadata->'homeroomBot'->>'kind', ''\), 7\) = 'opened_'/, 'LEFT, not LIKE, whose `_` is a wildcard');
  assert.doesNotMatch(server, /homeroomBot'->>'kind' LIKE 'opened_/);
  assert.equal((server.match(/AND NOT \$\{PRIVATE_THREAD_OPENER\}/g) || []).length, 3, 'the main stream, the preview and the unread count');
  assert.match(server, /AND NOT \$\{PRIVATE_THREAD_OPENER\}`;/, 'the main stream ends with it');
});

test('PRIVATE_THREAD_OPENER, run by PostgreSQL, takes out the bot\'s opener lines and nothing else', { timeout: 30000 }, async (t) => {
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
    `SELECT m.id, ${conversations.PRIVATE_THREAD_OPENER} AS opener FROM (VALUES ${values}) AS m(id, metadata) ORDER BY m.id`, params,
  );
  for (const row of ROWS) {
    assert.equal(rows.find((r) => r.id === row.id).opener, row.opener, row.why);
  }
});
