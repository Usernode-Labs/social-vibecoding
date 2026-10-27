'use strict';

// The boot migration of the move off GitHub (services/github-move.js)
// against the full PostgreSQL schema: requests from their twins, each
// recorded move applied once (the app repointed, its owner/repo keys moved,
// its proposals given native pull requests and their GitHub links turned into
// change pages), an app without a recorded move left on GitHub, and a second
// boot that changes nothing. TEST_DATABASE_URL
// selects a local test database, like the other *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const move = require('../src/services/github-move');

test('the move migration repoints recorded apps once and copies twins', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'github_move_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const prior = { GIT_HOST_URL: process.env.GIT_HOST_URL, GIT_HOST_ORG: process.env.GIT_HOST_ORG, USERNODE_DOMAIN: process.env.USERNODE_DOMAIN };
  process.env.GIT_HOST_URL = 'https://git.example.test';
  process.env.GIT_HOST_ORG = 'apps';
  process.env.USERNODE_DOMAIN = 'homeroom.example.test';
  t.after(async () => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  await pool.query(`INSERT INTO users (id, username, password) VALUES (1, 'ada', 'x')`);
  const { rows: [moved] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url, main_sha) VALUES ('Todo', 'todo-list-b91765',
       'https://github.com/usernode-bot/todo-list-b91765', '${'a'.repeat(40)}') RETURNING id`);
  const { rows: [stays] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Homeroom', 'usernode-2d5619', 'https://github.com/Usernode-Labs/social-vibecoding')
     RETURNING id`);
  // An app held back on GitHub: no recorded move.
  const { rows: [held] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('DTV', 'dtv-610ccb', 'https://github.com/usernode-bot/dtv-610ccb')
     RETURNING id`);

  // Twins: two of one request (the newer wins), a closed one, a governance row (not a request).
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, status, kind, created_by) VALUES
       ($1, 7, 'Dark mode (old)', 'first text', 'open', 'general', 1),
       ($1, 7, 'Dark mode', 'as filed', 'open', 'general', 1),
       ($1, 9, 'Done thing', 'x', 'closed', 'general', NULL),
       ($1, 12, 'Close #7', '', 'open', 'close_issue', 1),
       ($2, 3, 'Platform idea', 'y', 'open', 'general', 1)`, [moved.id, stays.id]);
  // A request already imported from the rescued board: it wins over its twin.
  await pool.query(
    `INSERT INTO requests (app_id, number, title, body, source) VALUES ($1, 9, 'Done thing', 'current text', 'board')`, [moved.id]);

  // Keys on the old owner/repo.
  await pool.query(
    `INSERT INTO feedback_reports (issue_owner, issue_repo, issue_number, user_id, target, description)
     VALUES ('usernode-bot', 'todo-list-b91765', 7, 1, 'app', 'd')`);
  await pool.query(
    `INSERT INTO title_heal_queue (owner, repo, issue_number, description) VALUES ('usernode-bot', 'TODO-LIST-B91765', 7, 'd')`);

  // Its proposals: one up for a vote, one merged, one closed, each linked to
  // its pull request on GitHub.
  const gh = 'https://github.com/usernode-bot/todo-list-b91765/pull';
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, pr_number, pr_url, pr_title, pr_body, merge_commit_sha, merged_at) VALUES
       ($1, 1, 'dev/open', 'promoted', 20, '${gh}/20', 'Open one', 'body', NULL, NULL),
       ($1, 1, 'dev/merged', 'archived', 21, '${gh}/21', 'Merged one', '', '${'b'.repeat(40)}', NOW()),
       ($1, 1, 'dev/closed', 'archived', 22, '${gh}/22', 'Closed one', '', NULL, NULL)`, [moved.id]);
  // The platform's and the held-back app's stay on GitHub.
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, pr_number, pr_url) VALUES
       ($1, 1, 'dev/platform', 'promoted', 5821, 'https://github.com/Usernode-Labs/social-vibecoding/pull/5821'),
       ($2, 1, 'dev/held', 'promoted', 4, 'https://github.com/usernode-bot/dtv-610ccb/pull/4')`, [stays.id, held.id]);
  const links = async () => (await pool.query(
    `SELECT a.slug, cs.pr_number, cs.pr_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id ORDER BY cs.id`)).rows
    .map((r) => [r.slug, r.pr_number, r.pr_url]);
  const untouched = [
    ['usernode-2d5619', 5821, 'https://github.com/Usernode-Labs/social-vibecoding/pull/5821'],
    ['dtv-610ccb', 4, 'https://github.com/usernode-bot/dtv-610ccb/pull/4'],
  ];

  // Before any move: twins copied, nothing repointed.
  let result = await move.migrate(pool);
  assert.equal(result.applied.length, 0);
  const reqs = (await pool.query(`SELECT app_id, number, title, body, state, source, recovered_partial, created_by FROM requests ORDER BY app_id, number`)).rows;
  assert.deepEqual(reqs.map((r) => [r.app_id === moved.id ? 'todo' : 'homeroom', r.number, r.title, r.state, r.source]), [
    ['todo', 7, 'Dark mode', 'open', 'twin'],
    ['todo', 9, 'Done thing', 'open', 'board'],
    ['homeroom', 3, 'Platform idea', 'open', 'twin'],
  ]);
  assert.equal(reqs[0].recovered_partial, true);
  assert.equal(reqs[0].created_by, 1);
  assert.equal(reqs[1].body, 'current text', 'the rescued board text wins over the twin');
  assert.equal((await pool.query('SELECT repo_url FROM apps WHERE id = $1', [moved.id])).rows[0].repo_url,
    'https://github.com/usernode-bot/todo-list-b91765', 'no recorded move: untouched');
  assert.equal(result.links, 0);
  assert.deepEqual((await links()).slice(0, 3).map((l) => l[2]), [`${gh}/20`, `${gh}/21`, `${gh}/22`],
    'no recorded move: its links stay on GitHub');

  // The recovery tool records the move; the next boot applies it.
  await pool.query(
    `INSERT INTO git_host_moves (app_id, repo_url, github_repo_url, main_sha, github_main_sha, outcome, source_image)
     VALUES ($1, 'https://git.example.test/apps/todo-list-b91765', 'https://github.com/usernode-bot/todo-list-b91765',
             '${'c'.repeat(40)}', '${'a'.repeat(40)}', 'recovered', 'ghcr.io/x@sha256:1')`, [moved.id]);
  result = await move.migrate(pool);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].pulls, 3);
  const app = (await pool.query('SELECT repo_url, github_repo_url, main_sha FROM apps WHERE id = $1', [moved.id])).rows[0];
  assert.deepEqual(app, {
    repo_url: 'https://git.example.test/apps/todo-list-b91765',
    github_repo_url: 'https://github.com/usernode-bot/todo-list-b91765',
    main_sha: 'c'.repeat(40),
  });
  const fr = (await pool.query(`SELECT issue_owner, issue_repo FROM feedback_reports`)).rows;
  assert.deepEqual(fr, [{ issue_owner: 'apps', issue_repo: 'todo-list-b91765' }]);
  const th = (await pool.query(`SELECT owner, repo FROM title_heal_queue`)).rows;
  assert.deepEqual(th, [{ owner: 'apps', repo: 'todo-list-b91765' }], 'matched without regard to case');
  const pulls = (await pool.query(
    `SELECT number, head_branch, state, merged, merge_commit_sha FROM native_pulls WHERE app_id = $1 ORDER BY number`, [moved.id])).rows;
  assert.deepEqual(pulls.map((p) => [p.number, p.head_branch, p.state, p.merged]), [
    [20, 'dev/open', 'open', false], [21, 'dev/merged', 'closed', true], [22, 'dev/closed', 'closed', false],
  ]);
  assert.ok((await pool.query('SELECT applied_at FROM git_host_moves WHERE app_id = $1', [moved.id])).rows[0].applied_at);
  assert.equal((await pool.query('SELECT repo_url FROM apps WHERE id = $1', [stays.id])).rows[0].repo_url,
    'https://github.com/Usernode-Labs/social-vibecoding', 'the platform stays on GitHub');
  // Every one of the moved app's proposals links to its change page, open,
  // merged or closed; the platform's and the held-back app's are as they were.
  assert.equal(result.links, 3);
  const page = 'https://homeroom.example.test/#app/todo-list-b91765/dev/changes';
  assert.deepEqual(await links(), [
    ['todo-list-b91765', 20, `${page}/20`],
    ['todo-list-b91765', 21, `${page}/21`],
    ['todo-list-b91765', 22, `${page}/22`],
    ...untouched,
  ]);

  // A second boot changes nothing.
  result = await move.migrate(pool);
  assert.deepEqual(result, { twins: 0, applied: [], links: 0 });
  assert.deepEqual((await links()).slice(3), untouched);
});

// The changes underway at the move (services/code-missing.js): which ones
// predate their app's move, read from git_host_moves.applied_at, against the
// real schema. Those are the only ones whose branch is read; one made after
// has its branch made at its first turn and is never "gone".
test('a change made before its app moved is read for its branch; one made after, or on an app that never moved, is not', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'github_move_gone_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const prior = { GIT_HOST_URL: process.env.GIT_HOST_URL, GIT_HOST_ORG: process.env.GIT_HOST_ORG };
  process.env.GIT_HOST_URL = 'https://git.example.test';
  process.env.GIT_HOST_ORG = 'apps';
  t.after(async () => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const codeMissing = require('../src/services/code-missing');

  await pool.query(`INSERT INTO users (id, username, password) VALUES (1, 'ada', 'x')`);
  const { rows: [moved] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Todo', 'todo-1', 'https://git.example.test/apps/todo-1') RETURNING id`);
  const { rows: [held] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Held', 'held-1', 'https://git.example.test/apps/held-1') RETURNING id`);
  await pool.query(
    `INSERT INTO git_host_moves (app_id, repo_url, main_sha, outcome, applied_at)
     VALUES ($1, 'https://git.example.test/apps/todo-1', '${'c'.repeat(40)}', 'recovered', NOW() - INTERVAL '1 day')`, [moved.id]);
  // A move recorded and not applied yet is no move.
  await pool.query(
    `INSERT INTO git_host_moves (app_id, repo_url, main_sha, outcome) VALUES ($1, 'https://git.example.test/apps/held-1', '${'d'.repeat(40)}', 'exact')`,
    [held.id]);
  const { rows: made } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, created_at) VALUES
       ($1, 1, 'dev/ada-before', 'active', NOW() - INTERVAL '3 days'),
       ($1, 1, 'dev/ada-after', 'active', NOW()),
       ($1, 1, NULL, 'paused', NOW() - INTERVAL '3 days'),
       ($2, 1, 'dev/ada-held', 'active', NOW() - INTERVAL '3 days')
     RETURNING id`, [moved.id, held.id]);
  const [before, afterMove, branchless, onHeld] = made.map((r) => Number(r.id));

  const preMove = (await pool.query(codeMissing.PRE_MOVE_IDS_SQL, [[before, afterMove, branchless, onHeld]])).rows.map((r) => Number(r.id));
  assert.deepEqual(preMove.sort((a, b) => a - b), [before, branchless].sort((a, b) => a - b));

  const reads = [];
  const readRef = async (repoUrl, ref) => { reads.push(ref); return ref === 'main' ? 'c'.repeat(40) : null; };
  assert.equal(await codeMissing.branchGone(pool, { id: before }, { readRef }), true, 'main came across, its branch did not');
  assert.deepEqual(reads, ['dev/ada-before', 'main']);
  reads.length = 0;
  assert.equal(await codeMissing.branchGone(pool, { id: afterMove }, { readRef }), false, 'made after the move');
  assert.equal(await codeMissing.branchGone(pool, { id: branchless }, { readRef }), false, 'no branch yet: minted at its first turn');
  assert.equal(await codeMissing.branchGone(pool, { id: onHeld }, { readRef }), false, 'its app has not moved');
  assert.deepEqual(reads, [], 'and none of those is read on the git host');
});
