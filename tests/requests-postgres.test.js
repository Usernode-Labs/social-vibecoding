'use strict';

// Native requests (services/requests.js) and the per-app number sequence
// (services/app-numbers.js) against the full PostgreSQL schema.
//
// GitHub suspended the account that filed every request (25 Oct 2026);
// requests are rows now, keyed by the repository's owner and name as the
// GitHub helpers were, numbered from one sequence per app that continues
// above every number the app has used. TEST_DATABASE_URL selects a local
// test database, like the other *-postgres tests.

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

const requests = require('../src/services/requests');
const appNumbers = require('../src/services/app-numbers');

test('requests are rows: filed, listed, numbered, closed, reopened and commented', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'native_requests_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const priorEnv = { GIT_HOST_URL: process.env.GIT_HOST_URL, GIT_HOST_ORG: process.env.GIT_HOST_ORG, USERNODE_DOMAIN: process.env.USERNODE_DOMAIN };
  process.env.GIT_HOST_URL = 'https://git.example.test';
  process.env.GIT_HOST_ORG = 'apps';
  process.env.USERNODE_DOMAIN = 'app.example.test';
  t.after(async () => {
    for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    requests._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  requests._resetForTests();
  requests.setPool(pool);

  await pool.query(`INSERT INTO users (id, username, password) VALUES (1, 'ada', 'x')`);
  const { rows: [hosted] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url, github_repo_url) VALUES
       ('Todo', 'todo-list-b91765', 'https://git.example.test/apps/todo-list-b91765', 'https://github.com/usernode-bot/todo-list-b91765')
     RETURNING id`);
  const { rows: [platform] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Homeroom', 'usernode-2d5619', 'https://github.com/Usernode-Labs/social-vibecoding')
     RETURNING id`);

  // Numbers GitHub handed out before the move: a request's twin row (#40)
  // and a proposal's pull request (#57).
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, status) VALUES ($1, 40, 'Old one', 'as filed', 'open')`, [hosted.id]);
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, pr_title, status, pr_number) VALUES ($1, 1, 'A change', 'active', 57)`, [hosted.id]);

  // An unknown repository has no board.
  assert.deepEqual(await requests.listOpen('apps', 'nope'), { issues: [], truncatedList: false, note: 'issues unavailable' });

  // Filing continues above every number the app used, from either kind.
  const first = await requests.create('apps', 'todo-list-b91765', { title: 'Dark mode', body: 'please', createdBy: 1 });
  assert.equal(first.number, 58);
  assert.equal(first.html_url, 'https://app.example.test/#app/todo-list-b91765/dev/issues/58');
  assert.equal(first.state, 'open');
  assert.equal(first.user, null, 'filed here: no GitHub author');
  const second = await requests.create('Apps', 'TODO-LIST-B91765.git', { title: 'Search', labels: ['usernode'] });
  assert.equal(second.number, 59, 'owner and name match without regard to case or .git');
  assert.equal((await appNumbers.next(hosted.id, { db: pool })), 60, 'proposals draw from the same sequence');

  // The old GitHub address still finds the app (keys written before the move).
  const viaOld = await requests.getOne('usernode-bot', 'todo-list-b91765', 58);
  assert.equal(viaOld.issue.title, 'Dark mode');

  // The platform's own board is native too.
  const own = await requests.create('Usernode-Labs', 'social-vibecoding', { title: 'Platform thing' });
  assert.equal(own.number, 1);

  // The board: open ones, most recently updated first, in the GitHub helper's shape.
  await pool.query(`UPDATE requests SET updated_at = NOW() - INTERVAL '1 hour' WHERE number = 58`);
  const board = await requests.listOpen('apps', 'todo-list-b91765');
  assert.deepEqual(board.issues.map((i) => i.number), [59, 58]);
  assert.deepEqual(Object.keys(board.issues[0]).sort(),
    ['body', 'closedAt', 'createdAt', 'htmlUrl', 'labels', 'number', 'state', 'title', 'updatedAt', 'user']);
  assert.deepEqual(board.issues[0].labels, ['usernode']);
  assert.equal(board.truncatedList, false);

  // A proposal's number is not a request.
  assert.deepEqual(await requests.getOne('apps', 'todo-list-b91765', 57), { issue: null, note: 'not an issue (pull request)' });
  assert.deepEqual(await requests.getOne('apps', 'todo-list-b91765', 999), { issue: null, note: 'not found' });
  await assert.rejects(requests.getRaw('apps', 'todo-list-b91765', 999), (err) => err.status === 404);

  // Edits, close with a reason, reopen.
  await requests.setTitle('apps', 'todo-list-b91765', 58, 'Dark mode, please');
  await requests.setContent('apps', 'todo-list-b91765', 59, { title: 'Search box', body: 'top right' });
  const closed = await requests.close('apps', 'todo-list-b91765', 58, { reason: 'not_planned', closedBy: 1 });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.state_reason, 'not_planned');
  assert.ok(closed.closed_at);
  assert.deepEqual((await requests.listOpen('apps', 'todo-list-b91765')).issues.map((i) => i.number), [59]);
  const one = await requests.getOne('apps', 'todo-list-b91765', 58);
  assert.equal(one.issue.state, 'closed');
  assert.equal(one.issue.title, 'Dark mode, please');
  const reopened = await requests.reopen('apps', 'todo-list-b91765', 58);
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.closed_at, null);
  assert.equal((await requests.close('apps', 'todo-list-b91765', 58)).state_reason, 'completed', 'GitHub\'s default reason');

  // Comments: what were GitHub comments.
  const c1 = await requests.comment('apps', 'todo-list-b91765', 59, 'A spec is posted <!-- marker:abc -->');
  assert.equal(c1.user.login, 'homeroom');
  await requests.comment('apps', 'todo-list-b91765', 59, 'second', { userId: 1, authorLogin: 'ada' });
  const thread = await requests.comments('apps', 'todo-list-b91765', 59);
  assert.deepEqual(thread.comments.map((c) => [c.author, c.body.slice(0, 6)]), [['homeroom', 'A spec'], ['ada', 'second']]);
  assert.equal(thread.truncated, false);
  const capped = await requests.comments('apps', 'todo-list-b91765', 59, { max: 1 });
  assert.equal(capped.comments.length, 1);
  assert.equal(capped.truncated, true);
  await assert.rejects(requests.comment('apps', 'todo-list-b91765', 999, 'x'), (err) => err.status === 404);

  // A filing made idempotent by a marker in its body.
  await requests.create('apps', 'todo-list-b91765', { title: 'First version', body: 'x <!-- first-version:7 --> y' });
  assert.deepEqual(await requests.findByMarker('apps', 'todo-list-b91765', '<!-- first-version:7 -->'), { number: 61 });
  assert.equal(await requests.findByMarker('apps', 'todo-list-b91765', '<!-- nope -->'), null);

  // A number some row already holds (imported after the counter started) is skipped.
  await pool.query(`INSERT INTO requests (app_id, number, title, source) VALUES ($1, 62, 'Imported', 'board')`, [hosted.id]);
  assert.equal((await requests.create('apps', 'todo-list-b91765', { title: 'Next' })).number, 63);
  await appNumbers.reserveThrough(hosted.id, 80, { db: pool });
  assert.equal((await requests.create('apps', 'todo-list-b91765', { title: 'After import' })).number, 81);

  // A title is required.
  await assert.rejects(requests.create('apps', 'todo-list-b91765', { title: '  ' }), (err) => err.status === 422);
  assert.ok(platform.id);
});
