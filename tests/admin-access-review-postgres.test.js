'use strict';

// #5133: the Access review's SQL against the full PostgreSQL schema. The
// list carries every admin with the role it holds, when that role was set
// and by whom, the newest live session and the last completed database
// export; a review stores who did it and the list as it stood; and a role
// set through the console route lands in admin_role_changes.
// TEST_DATABASE_URL selects a local test database, like the other
// *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const { adminRoutes } = require('../src/routes/admin');
const review = require('../src/services/admin-access-review');

test('the access review reads admins, records reviews and notes role changes', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'admin_access_review_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const dbUrl = String(url);
  const config = { databaseUrl: dbUrl };
  const routePool = require('../src/db/pool').getPool(config);
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  const pool = new Pool({ connectionString: dbUrl, max: 8 });
  t.after(async () => {
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  await pool.query(schema);
  // Applying the schema a second time is what every boot does.
  await pool.query(schema);

  await pool.query(
    `INSERT INTO users (id, username, password, is_admin, admin_readonly) VALUES
       (1, 'review-full', 'not-a-login', TRUE, FALSE),
       (2, 'review-view', 'not-a-login', TRUE, TRUE),
       (3, 'review-member', 'not-a-login', FALSE, FALSE)`);
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES
       ('tok-live', 1, NOW() + INTERVAL '1 day', NOW() - INTERVAL '2 hours'),
       ('tok-older', 1, NOW() + INTERVAL '1 day', NOW() - INTERVAL '3 days'),
       ('tok-expired', 2, NOW() - INTERVAL '1 day', NOW() - INTERVAL '5 days')`);
  await pool.query(
    `INSERT INTO db_exports (user_id, username, db_name, status, requested_at) VALUES
       (1, 'review-full', 'usernode', 'completed', NOW() - INTERVAL '10 days'),
       (1, 'review-full', 'usernode', 'denied', NOW() - INTERVAL '1 day')`);

  // Nothing recorded yet: no role dates, never reviewed.
  let report = await review.report(pool);
  assert.deepEqual(report.admins.map((a) => [a.username, a.role]), [
    ['review-full', 'admin'],
    ['review-view', 'view_admin'],
  ]);
  const [full, view] = report.admins;
  assert.equal(full.roleSetAt, null);
  assert.ok(full.lastSignInAt, 'the newest live session');
  assert.ok(Date.now() - Date.parse(full.lastSignInAt) < 3 * 60 * 60 * 1000, 'is the 2-hour-old one');
  assert.ok(full.lastDatabaseExportAt, 'a completed export counts');
  assert.ok(Date.now() - Date.parse(full.lastDatabaseExportAt) > 9 * 24 * 60 * 60 * 1000, 'the denied one does not');
  assert.equal(view.lastSignInAt, null, 'an expired session is no sign-in');
  assert.equal(view.lastDatabaseExportAt, null);
  assert.equal(report.review.overdue, true);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, username: 'review-full', isAdmin: true, canAdminWrite: true, adminReadonly: false };
    next();
  });
  app.use(adminRoutes(config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  // The console's role setter notes the grant.
  let res = await post('/api/admin/users/3/is-admin', { role: 'view_admin' });
  assert.equal(res.status, 200);
  const { rows: changes } = await pool.query('SELECT user_id, role, changed_by FROM admin_role_changes');
  assert.deepEqual(changes, [{ user_id: 3, role: 'view_admin', changed_by: 1 }]);

  res = await post('/api/admin/access-review/reviews', { note: 'review-member added for support' });
  assert.equal(res.status, 200);
  report = await res.json();
  assert.equal(report.admins.length, 3);
  const member = report.admins.find((a) => a.username === 'review-member');
  assert.equal(member.role, 'view_admin');
  assert.equal(member.roleSetBy, 'review-full');
  assert.ok(member.roleSetAt);
  assert.equal(report.review.lastReviewedBy, 'review-full');
  assert.equal(report.review.note, 'review-member added for support');
  assert.equal(report.review.overdue, false);
  assert.equal(
    Date.parse(report.review.nextDueAt) - Date.parse(report.review.lastReviewedAt),
    90 * 24 * 60 * 60 * 1000);

  const { rows: [stored] } = await pool.query(
    'SELECT reviewed_by, full_admins, view_only_admins, admins FROM admin_access_reviews');
  assert.equal(stored.reviewed_by, 1);
  assert.equal(stored.full_admins, 1);
  assert.equal(stored.view_only_admins, 2);
  assert.deepEqual(stored.admins, [
    { id: 1, role: 'admin' }, { id: 2, role: 'view_admin' }, { id: 3, role: 'view_admin' },
  ]);

  // The reviewer's account going away keeps the review, without a name.
  await pool.query('UPDATE admin_access_reviews SET reviewed_by = NULL');
  report = await review.report(pool);
  assert.equal(report.review.lastReviewedBy, null);
  assert.ok(report.review.lastReviewedAt);

  // The note's limit is the database's too.
  await assert.rejects(
    pool.query('INSERT INTO admin_access_reviews (reviewed_by, note) VALUES (1, $1)', ['x'.repeat(501)]),
    /admin_access_reviews_note_check/);
});
