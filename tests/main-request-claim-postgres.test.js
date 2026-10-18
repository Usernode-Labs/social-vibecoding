'use strict';

// A request the main-check machine's work files (a fix request for a red
// main, a flake request) is claimed in Postgres before it is filed on
// GitHub, so two attempts never file it twice. The claim is written in the
// work item's name (`claimedBy`, its wf_work id) by the claim's own
// statement, so the attempt after a crash, wherever it came, knows the claim
// is its own and carries the filing on.
//
// Before: a process that died between the claim and the filing left a claim
// nobody owned, and the retry found the red (or the test) claimed, filed
// nothing and succeeded (review of 24adf32). Keeping the claim in the work's
// checkpoint after taking it left the same window, a crash before the
// checkpoint was written (review of 91b767c). And a flake claim after the
// fortnight kept the last request's number, so an attempt carrying it on
// returned the closed request of two weeks before and filed nothing.
//
// A crash is an attempt that never finishes: a statement it sent, or its
// filing, never comes back. The next attempt has only what Postgres kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_FIX_REQUESTS;
delete process.env.MAIN_WATCH_FLAKE_REQUESTS;

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const created = [];
const fronted = [];
let botId = null;
let number = 7000;
// `stall`: the next filing reaches GitHub and never comes back.
let stall = null;
const github = {
  isEnabled: () => true,
  safeMention: (s) => s,
  noteIssueCreated: () => {},
  async createIssue(owner, repo, issue) {
    if (stall) { const s = stall; stall = null; s(); return new Promise(() => {}); }
    created.push(issue); return { number: ++number };
  },
  compareCommitAncestry: async () => ({ status: 'diverged' }),
};
stub('../src/services/github', github);
stub('../src/services/ws', { sendSystemMessage: async () => {}, pushSessionUpdate: () => {}, pushIssueUpdate: () => {} });
stub('../src/services/notifications', { notifyIssueFiled: () => {} });
stub('../src/services/homeroom-bot', {
  ensureBotUser: async () => ({ id: botId, username: 'homeroom_bot' }),
  noteIssueActivity: () => true,
  enqueueFront: async (pool, args) => { fronted.push(args); return { id: 1 }; },
});

const mainWatch = require('../src/services/main-watch');
const redFix = require('../src/services/main-red-fix');

const RED = 'f'.repeat(40);
const FLAKY = { file: 'tests/clock.test.js', test: 'the clock ticks once a second' };
const WORK_ID = '6f1d2c3b-0000-4000-8000-000000000001';
const OTHER_WORK = '6f1d2c3b-0000-4000-8000-000000000002';

// One attempt that dies: its statement matching `at` runs (`after`) or is
// never sent (`before`), and it never hears back. Resolves once it is gone.
function dyingAttempt(pool, { at, after = false }) {
  let gone;
  const died = new Promise((resolve) => { gone = resolve; });
  const p = {
    async query(sql, params) {
      if (!at.test(sql)) return pool.query(sql, params);
      if (after) await pool.query(sql, params);
      gone();
      return new Promise(() => {});
    },
  };
  return { pool: p, died };
}
const count = async (pool, table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

async function database(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  // Idle connections the server drops (this teardown's own forced DROP, or
  // a parallel file's administrative command on the shared server) surface
  // as a pool 'error'; without a listener that is an uncaughtException
  // attributed to whichever test is running. See the note on pool below and
  // tests/username-invite-join-postgres.test.js.
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return null;
  }
  const name = `request_claim_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  // pool.end() hands its idle connections their end without waiting for
  // their sockets to close, so the teardown's DROP DATABASE WITH (FORCE)
  // can terminate one still closing (57P01). The pool re-emits that as
  // 'error', which without a listener fails the file on its teardown
  // (tests/username-invite-join-postgres.test.js failed 5 of 6 runs that
  // way). Expected here; a failing query still fails its test.
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  ({ rows: [{ id: botId }] } = await pool.query("INSERT INTO users (username, password) VALUES ('homeroom_bot', 'x') RETURNING id"));
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Claims', 'claims-app', 'running', $1, 'https://github.com/Usernode-Labs/claims-app') RETURNING *`, [botId]);
  return { pool, app };
}

test.beforeEach(() => { created.length = 0; fronted.length = 0; stall = null; });

test('a fix request: the attempt after a crash at any point files it, once', async (t) => {
  const db = await database(t); if (!db) return;
  const { pool, app } = db;
  const parsed = { owner: 'Usernode-Labs', repo: 'claims-app' };
  const file = (p, claimedBy = WORK_ID) => redFix.fileFixRequest({}, p, {
    app, parsed, redSha: RED, prNumber: 12, detail: { failingTests: [FLAKY] }, fileBotIssue: mainWatch.fileBotIssue,
    strict: true, claimedBy,
  });
  const reset = async () => { await pool.query('DELETE FROM main_red_requests'); await pool.query('DELETE FROM issues'); created.length = 0; fronted.length = 0; };

  // Dies once the claim is committed, before it hears so (review of 91b767c).
  number = 7000;
  const one = dyingAttempt(pool, { at: /INSERT INTO main_red_requests/, after: true });
  file(one.pool); await one.died;
  assert.equal(await count(pool, 'main_red_requests'), 1, 'the claim stands');
  // Another work's attempt (or a release's without a name) finds it claimed.
  assert.equal(await file(pool, OTHER_WORK), null);
  assert.equal(await file(pool, null), null);
  assert.equal(created.length, 0);
  // The same work's next attempt carries it on.
  assert.equal(await file(pool), 7001);
  assert.equal(created.length, 1);
  assert.deepEqual((await pool.query('SELECT issue_number, claimed_by FROM main_red_requests')).rows, [{ issue_number: 7001, claimed_by: WORK_ID }]);
  assert.deepEqual(fronted.map((f) => f.issueNumber), [7001]);
  // Filed: asked again, it is not filed twice.
  assert.equal(await file(pool), 7001);
  assert.equal(created.length, 1);

  // Dies on GitHub's side of the filing.
  await reset(); number = 7000;
  const reached = new Promise((resolve) => { stall = resolve; });
  file(pool); await reached;
  assert.equal(await file(pool), 7001);
  assert.equal(created.length, 1);

  // Dies after filing, before the number is written: the next attempt finds
  // the request the bot filed and files no second one.
  await reset(); number = 7000;
  const two = dyingAttempt(pool, { at: /UPDATE main_red_requests SET issue_number/ });
  file(two.pool); await two.died;
  assert.equal(created.length, 1);
  assert.equal(await file(pool), 7001);
  assert.equal(created.length, 1, 'filed once');
  assert.deepEqual((await pool.query('SELECT issue_number FROM main_red_requests')).rows, [{ issue_number: 7001 }]);
  assert.deepEqual(fronted.map((f) => f.issueNumber), [7001], 'still put at the front of the bot\'s queue');

  // A filing GitHub refused throws for the work to retry, and gives the claim back.
  await reset();
  const createIssue = github.createIssue;
  github.createIssue = async () => { throw new Error('GitHub 502'); };
  t.after(() => { github.createIssue = createIssue; });
  await assert.rejects(file(pool), /GitHub 502/);
  assert.equal(await count(pool, 'main_red_requests'), 0);
});

test('a flake request: the attempt after a crash at any point files it, once, and never takes the last request for it', async (t) => {
  const db = await database(t); if (!db) return;
  const { pool, app } = db;
  const reset = async () => {
    await pool.query('DELETE FROM main_test_flakes'); await pool.query('DELETE FROM issues');
    await pool.query('INSERT INTO main_test_flakes (app_id, file, test) VALUES ($1, $2, $3)', [app.id, FLAKY.file, FLAKY.test]);
    created.length = 0; number = 8000;
  };
  const file = (p, claimedBy = WORK_ID) => mainWatch.fileFlakeRequest({}, p, app, FLAKY, { mergeSha: RED, strict: true, claimedBy });
  const row = async () => (await pool.query('SELECT request_issue_number, request_claimed_by FROM main_test_flakes')).rows[0];
  const CLAIM = /UPDATE main_test_flakes f\s+SET request_filed_at = NOW\(\)/;

  // Dies once the claim is committed, before it hears so.
  await reset();
  const one = dyingAttempt(pool, { at: CLAIM, after: true });
  file(one.pool); await one.died;
  assert.equal(await file(pool, OTHER_WORK), null, 'claimed: another work files nothing');
  assert.equal(await file(pool), 8001);
  assert.equal(created.length, 1);
  assert.deepEqual(await row(), { request_issue_number: 8001, request_claimed_by: WORK_ID });

  // Dies on GitHub's side of the filing.
  await reset();
  const reached = new Promise((resolve) => { stall = resolve; });
  file(pool); await reached;
  assert.equal(await file(pool), 8001);
  assert.equal(created.length, 1);

  // Dies after filing, before the number is written.
  await reset();
  const two = dyingAttempt(pool, { at: /^UPDATE main_test_flakes SET request_issue_number/ });
  file(two.pool); await two.died;
  assert.equal(created.length, 1);
  assert.equal(await file(pool), 8001);
  assert.equal(created.length, 1, 'filed once');
  assert.deepEqual(await row(), { request_issue_number: 8001, request_claimed_by: WORK_ID });

  // A fortnight after a request (an earlier work's) now closed (review of
  // 91b767c): the new claim clears its number, so the attempt after a crash files a new one
  // rather than take the closed one for its own.
  await reset();
  await pool.query(`INSERT INTO issues (app_id, github_issue_number, title, kind, status, created_at)
                    VALUES ($1, 7999, 'Flaky test: the clock ticks once a second', 'general', 'closed', NOW() - interval '15 days')`, [app.id]);
  await pool.query(`UPDATE main_test_flakes SET request_issue_number = 7999, request_filed_at = NOW() - interval '15 days',
                           request_claimed_by = $1`, [OTHER_WORK]);
  const three = dyingAttempt(pool, { at: CLAIM, after: true });
  file(three.pool); await three.died;
  assert.deepEqual(await row(), { request_issue_number: null, request_claimed_by: WORK_ID });
  assert.equal(await file(pool), 8001, 'a new request, not the closed one');
  assert.equal(created.length, 1);

  // A filing GitHub refused throws, and gives the claim back.
  await reset();
  const createIssue = github.createIssue;
  github.createIssue = async () => { throw new Error('GitHub 502'); };
  t.after(() => { github.createIssue = createIssue; });
  await assert.rejects(file(pool), /GitHub 502/);
  const { rows: [r] } = await pool.query('SELECT request_filed_at, request_claimed_by FROM main_test_flakes');
  assert.deepEqual(r, { request_filed_at: null, request_claimed_by: null });
});
