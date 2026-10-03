'use strict';

// "Your requests" on Me (UI overhaul): GET /api/me/requests's SQL against the
// full PostgreSQL schema (src/routes/profile.js MY_REQUESTS_SQL). A request
// can be asked for in the Send feedback dialog (feedback_reports) or on a
// project's board (issues), and each one's standing is read from what this
// platform records: a merged change that named it, a close-request the
// members voted through, a change under way, or nothing yet.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const profile = require('../src/routes/profile');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DAY = 24 * 60 * 60 * 1000;

test('your requests against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'me_requests_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [username])).rows[0].id;
  const me = await user('me_requests');
  const someone = await user('someone_else');
  const { rows: [self] } = await pool.query(
    `INSERT INTO apps (name, slug, self_hosted, repo_url)
     VALUES ('usernode', 'usernode-test', TRUE, 'https://github.com/Acme/Platform.git') RETURNING id`);
  const { rows: [run] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Run Club', 'run-club', 'https://github.com/acme/run-club')
     RETURNING id`);
  const now = Date.now();
  const at = (days) => new Date(now - days * DAY);
  const report = (target, appId, owner, repo, n, title, days, by = me) => pool.query(
    `INSERT INTO feedback_reports (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'What should change.', $8)`,
    [by, target, appId, owner, repo, n, title, at(days)]);
  const boardIssue = (appId, n, title, days, by = me, kind = 'general') => pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, kind, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [appId, n, title, kind, by, at(days)]);
  const change = (appId, status, linked) => pool.query(
    `INSERT INTO chat_sessions (app_id, status, linked_issues) VALUES ($1, $2, $3)`,
    [appId, status, linked]);

  // From the dialog: two on Run Club, one on the platform (no app_id; its
  // repository is the self-hosted app's, spelled with other case and .git).
  await report('app', run.id, 'acme', 'run-club', 11, 'Export runs to CSV', 1);
  await report('app', run.id, 'acme', 'run-club', 12, 'Bigger tap targets', 3);
  await report('platform', null, 'acme', 'platform', 21, 'Show times in my time zone', 9);
  // A platform report filed into some other repository is nobody's to list.
  await report('platform', null, 'acme', 'elsewhere', 22, 'Lost', 2);
  // From the board: one new request, and one the dialog also recorded.
  await boardIssue(run.id, 13, 'Route map on the run page', 5);
  await boardIssue(run.id, 11, 'Export runs to CSV (board copy)', 0);
  // Not mine, and not a request.
  await report('app', run.id, 'acme', 'run-club', 14, 'Someone else', 1, someone);
  await boardIssue(run.id, 15, 'Rename the app', 1, me, 'rename');

  // Standings: 11 is under way, 12 is waiting, 13 was closed by a vote,
  // and the platform's 21 shipped.
  await change(run.id, 'active', [11]);
  await change(run.id, 'archived', [12]);
  await change(self.id, 'merged', [21]);
  await pool.query(
    `INSERT INTO issues (app_id, title, kind, status, payload, created_by)
     VALUES ($1, 'Close #13', 'close_issue', 'closed', $2, $3)`,
    [run.id, JSON.stringify({ issueNumber: 13, appliedAt: new Date().toISOString() }), someone]);
  // A close proposal that never applied closes nothing.
  await pool.query(
    `INSERT INTO issues (app_id, title, kind, status, payload, created_by)
     VALUES ($1, 'Close #12', 'close_issue', 'closed', $2, $3)`,
    [run.id, JSON.stringify({ issueNumber: 12 }), someone]);

  const read = async (limit = profile.MY_REQUESTS_LIMIT) => profile.shapeRequests(
    (await pool.query(profile.MY_REQUESTS_SQL, [me, limit])).rows);

  await t.test('both ways in, once each, newest first, with where each one stands', async () => {
    const body = await read();
    assert.deepEqual(body.requests.map((r) => [r.number, r.appName, r.state]), [
      [11, 'Run Club', 'underway'],
      [12, 'Run Club', 'waiting'],
      [13, 'Run Club', 'closed'],
      [21, 'Homeroom', 'shipped'],
    ]);
    assert.equal(body.requests[0].title, 'Export runs to CSV', 'the first time it was asked names it');
    assert.equal(body.requests[3].appSlug, 'usernode-test', 'a platform request is the self-hosted app\'s');
    assert.equal(body.open, 2);
    assert.equal(body.done, 2);
    assert.equal(body.truncated, undefined);
  });

  await t.test('the counts are over the whole set when the list is cut short', async () => {
    const body = await read(2);
    assert.equal(body.requests.length, 2);
    assert.equal(body.open, 2);
    assert.equal(body.done, 2);
    assert.equal(body.truncated, true);
  });
});
