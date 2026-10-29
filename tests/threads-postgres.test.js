'use strict';

// Threads, stage 1 of #6019, against a real PostgreSQL: the "Threads" block
// of src/db/schema.sql (the table, the attach columns, the functions and
// their triggers) and services/threads.js's backfill.
//
// The block is lifted out of schema.sql and run as written, twice (schema.sql
// runs on every boot), in a scratch schema beside stub tables holding just
// the columns it reads. What these pin:
//
//   1. Every new row is attached by the rule the plan names: a request by its
//      number; a change by its first linked request, else the request it was
//      made from, else its own PR number (a manifest branch makes a decision);
//      a request's twin and a proposal to close by a number; any other
//      governance row a decision of its own; a message by its anchor.
//   2. A draft that gets its thread later takes its replies with it.
//   3. No write fails because its thread could not be made.
//   4. The backfill attaches every row that was there before, and running it
//      again changes nothing.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `threads_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

/** The schema's threads block, as it ships: from its heading to the end of the file. */
function threadsBlock() {
  const start = SCHEMA_SQL.indexOf('-- ── Threads (stage 1 of #6019)');
  assert.ok(start > 0, 'the threads block must be findable in schema.sql');
  const next = SCHEMA_SQL.indexOf('\n-- ── ', start + 10);
  return SCHEMA_SQL.slice(start, next > 0 ? next : undefined);
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE apps (id SERIAL PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT, description TEXT);
    CREATE TABLE requests (
      id BIGSERIAL PRIMARY KEY, app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
      state VARCHAR(8) NOT NULL DEFAULT 'open', UNIQUE (app_id, number));
    CREATE TABLE issues (
      id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id) ON DELETE CASCADE,
      github_issue_number INTEGER, title VARCHAR(512) NOT NULL,
      kind VARCHAR(32) NOT NULL DEFAULT 'general', payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(32) NOT NULL DEFAULT 'open');
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id) ON DELETE CASCADE,
      branch_name VARCHAR(255), pr_number INTEGER, pr_title VARCHAR(256),
      linked_issues INTEGER[] NOT NULL DEFAULT '{}', created_from_issue_number INTEGER,
      status VARCHAR(32) NOT NULL DEFAULT 'active');
    CREATE TABLE chat_messages (
      id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '', thread_type VARCHAR(16), thread_ref INTEGER, user_id INTEGER);
  `);
  // Twice: schema.sql is applied on every boot.
  await pool.query(threadsBlock());
  await pool.query(threadsBlock());
  return { pool };
}

let ctx;
test.before(async () => { ctx = await connectPool(); });
test.after(async () => {
  if (!ctx || !ctx.pool) return;
  await ctx.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await ctx.pool.end();
});

const one = async (sql, params) => (await ctx.pool.query(sql, params)).rows[0];
const threadOf = (table, id) => one(`SELECT thread_id FROM ${table} WHERE id = $1`, [id]).then((r) => r && r.thread_id);
const threadByNumber = (appId, number) => one('SELECT * FROM threads WHERE app_id = $1 AND number = $2', [appId, number]);

async function app(slug) {
  return (await one('INSERT INTO apps (slug) VALUES ($1) RETURNING id', [slug])).id;
}

test('a request, its twin and its discussion share the thread of its number', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('requests');
  const req = await one('INSERT INTO requests (app_id, number, title) VALUES ($1, 403, $2) RETURNING id, thread_id', [a, 'Night mode']);
  const thread = await threadByNumber(a, 403);
  assert.ok(thread, 'the request made its thread');
  assert.equal(String(req.thread_id), String(thread.id));
  assert.equal(thread.kind, 'work');

  const twin = await one(`INSERT INTO issues (app_id, github_issue_number, title) VALUES ($1, 403, 'Night mode') RETURNING id`, [a]);
  const msg = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref, content) VALUES ($1, 'issue', 403, 'yes') RETURNING id`, [a]);
  assert.equal(String(await threadOf('issues', twin.id)), String(thread.id));
  assert.equal(String(await threadOf('chat_messages', msg.id)), String(thread.id));

  // A discussion of a number with no request row (an app still on GitHub)
  // makes that number's thread.
  const early = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, 'issue', 405) RETURNING id`, [a]);
  assert.equal(String(await threadOf('chat_messages', early.id)), String((await threadByNumber(a, 405)).id));
  // Another app's #403 is another thread.
  const b = await app('requests-b');
  await ctx.pool.query('INSERT INTO requests (app_id, number) VALUES ($1, 403)', [b]);
  assert.notEqual(String((await threadByNumber(b, 403)).id), String(thread.id));
});

test('a change joins its first linked request, else its origin, else its own PR number', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('changes');
  await ctx.pool.query('INSERT INTO requests (app_id, number) VALUES ($1, 10), ($1, 11), ($1, 12)', [a]);
  const linked = await one(`INSERT INTO chat_sessions (app_id, linked_issues, created_from_issue_number, pr_number, branch_name)
                            VALUES ($1, '{11,12}', 10, 20, 'feature/x') RETURNING id`, [a]);
  const origin = await one(`INSERT INTO chat_sessions (app_id, created_from_issue_number, pr_number) VALUES ($1, 10, 21) RETURNING id`, [a]);
  const own = await one(`INSERT INTO chat_sessions (app_id, pr_number, branch_name, pr_title) VALUES ($1, 22, 'feature/y', 'Tidy') RETURNING id`, [a]);
  const decision = await one(`INSERT INTO chat_sessions (app_id, pr_number, branch_name, pr_title)
                              VALUES ($1, 23, 'visibility/changes-1730000000', 'Open it up') RETURNING id`, [a]);
  const draft = await one('INSERT INTO chat_sessions (app_id, branch_name) VALUES ($1, $2) RETURNING id', [a, 'feature/z']);

  assert.equal(String(await threadOf('chat_sessions', linked.id)), String((await threadByNumber(a, 11)).id), 'the first linked request');
  assert.equal(String(await threadOf('chat_sessions', origin.id)), String((await threadByNumber(a, 10)).id), 'the request it was made from');
  const ownThread = await threadByNumber(a, 22);
  assert.equal(String(await threadOf('chat_sessions', own.id)), String(ownThread.id));
  assert.equal(ownThread.kind, 'work');
  assert.equal(ownThread.title, null);
  const decisionThread = await threadByNumber(a, 23);
  assert.equal(String(await threadOf('chat_sessions', decision.id)), String(decisionThread.id));
  assert.deepEqual([decisionThread.kind, decisionThread.title], ['decision', 'Open it up']);
  assert.equal(await threadOf('chat_sessions', draft.id), null, 'a draft with nothing to go by has no thread yet');

  for (const branch of ['rename/a', 'governance/a', 'admins/a', 'secret-declare/a', 'topics/a']) {
    assert.equal((await one('SELECT thread_kind_for_branch($1) AS k', [branch])).k, 'decision', branch);
  }
  assert.equal((await one('SELECT thread_kind_for_branch($1) AS k', ['renamed-thing/a'])).k, 'work');
  assert.equal((await one('SELECT thread_kind_for_branch(NULL) AS k')).k, 'work');
});

test('a draft that gets its thread later takes its replies with it, and keeps the thread after', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('drafts');
  const draft = await one('INSERT INTO chat_sessions (app_id, branch_name) VALUES ($1, $2) RETURNING id', [a, 'feature/q']);
  const before = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, 'session', $2) RETURNING id`, [a, draft.id]);
  assert.equal(await threadOf('chat_messages', before.id), null);

  await ctx.pool.query('UPDATE chat_sessions SET pr_number = 90 WHERE id = $1', [draft.id]);
  const thread = await threadByNumber(a, 90);
  assert.ok(thread, 'opening its pull request gave it a thread');
  assert.equal(String(await threadOf('chat_sessions', draft.id)), String(thread.id));
  assert.equal(String(await threadOf('chat_messages', before.id)), String(thread.id), 'its earlier reply came along');
  const after = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, 'session', $2) RETURNING id`, [a, draft.id]);
  assert.equal(String(await threadOf('chat_messages', after.id)), String(thread.id));

  // Linking a request afterwards does not move it: moves are a later stage.
  await ctx.pool.query('INSERT INTO requests (app_id, number) VALUES ($1, 91)', [a]);
  await ctx.pool.query(`UPDATE chat_sessions SET linked_issues = '{91}' WHERE id = $1`, [draft.id]);
  assert.equal(String(await threadOf('chat_sessions', draft.id)), String(thread.id));
});

test('a proposal to close joins its target; any other governance row is a decision of its own', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('governance');
  await ctx.pool.query('INSERT INTO requests (app_id, number) VALUES ($1, 382)', [a]);
  const close = await one(`INSERT INTO issues (app_id, kind, title, payload)
                           VALUES ($1, 'close_issue', 'Close issue #382', '{"issueNumber": 382}') RETURNING id`, [a]);
  assert.equal(String(await threadOf('issues', close.id)), String((await threadByNumber(a, 382)).id));

  const secret = await one(`INSERT INTO issues (app_id, kind, title, payload) VALUES ($1, 'secret_change', 'Set secret "KEY"', '{}') RETURNING id`, [a]);
  const rename = await one(`INSERT INTO issues (app_id, kind, title, payload) VALUES ($1, 'rename', 'Rename to Corner', '{}') RETURNING id`, [a]);
  const s = await one('SELECT t.* FROM threads t JOIN issues i ON i.thread_id = t.id WHERE i.id = $1', [secret.id]);
  const r = await one('SELECT t.* FROM threads t JOIN issues i ON i.thread_id = t.id WHERE i.id = $1', [rename.id]);
  assert.deepEqual([s.kind, s.number, s.title], ['decision', null, 'Set secret "KEY"']);
  assert.notEqual(String(s.id), String(r.id), 'each decision is its own thread');

  const onClose = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, 'governance', $2) RETURNING id`, [a, close.id]);
  const onSecret = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, 'governance', $2) RETURNING id`, [a, secret.id]);
  assert.equal(String(await threadOf('chat_messages', onClose.id)), String((await threadByNumber(a, 382)).id));
  assert.equal(String(await threadOf('chat_messages', onSecret.id)), String(s.id));

  // A close vote whose payload names no number is still stored.
  const odd = await one(`INSERT INTO issues (app_id, kind, title, payload) VALUES ($1, 'close_issue', 'Close', '{"issueNumber": "x"}') RETURNING id`, [a]);
  assert.equal(await threadOf('issues', odd.id), null);
});

test('channel messages and reply threads stay out of threads', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('channels');
  for (const [type, ref] of [[null, null], ['message', 4], ['category', 2]]) {
    const m = await one('INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, $2, $3) RETURNING id, thread_id', [a, type, ref]);
    assert.equal(m.thread_id, null, String(type));
  }
  assert.equal((await one('SELECT count(*)::int AS n FROM threads WHERE app_id = $1', [a])).n, 0);
});

test('no write fails because its thread could not be made', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('never-fails');
  // Every new thread is refused from here on.
  await ctx.pool.query('ALTER TABLE threads ADD CONSTRAINT threads_refuse_all CHECK (false) NOT VALID');
  try {
    const req = await one('INSERT INTO requests (app_id, number) VALUES ($1, 999) RETURNING id, thread_id', [a]);
    assert.ok(req.id, 'the request is stored');
    assert.equal(req.thread_id, null);
    const msg = await one(`INSERT INTO chat_messages (app_id, thread_type, thread_ref, content) VALUES ($1, 'issue', 999, 'still here') RETURNING id, thread_id`, [a]);
    assert.ok(msg.id, 'the message is stored');
    assert.equal(msg.thread_id, null);
    const gov = await one(`INSERT INTO issues (app_id, kind, title) VALUES ($1, 'rename', 'Rename') RETURNING id, thread_id`, [a]);
    assert.equal(gov.thread_id, null);
    const change = await one(`INSERT INTO chat_sessions (app_id, pr_number) VALUES ($1, 998) RETURNING id, thread_id`, [a]);
    assert.equal(change.thread_id, null);
  } finally {
    await ctx.pool.query('ALTER TABLE threads DROP CONSTRAINT threads_refuse_all');
  }
  // The backfill picks them up once threads can be made again.
  await ctx.pool.query('DELETE FROM platform_settings');
  await require('../src/services/threads').backfill(ctx.pool);
  assert.ok((await one('SELECT thread_id FROM requests WHERE app_id = $1 AND number = 999', [a])).thread_id);
  assert.ok((await one(`SELECT thread_id FROM chat_messages WHERE app_id = $1 AND thread_ref = 999`, [a])).thread_id);
});

test('two writers making the same number\'s thread at once make one', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('race');
  const ids = await Promise.all(Array.from({ length: 6 }, () => one('SELECT thread_for_number($1, 777) AS id', [a])));
  assert.equal(new Set(ids.map((r) => String(r.id))).size, 1);
  assert.equal((await one('SELECT count(*)::int AS n FROM threads WHERE app_id = $1 AND number = 777', [a])).n, 1);
});

test('the backfill attaches every row that was there before, and running it again changes nothing', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const threads = require('../src/services/threads');
  const a = await app('backfill');
  await ctx.pool.query('INSERT INTO requests (app_id, number) VALUES ($1, 1), ($1, 2)', [a]);
  const close = await one(`INSERT INTO issues (app_id, kind, title, payload) VALUES ($1, 'close_issue', 'Close #2', '{"issueNumber": 2}') RETURNING id`, [a]);
  const decision = await one(`INSERT INTO issues (app_id, kind, title) VALUES ($1, 'rename', 'Rename it') RETURNING id`, [a]);
  const change = await one(`INSERT INTO chat_sessions (app_id, linked_issues, pr_number) VALUES ($1, '{1}', 3) RETURNING id`, [a]);
  const own = await one(`INSERT INTO chat_sessions (app_id, pr_number, branch_name, pr_title) VALUES ($1, 4, 'admins/x', 'Add an admin') RETURNING id`, [a]);
  const msgs = [];
  for (const [type, ref] of [['issue', 1], ['issue', 2], ['issue', 5], ['session', change.id], ['session', own.id],
    ['governance', close.id], ['governance', decision.id], ['message', 1]]) {
    msgs.push((await one('INSERT INTO chat_messages (app_id, thread_type, thread_ref) VALUES ($1, $2, $3) RETURNING id', [a, type, ref])).id);
  }
  // What the triggers attached, as numbers and kinds (a decision thread's id
  // is made again by the backfill, so it is compared by what it is).
  const shape = async () => (await ctx.pool.query(`
    SELECT 'r' || r.id AS row, t.number, t.kind, t.title FROM requests r LEFT JOIN threads t ON t.id = r.thread_id WHERE r.app_id = $1
    UNION ALL SELECT 'i' || i.id, t.number, t.kind, t.title FROM issues i LEFT JOIN threads t ON t.id = i.thread_id WHERE i.app_id = $1
    UNION ALL SELECT 's' || s.id, t.number, t.kind, t.title FROM chat_sessions s LEFT JOIN threads t ON t.id = s.thread_id WHERE s.app_id = $1
    UNION ALL SELECT 'm' || m.id, t.number, t.kind, t.title FROM chat_messages m LEFT JOIN threads t ON t.id = m.thread_id WHERE m.app_id = $1
    ORDER BY 1`, [a])).rows;
  const attached = await shape();
  assert.ok(attached.filter((row) => row.row.startsWith('m')).filter((row) => row.kind).length === 7, 'seven of the eight messages are about a piece of work');

  // As they were before threads existed: nothing attached, no threads.
  await ctx.pool.query('UPDATE chat_messages SET thread_id = NULL WHERE app_id = $1', [a]);
  await ctx.pool.query('UPDATE chat_sessions SET thread_id = NULL WHERE app_id = $1', [a]);
  await ctx.pool.query('UPDATE issues SET thread_id = NULL WHERE app_id = $1', [a]);
  await ctx.pool.query('UPDATE requests SET thread_id = NULL WHERE app_id = $1', [a]);
  await ctx.pool.query('DELETE FROM threads WHERE app_id = $1', [a]);
  await ctx.pool.query('DELETE FROM platform_settings');

  const first = await threads.backfill(ctx.pool, { batch: { messages: 3, sessions: 1 } });
  assert.ok(!first.failed && !first.skipped, JSON.stringify(first));
  assert.deepEqual(await shape(), attached, 'every row is back on the thread its rule gives it');
  assert.ok(await one('SELECT 1 FROM platform_settings WHERE key = $1', [threads.MARKER_KEY]), 'the pass is marked done');

  // Later boots skip it; a re-run without the marker changes nothing.
  assert.deepEqual(await threads.backfill(ctx.pool), { skipped: 'done' });
  const count = async () => (await one('SELECT count(*)::int AS n FROM threads WHERE app_id = $1', [a])).n;
  const threadsBefore = await count();
  await ctx.pool.query('DELETE FROM platform_settings');
  const again = await threads.backfill(ctx.pool, { batch: { messages: 3, sessions: 1 } });
  assert.deepEqual(
    [again.requests, again.issues, again.sessions, again.messages], [0, 0, 0, 0], 'nothing left to attach');
  assert.equal(await count(), threadsBefore, 'and no thread made twice');
  assert.deepEqual(await shape(), attached);
});

test('a thread closes when nothing in it is open, and opens again when something is', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const a = await app('state');
  const req = await one('INSERT INTO requests (app_id, number, title) VALUES ($1, 41, $2) RETURNING id', [a, 'Dark mode']);
  const change = await one(
    `INSERT INTO chat_sessions (app_id, pr_number, linked_issues, status) VALUES ($1, 42, '{41}', 'promoted') RETURNING id`, [a]);
  const twin = await one(`INSERT INTO issues (app_id, github_issue_number, title) VALUES ($1, 41, 'Dark mode') RETURNING id`, [a]);
  const state = async () => (await threadByNumber(a, 41)).state;
  assert.equal(await state(), 'open');

  // The change merges: the request is still open, so the thread is.
  await ctx.pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [change.id]);
  assert.equal(await state(), 'open');
  // The request closes too. Its `general` twin is still open, but it is the
  // request's copy, not a vote: the thread closes.
  await ctx.pool.query(`UPDATE requests SET state = 'closed' WHERE id = $1`, [req.id]);
  assert.equal(await state(), 'closed');
  assert.ok((await threadByNumber(a, 41)).closed_at, 'with the time it closed');

  // A vote to close it, or the request reopened, opens it again.
  const close = await one(
    `INSERT INTO issues (app_id, title, kind, payload) VALUES ($1, 'Close #41', 'close_issue', '{"issueNumber": 41}') RETURNING id`, [a]);
  assert.equal(await state(), 'open');
  await ctx.pool.query(`UPDATE issues SET status = 'closed' WHERE id = $1`, [close.id]);
  assert.equal(await state(), 'closed');
  await ctx.pool.query(`UPDATE requests SET state = 'open' WHERE id = $1`, [req.id]);
  assert.equal(await state(), 'open');
  assert.equal((await threadByNumber(a, 41)).closed_at, null);
  void twin;

  // A thread a merge closed stays closed, whatever is reopened in it.
  const into = await one('INSERT INTO threads (app_id, number) VALUES ($1, 99) RETURNING id', [a]);
  await ctx.pool.query(`UPDATE threads SET merged_into = $2, state = 'closed' WHERE app_id = $1 AND number = 41`, [a, into.id]);
  await ctx.pool.query(`UPDATE requests SET state = 'closed' WHERE id = $1`, [req.id]);
  await ctx.pool.query(`UPDATE requests SET state = 'open' WHERE id = $1`, [req.id]);
  assert.equal(await state(), 'closed');
});

test('the one-time pass sets every thread\'s state from what it holds, once', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const threads = require('../src/services/threads');
  const a = await app('state-pass');
  await ctx.pool.query(`INSERT INTO requests (app_id, number, title, state) VALUES ($1, 51, 'Done', 'closed'), ($1, 52, 'Open', 'open')`, [a]);
  // As before the triggers: both threads open.
  await ctx.pool.query(`UPDATE threads SET state = 'open', closed_at = NULL WHERE app_id = $1`, [a]);
  await ctx.pool.query('DELETE FROM platform_settings WHERE key = $1', [threads.STATE_MARKER_KEY]);
  const first = await threads.refreshStates(ctx.pool);
  assert.ok(first.threads >= 2, JSON.stringify(first));
  assert.equal((await threadByNumber(a, 51)).state, 'closed');
  assert.equal((await threadByNumber(a, 52)).state, 'open');
  assert.deepEqual(await threads.refreshStates(ctx.pool), { skipped: 'done' });
});
