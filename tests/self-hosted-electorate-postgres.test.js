'use strict';

// Homeroom's own vote denominator (a self-hosted app: the union of every
// app's activity, src/workflow/rules/electorate.ts) against the REAL schema
// in a throwaway PostgreSQL database. It checked each ACTIVITY ROW of the
// last 10 days, counts_toward_outcome included: 648 rows for 71 people,
// 300 ms a call and half of the platform's database time (22 Oct 2026). It
// now lists each person once and checks them, so the same people count.
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set: the same contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// The per-row query the count was before, kept as the reference: whoever it
// counted, the per-person one must count, and nobody else.
const PER_ROW_SQL = `SELECT DISTINCT a.user_id AS id
           FROM app_activity a
           WHERE a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )
             AND counts_toward_outcome(a.user_id, $1)
             AND EXISTS (
               SELECT 1 FROM apps ap
                WHERE ap.id = $1
                  AND (ap.community_id IS NULL OR EXISTS (
                    SELECT 1 FROM community_members cm
                     WHERE cm.community_id = ap.community_id AND cm.user_id = a.user_id
                  ))
             )`;

test('the self-hosted electorate, checked once per person', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'self_electorate_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const activeUsers = require('../src/services/active-users');
  const { SELF_HOSTED_PEOPLE_SQL } = require('../src/workflow/rules/electorate.ts');

  let seq = 0;
  async function user({ testAccount = false, platformAccess = true } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, test_account_created_at)
       VALUES ($1, 'x', $2, CASE WHEN $3::boolean THEN NOW() END) RETURNING id`,
      [`person_${n}`, platformAccess, testAccount]
    );
    return rows[0].id;
  }
  async function app(createdBy, selfHosted = false) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, 'public', 'public') RETURNING id`,
      [`App ${n}`, `app-${n}`, createdBy, selfHosted]
    );
    return rows[0].id;
  }
  // A day of use: `daysAgo` before today, for `seconds`.
  const used = (appId, userId, daysAgo, seconds) => pool.query(
    `INSERT INTO app_activity (app_id, user_id, date, seconds_spent)
     VALUES ($1, $2, CURRENT_DATE - $3::int, $4)`,
    [appId, userId, daysAgo, seconds]
  );
  const sorted = (list) => [...list].sort((x, y) => x - y);

  const founder = await user();
  const selfApp = await app(founder, true);
  const apps = [await app(founder), await app(founder), await app(founder)];

  // Every day of the window on every app: many rows, one person each.
  const regulars = [founder, await user(), await user()];
  for (const id of regulars) {
    for (const appId of apps) for (let d = 0; d <= 10; d++) await used(appId, id, d, 120);
  }
  // Used an app for a minute once, long ago, and only glanced in this week.
  const returning = await user();
  await used(apps[0], returning, 40, 300);
  await used(apps[1], returning, 2, 5);
  // Only glances, never a minute: no history with the platform.
  const glancer = await user();
  for (let d = 0; d <= 10; d++) await used(apps[0], glancer, d, 10);
  // A minute, but not in the last 10 days.
  const lapsed = await user();
  await used(apps[0], lapsed, 20, 600);
  // A test account on a real person's platform: never counted.
  const tester = await user({ testAccount: true });
  for (let d = 0; d <= 10; d++) await used(apps[2], tester, d, 120);

  const perRow = sorted((await pool.query(PER_ROW_SQL, [selfApp])).rows.map((r) => r.id));
  const listed = sorted(await activeUsers.listActiveUserIds(pool, selfApp));
  const stats = await activeUsers.getActiveUserStats(pool, selfApp);

  await t.test('the same people as the per-row query, and the count is theirs', () => {
    assert.deepEqual(listed, perRow);
    assert.equal(stats.active, Math.max(perRow.length, 1));
    assert.equal(stats.majority, Math.floor(stats.active / 2) + 1);
  });

  await t.test('who counts: recent use and a minute ever, a member, not a test account', () => {
    for (const id of [...regulars, returning]) assert.ok(listed.includes(id), `person ${id} counts`);
    for (const id of [glancer, lapsed, tester]) assert.equal(listed.includes(id), false, `person ${id} does not`);
  });

  await t.test('counts_toward_outcome runs once per person, not once per activity row', async () => {
    const recentRows = Number((await pool.query(
      'SELECT COUNT(*) AS n FROM app_activity WHERE date >= CURRENT_DATE - 10'
    )).rows[0].n);
    const people = Number((await pool.query(
      'SELECT COUNT(DISTINCT user_id) AS n FROM app_activity WHERE date >= CURRENT_DATE - 10'
    )).rows[0].n);
    assert.ok(recentRows > 3 * people, `${recentRows} rows for ${people} people: the case this is about`);
    const { rows: [{ 'QUERY PLAN': [plan] }] } = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT COUNT(*) AS cnt FROM ${SELF_HOSTED_PEOPLE_SQL} a`, [selfApp]
    );
    const checked = [];
    (function walk(node) {
      if (/counts_toward_outcome/.test(node.Filter || '')) checked.push(node);
      for (const child of node.Plans || []) walk(child);
    })(plan.Plan);
    assert.equal(checked.length, 1, 'one node applies the check');
    const [node] = checked;
    assert.equal(node['Node Type'], 'CTE Scan', 'the check filters the list of people');
    assert.equal(node['Actual Rows'] + (node['Rows Removed by Filter'] || 0), people,
      'it is evaluated for each person once');
  });
});
