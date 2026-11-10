'use strict';

// #6547: GET /api/apps/:slug/merged counts three things over the whole merged
// history: this calendar week, the WHOLE week before it, and last week only
// up to this same point (last Monday 00:00 UTC to seven days before now).
// The Workshop's "live this week" compares against the third, so a Monday
// morning does not read as a fall against all of last week.
//
// The SQL runs against the REAL schema in a throwaway PostgreSQL database,
// through the real route, so the filter boundaries are the ones that ship.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/merged-week-counts-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the merged first page counts last week whole and up to this same point', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `merged_week_counts_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username],
  )).rows[0];
  const ada = await user('ada_week_counts');

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('week-counts', 'week-counts', 'running', $1, 'private', 'private', 'https://github.com/example/week-counts') RETURNING id`,
    [ada.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, ada.id]);
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [app.id, ada.id]);

  // Anchor everything to the server's own calendar week, the one the query
  // uses, so the test says what it means whatever day it runs. A live merge
  // is `status = 'merged' AND live_at IS NOT NULL`.
  const merged = async (when) => {
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, created_at, merged_at, live_at, branch_name, pr_number, pr_title)
       VALUES ($1, $2, 'merged', ${when}, ${when}, ${when}, $3, $4, 'Week count')`,
      [app.id, ada.id, `test/${crypto.randomBytes(4).toString('hex')}`, Math.floor(Math.random() * 1e6)],
    );
  };
  // This week: two changes.
  await merged(`date_trunc('week', now()) + interval '1 hour'`);
  await merged(`date_trunc('week', now()) + interval '2 hours'`);
  // Last week, before the same-point cutoff: one change.
  await merged(`date_trunc('week', now()) - interval '7 days' + interval '1 second'`);
  // Last week, after the same-point cutoff: two more.
  await merged(`date_trunc('week', now()) - interval '1 hour'`);
  await merged(`date_trunc('week', now()) - interval '2 hours'`);
  // The week before last: outside every window.
  await merged(`date_trunc('week', now()) - interval '8 days'`);

  const express = require('express');
  const { getPool } = require('../src/db/pool');
  const config = { databaseUrl: String(url) };

  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = { id: ada.id, username: ada.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(require('../src/routes/votes').voteRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(async () => {
    await new Promise((r) => listener.close(r));
    await getPool(config).end().catch(() => {});
  });
  const base = `http://127.0.0.1:${listener.address().port}`;

  const res = await fetch(`${base}/api/apps/${app.slug}/merged`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.shipped.week, 2, 'this week');
  assert.equal(body.shipped.prevWeek, 3, 'all of last week');
  assert.equal(body.shipped.prevWeekToDate, 1,
    'only last week up to this same point, not the two changes after it');
});
