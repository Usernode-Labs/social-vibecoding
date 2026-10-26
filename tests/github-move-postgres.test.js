'use strict';

// The boot migration of the move off GitHub (services/github-move.js)
// against the full PostgreSQL schema: requests from their twins, each
// recorded move applied once (the app repointed, its owner/repo keys moved,
// its proposals given native pull requests), an app without a recorded move
// left on GitHub, and a second boot that changes nothing. TEST_DATABASE_URL
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

  await pool.query(`INSERT INTO users (id, username, password) VALUES (1, 'ada', 'x')`);
  const { rows: [moved] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url, main_sha) VALUES ('Todo', 'todo-list-b91765',
       'https://github.com/usernode-bot/todo-list-b91765', '${'a'.repeat(40)}') RETURNING id`);
  const { rows: [stays] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Homeroom', 'usernode-2d5619', 'https://github.com/Usernode-Labs/social-vibecoding')
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

  // Its proposals: one up for a vote, one merged, one closed.
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, pr_number, pr_title, pr_body, merge_commit_sha, merged_at) VALUES
       ($1, 1, 'dev/open', 'promoted', 20, 'Open one', 'body', NULL, NULL),
       ($1, 1, 'dev/merged', 'archived', 21, 'Merged one', '', '${'b'.repeat(40)}', NOW()),
       ($1, 1, 'dev/closed', 'archived', 22, 'Closed one', '', NULL, NULL)`, [moved.id]);

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

  // A second boot changes nothing.
  result = await move.migrate(pool);
  assert.deepEqual(result, { twins: 0, applied: [] });
});
