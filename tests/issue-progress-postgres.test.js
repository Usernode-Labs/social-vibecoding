'use strict';

// #6385: a person's posted plan is not work on the request, against the full
// PostgreSQL schema and through the real issue routes.
//
// Posting a plan (request-specs.js) writes a `chat_sessions` row with
// source 'request_spec', no branch, paused, linked to the request. The
// Wall/Workshop read counted it as somebody working on the request, so a
// request whose only activity was a plan said "You started working on this",
// offered Continue your work, and listed its author as building it to coding
// agents reading it through the connector.
//
// What is pinned here:
//   - GET /api/apps/:slug/github-issues reports no `in_progress` and no
//     `myPrSessionId` for a request whose only linked session is such a
//     record.
//   - issue-progress.js inProgressIssueNumbers (the Workshop's list) leaves
//     it out too, so the board and the request page agree.
//   - a planning record that carries a branch, because somebody started
//     building from it, still counts in both.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests; required when TEST_DATABASE_URL is set.
//
// Run with: node --test tests/issue-progress-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

// GitHub, answered in-process: one open request.
const github = require('../src/services/github');
const GH = [{
  number: 3, title: 'Request 3', body: '', labels: ['usernode'],
  updatedAt: '2026-10-03T10:00:00Z', htmlUrl: 'https://github.com/o/plant-pal/issues/3', user: 'someone',
}];
github.isEnabled = () => true;
github.fetchPublicIssues = async () => ({ issues: GH.map((i) => ({ ...i, state: 'open' })), truncatedList: false });
github.fetchPublicIssue = async () => ({ issue: { ...GH[0], state: 'open' } });

const { inProgressIssueNumbers } = require('../src/services/issue-progress');
const { issueRoutes } = require('../src/routes/issues');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `issue_progress_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const migrations = require('../src/db/schema-migrations');
  await migrations.applySchemaWithLockRetry(pool);
  try { await require('../src/db/reference-data').seedReferenceData(pool); } catch { /* none needed here */ }
  return pool;
}

test('a posted plan is not work in progress on a request', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [project] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('plant-pal', 'plant-pal', 'running', $1, 'https://github.com/o/plant-pal', 'public', 'public') RETURNING id`,
    [ada.id],
  );

  // The planning record a posted plan leaves behind (request-specs.js):
  // source 'request_spec', no branch, paused, linked to request 3.
  const { rows: [plan] } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, status, source, session_title, linked_issues, created_from_issue_number)
     VALUES ($1, $2, 'paused', 'request_spec', 'Plan for #3', '{3}'::int[], 3) RETURNING id`,
    [project.id, ada.id],
  );
  await pool.query(`UPDATE chat_sessions SET branch_name = NULL WHERE id = $1`, [plan.id]);

  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: ada.id, username: ada.username }; next(); });
  server.use(issueRoutes({}));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${listener.address().port}`;
  const board = async () => {
    const res = await fetch(`${base}/api/apps/plant-pal/github-issues`);
    assert.equal(res.status, 200);
    const { issues } = await res.json();
    return issues.find((i) => i.number === 3);
  };

  await t.test('the plan alone is neither in progress nor your session', async () => {
    const issue = await board();
    assert.equal(issue.in_progress, null, 'a posted plan is not work in progress');
    assert.equal(issue.myPrSessionId, null, 'and not the viewer\'s own session');
    assert.deepEqual([...await inProgressIssueNumbers(pool, project.id)], [],
      'the Workshop\'s list agrees');
  });

  await t.test('a planning record that carries a branch is real work', async () => {
    await pool.query(
      `UPDATE chat_sessions SET branch_name = 'dev/plan-3', status = 'active' WHERE id = $1`,
      [plan.id],
    );
    const issue = await board();
    assert.ok(issue.in_progress, 'started building from the plan counts');
    assert.equal(issue.in_progress.count, 1);
    assert.equal(issue.in_progress.mine, true);
    assert.equal(issue.myPrSessionId, plan.id, 'and Continue your work opens it');
    assert.deepEqual([...await inProgressIssueNumbers(pool, project.id)], [3]);
  });
});
