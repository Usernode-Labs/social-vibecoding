'use strict';

// A request the main-check machine's work files (a fix request for a red
// main, a flake request) is claimed in Postgres before it is filed on
// GitHub, so two attempts never file it twice. The claim is the work's own:
// it is kept in the work's checkpoint (`onClaim`), and the attempt after a
// crash passes it back (`claim`). Before, a process that died between the
// claim and the filing left a claim nobody owned: the retry found the red
// (or the test) claimed, filed nothing and succeeded, and the request was
// lost (review of 24adf32, reproduced here).
//
// A crash is an attempt that never finishes: its filing (or the write of
// the number it got) never resolves, and the next attempt starts with what
// the checkpoint kept.

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
const github = {
  isEnabled: () => true,
  safeMention: (s) => s,
  noteIssueCreated: () => {},
  createIssue: async (owner, repo, issue) => { created.push(issue); return { number: 7000 + created.length }; },
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
const never = () => new Promise(() => {});

// The pool as one attempt sees it: `dies` names the statement it never
// returns from (the process is gone by then).
const attemptPool = (pool, dies) => ({ query: (sql, params) => (dies && dies.test(sql) ? never() : pool.query(sql, params)) });

// What the work's checkpoint keeps across attempts.
function checkpoint() {
  const kept = { claim: null };
  let told;
  const told$ = new Promise((resolve) => { told = resolve; });
  return { kept, told: told$, onClaim: (c) => { kept.claim = c; told(); } };
}

async function database(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return null;
  }
  const name = `request_claim_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
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

test.beforeEach(() => { created.length = 0; fronted.length = 0; });

test('a fix request claimed by an attempt that died is filed by the next one, once', async (t) => {
  const db = await database(t); if (!db) return;
  const { pool, app } = db;
  const parsed = { owner: 'Usernode-Labs', repo: 'claims-app' };
  const detail = { failingTests: [FLAKY] };
  const file = (p, more) => redFix.fileFixRequest({}, p, {
    app, parsed, redSha: RED, prNumber: 12, detail, fileBotIssue: mainWatch.fileBotIssue, strict: true, ...more,
  });

  // Dies before GitHub hears of it.
  const first = checkpoint();
  file(attemptPool(pool, /^\s*SELECT DISTINCT ON \(sha\)/), { onClaim: first.onClaim });
  await first.told;
  assert.equal(created.length, 0);
  // What the retry did before: the red is claimed, so nothing is filed.
  assert.equal(await file(pool, {}), null, 'an unowned claim blocks a fresh attempt');

  // The work's next attempt carries its own claim on.
  const n = await file(pool, { claim: first.kept.claim, onClaim: () => assert.fail('claims again') });
  assert.equal(n, 7001);
  assert.equal(created.length, 1);
  assert.deepEqual((await pool.query('SELECT issue_number FROM main_red_requests')).rows, [{ issue_number: 7001 }]);
  assert.deepEqual(fronted.map((f) => f.issueNumber), [7001]);

  // Dies after filing, before the number is written: the next attempt finds
  // the request the bot filed and files no second one.
  await pool.query('DELETE FROM main_red_requests'); await pool.query('DELETE FROM issues');
  created.length = 0; fronted.length = 0;
  const second = checkpoint();
  file(attemptPool(pool, /UPDATE main_red_requests SET issue_number/), { onClaim: second.onClaim });
  await second.told;
  for (let i = 0; i < 100 && !(await pool.query('SELECT 1 FROM issues')).rows.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(created.length, 1);
  assert.equal(await file(pool, { claim: second.kept.claim }), 7001);
  assert.equal(created.length, 1, 'filed once');
  assert.deepEqual((await pool.query('SELECT issue_number FROM main_red_requests')).rows, [{ issue_number: 7001 }]);
  assert.deepEqual(fronted.map((f) => f.issueNumber), [7001], 'still put at the front of the bot\'s queue');

  // A claim the work could not keep is given back, for the next attempt.
  await pool.query('DELETE FROM main_red_requests');
  await assert.rejects(file(pool, { onClaim: async () => { throw new Error('checkpoint lost'); } }), /checkpoint lost/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM main_red_requests')).rows[0].n, 0);
  // A filing GitHub refused throws for the work to retry, and gives the claim back.
  const createIssue = github.createIssue;
  github.createIssue = async () => { throw new Error('GitHub 502'); };
  t.after(() => { github.createIssue = createIssue; });
  await assert.rejects(file(pool, { onClaim: () => {} }), /GitHub 502/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM main_red_requests')).rows[0].n, 0);
});

test('a flake request claimed by an attempt that died is filed by the next one, once', async (t) => {
  const db = await database(t); if (!db) return;
  const { pool, app } = db;
  const createIssue = github.createIssue;
  // `stall`: the next filing reaches GitHub and never comes back.
  let stall = null;
  github.createIssue = async (owner, repo, issue) => {
    if (stall) { const s = stall; stall = null; s(); return never(); }
    created.push(issue); return { number: 8000 + created.length };
  };
  t.after(() => { github.createIssue = createIssue; });
  const reset = async () => {
    await pool.query('DELETE FROM main_test_flakes'); await pool.query('DELETE FROM issues');
    await pool.query('INSERT INTO main_test_flakes (app_id, file, test) VALUES ($1, $2, $3)', [app.id, FLAKY.file, FLAKY.test]);
    created.length = 0;
  };
  const file = (p, more) => mainWatch.fileFlakeRequest({}, p, app, FLAKY, { mergeSha: RED, strict: true, ...more });
  const row = async () => (await pool.query('SELECT request_issue_number FROM main_test_flakes')).rows[0];

  // Dies before GitHub hears of it.
  await reset();
  const first = checkpoint();
  const reached = new Promise((resolve) => { stall = resolve; });
  file(pool, { onClaim: first.onClaim });
  await first.told; await reached;
  assert.match(first.kept.claim.at, /\.\d{1,6}/, 'the claim is named to the microsecond');
  assert.equal(await file(pool, {}), null, 'an unowned claim blocks a fresh attempt');
  assert.equal(await file(pool, { claim: first.kept.claim, onClaim: () => assert.fail('claims again') }), 8001);
  assert.equal(created.length, 1);
  assert.deepEqual(await row(), { request_issue_number: 8001 });

  // Dies after filing, before the number is written.
  await reset();
  const second = checkpoint();
  file(attemptPool(pool, /SET request_issue_number/), { onClaim: second.onClaim });
  await second.told;
  for (let i = 0; i < 100 && !(await pool.query('SELECT 1 FROM issues')).rows.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(created.length, 1);
  assert.equal(await file(pool, { claim: second.kept.claim }), 8001);
  assert.equal(created.length, 1, 'filed once');
  assert.deepEqual(await row(), { request_issue_number: 8001 });

  // A claim that is no longer this work's (taken again after the cooldown)
  // is not carried on: the work claims afresh, and that claim is refused
  // while the other one stands.
  await reset();
  await pool.query("UPDATE main_test_flakes SET request_filed_at = NOW() - interval '1 minute'");
  assert.equal(await file(pool, { claim: { at: '2020-01-01 00:00:00+00' }, onClaim: () => assert.fail('claims') }), null);
  assert.equal(created.length, 0);

  // A claim the work could not keep is given back.
  await reset();
  await assert.rejects(file(pool, { onClaim: async () => { throw new Error('checkpoint lost'); } }), /checkpoint lost/);
  assert.equal((await pool.query('SELECT request_filed_at FROM main_test_flakes')).rows[0].request_filed_at, null);
});
