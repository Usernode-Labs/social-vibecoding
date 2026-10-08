'use strict';

// Unexpected errors (services/platform-incidents.js) against the full
// PostgreSQL schema: the admin page's filtered read, counts per kind per
// UTC day, the burst threshold alert, the daily digest, and the admin API
// route that serves them. TEST_DATABASE_URL selects a local test database,
// like the other *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('platform incidents: page read, burst alert and daily digest', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'incidents_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const incidents = require('../src/services/platform-incidents');
  const events = require('../src/services/events');

  const ada = (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id`,
  )).rows[0].id;
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url) VALUES ('Page Turners', 'page-turners', 'running', $1, 'https://github.com/x/pt') RETURNING id`,
    [ada],
  )).rows[0].id;
  const session = (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'merged') RETURNING id`,
    [app, ada],
  )).rows[0].id;

  // Full admins get the alerts; the read-only one does not.
  const insertAdmin = async (username, readonly) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_admin, admin_readonly) VALUES ($1, 'x', TRUE, TRUE, $2) RETURNING id`,
    [username, readonly],
  )).rows[0].id;
  const rootId = await insertAdmin('root', false);
  await insertAdmin('watcher', true);

  // One incident `hoursAgo` on the app, one without an app. Written straight
  // into events so created_at is exact.
  let n = 0;
  const incident = async ({ hoursAgo = 0, appId = app, sessionId = null, kind = 'build_interrupted', outcome = 'resumed', runId = null } = {}) => {
    n += 1;
    await pool.query(
      `INSERT INTO events (app_id, session_id, event_type, metadata, created_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW() - make_interval(hours => $5))`,
      [appId, sessionId, events.EVENT_TYPES.PLATFORM_INCIDENT,
        JSON.stringify({ kind, outcome, why: `reason ${n}`, ...(runId != null ? { runId } : {}), ...(sessionId ? { issueNumber: 41 } : {}) }), hoursAgo],
    );
  };

  // The page's read. Two days, two hoursAgo buckets, one old incident that
  // only the 30-day range sees (and which has no app).
  await incident({ hoursAgo: 2, sessionId: session, runId: 912 });
  await incident({ hoursAgo: 3 });
  await incident({ hoursAgo: 26, outcome: 'requeued', runId: 911 });
  await incident({ hoursAgo: 200, appId: null });

  await t.test('list(): items newest first, mapped and sanitised', async () => {
    const week = await incidents.list(pool, { days: 7 });
    assert.ok(week);
    assert.equal(week.days, 7);
    assert.equal(week.total, 3, 'the 200-hour incident is outside the week');
    assert.equal(week.items.length, 3);
    assert.deepEqual(week.items.map((i) => i.why), ['reason 1', 'reason 2', 'reason 3']);
    const first = week.items[0];
    assert.equal(first.kind, 'build_interrupted');
    assert.equal(first.app, 'page-turners');
    assert.equal(first.sessionId, session);
    assert.equal(first.runId, 912);
    assert.equal(first.issueNumber, 41);
    assert.equal(first.outcome, 'resumed');
    assert.equal(typeof first.at, 'string');
    const month = await incidents.list(pool, { days: 30 });
    const noApp = month.items.find((i) => i.why === 'reason 4');
    assert.ok(noApp);
    assert.equal(noApp.app, null, 'an incident with no app lists with none');
    assert.equal(noApp.sessionId, null);
  });

  await t.test('list(): daily groups by UTC day, newest first', async () => {
    const week = await incidents.list(pool, { days: 7 });
    assert.ok(week.daily.length >= 1 && week.daily.length <= 2, 'today and, if the hour straddles midnight UTC, yesterday');
    assert.equal(week.daily[0].counts.build_interrupted, week.daily[0].total);
    assert.equal(week.daily.reduce((s, d) => s + d.total, 0), 3);
  });

  await t.test('list(): days clamps to the ranges the page offers', async () => {
    const all = await incidents.list(pool, { days: 'banana' });
    assert.equal(all.days, 7);
    assert.equal(all.total, 3);
    const month = await incidents.list(pool, { days: 30 });
    assert.equal(month.days, 30);
    assert.equal(month.total, 4, 'the 200-hour incident is inside the month');
    const day = await incidents.list(pool, { days: 1 });
    assert.equal(day.total, 2, 'the 26-hour incident is outside 24 hours');
  });

  await t.test('list(): an unknown kind means all kinds; a known kind filters everything', async () => {
    const unknown = await incidents.list(pool, { kind: 'not_a_kind', days: 30 });
    assert.equal(unknown.kind, null);
    assert.equal(unknown.total, 4);
    const filtered = await incidents.list(pool, { kind: 'build_interrupted', days: 30 });
    assert.equal(filtered.kind, 'build_interrupted');
    assert.equal(filtered.total, 4);
    assert.equal(filtered.items.length, 4);
    assert.ok(filtered.kinds.some((k) => k.kind === 'build_interrupted' && k.label === 'Build interrupted' && k.n === 4));
    assert.ok(filtered.daily.every((d) => d.counts.build_interrupted > 0));
  });

  // ── The burst threshold alert ───────────────────────────────────────
  // deps injection: publish is a no-op, the creator is the real one (the
  // de-dupe lives in the notifications table, so it must be exercised).
  const deps = () => ({ publish: async () => {}, staging: false });
  const rowsOf = async () => (await pool.query(
    `SELECT user_id, detail FROM notifications WHERE kind = 'platform_incident' ORDER BY id`,
  )).rows;
  const detailsOf = async () => (await rowsOf()).map((r) => r.detail);
  const admins = async () => (await pool.query(
    `SELECT id FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE AND username <> 'root'`,
  )).rows.map((r) => r.id);

  await t.test('checkBurst: under the threshold sends nothing; the third sends once, to full admins only', async () => {
    const none = await incidents.checkBurst(pool, 'build_interrupted', deps());
    assert.equal(none.sent, false, 'nothing in the window yet');
    assert.equal(none.reason, 'below');
    assert.equal(incidents.BURST_THRESHOLD_DEFAULT, 3);
    await incident({ hoursAgo: 0 });
    const one = await incidents.checkBurst(pool, 'build_interrupted', deps());
    assert.equal(one.sent, false);
    assert.equal(one.count, 1);
    await incident({ hoursAgo: 0 });
    const two = await incidents.checkBurst(pool, 'build_interrupted', deps());
    assert.equal(two.sent, false, '2 is under the threshold');
    assert.equal((await detailsOf()).length, 0);
    await incident({ hoursAgo: 0 });
    const three = await incidents.checkBurst(pool, 'build_interrupted', deps());
    assert.equal(three.sent, true);
    assert.equal(three.count, 3);
    const details = await detailsOf();
    assert.deepEqual(details, ['burst:build_interrupted:3']);
    const recipients = await pool.query(`SELECT user_id FROM notifications WHERE kind = 'platform_incident'`);
    assert.deepEqual(recipients.rows.map((r) => r.user_id), [rootId], 'full admins only');
    const again = await incidents.checkBurst(pool, 'build_interrupted', deps());
    assert.equal(again.sent, false, 'the same kind does not page twice in the window');
    assert.equal(again.reason, 'dedupe');
    assert.equal((await detailsOf()).length, 1);
  });

  await t.test('checkBurst: an unknown kind is a no-op', async () => {
    const out = await incidents.checkBurst(pool, 'not_a_kind', deps());
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'kind');
  });

  await t.test('checkBurst: staging records nothing', async () => {
    await incident({ hoursAgo: 0 });
    const out = await incidents.checkBurst(pool, 'build_interrupted', { ...deps(), staging: true });
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'staging');
    assert.equal((await detailsOf()).length, 1, 'no second alert');
  });

  await t.test('record(): resolves even when the burst check rejects, and writes the row', async () => {
    // The burst check is chained after the insert and must never fail the
    // caller's outcome. A pool that throws on the advisory lock makes it
    // reject inside record()'s own catch.
    const flaky = {
      query(sql, params) {
        if (/pg_advisory_xact_lock/.test(sql)) return Promise.reject(new Error('lock failed'));
        return pool.query(sql, params);
      },
    };
    await assert.doesNotReject(() => incidents.record(flaky, {
      kind: 'build_interrupted', appId: app, sessionId: session,
      detail: { why: 'the worker is gone', outcome: 'resumed', runId: 913 },
    }));
    const { rows } = await pool.query(
      `SELECT metadata->>'why' AS why FROM events
        WHERE event_type = $1 AND metadata->>'runId' = '913'`,
      [events.EVENT_TYPES.PLATFORM_INCIDENT],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].why, 'the worker is gone');
  });

  // ── The daily digest ────────────────────────────────────────────────
  await t.test('digest: sends only in hour 9, once per day, and not on a quiet day', async () => {
    const offHour = await incidents.digest(pool, { now: new Date('2026-10-07T08:59:00Z') }, deps());
    assert.equal(offHour.sent, false);
    assert.equal(offHour.reason, 'hour');
    assert.equal((await detailsOf()).length, 1, 'only the burst alert so far');

    const atNine = await incidents.digest(pool, { now: new Date('2026-10-07T09:05:00Z') }, deps());
    assert.equal(atNine.sent, true, 'the past 24 hours logged incidents');
    assert.ok(atNine.total >= 1);
    const details = await detailsOf();
    assert.equal(details.length, 2);
    const digestToken = details.find((d) => d.startsWith('digest:'));
    assert.equal(digestToken, `digest:2026-10-07:${atNine.total}`);
    assert.ok(digestToken.length <= 32, 'the token stays inside varchar(32)');

    const again = await incidents.digest(pool, { now: new Date('2026-10-07T09:40:00Z') }, deps());
    assert.equal(again.sent, false);
    assert.equal(again.reason, 'dedupe');
    assert.equal((await detailsOf()).length, 2, 'one digest per day');

    const staging = await incidents.digest(pool, { now: new Date('2026-10-08T09:05:00Z') }, { ...deps(), staging: true });
    assert.equal(staging.sent, false);
    assert.equal(staging.reason, 'staging');
    assert.equal((await detailsOf()).length, 2);
  });

  await t.test('digest: a quiet day sends nothing', async () => {
    await pool.query(`DELETE FROM events WHERE event_type = $1`, [events.EVENT_TYPES.PLATFORM_INCIDENT]);
    const quiet = await incidents.digest(pool, { now: new Date('2026-10-09T09:05:00Z') }, deps());
    assert.equal(quiet.sent, false);
    assert.equal(quiet.reason, 'quiet');
    assert.equal(quiet.total, 0);
    assert.equal((await detailsOf()).length, 2);
  });

  // ── The admin route ─────────────────────────────────────────────────
  await t.test('GET /api/admin/incidents serves the page payload', async (st) => {
    // Seed again so the route has something to return, and mark two apps
    // with the "right now" signals.
    await incident({ hoursAgo: 1, sessionId: session, runId: 914 });
    await pool.query(
      `UPDATE apps SET release_stall = $2::jsonb WHERE id = $1`,
      [app, JSON.stringify({ since: '2026-10-07T00:00:00Z', kind: 'workflow' })],
    );
    await pool.query(
      `UPDATE apps SET status = 'error', last_failure = $2::jsonb WHERE id = $1`,
      [app, JSON.stringify({ stage: 'build', reason: 'boom', at: '2026-10-07T01:00:00Z' })],
    );

    // The gate is the router-level adminMiddleware; stand in for it so the
    // route itself runs as a full admin would reach it. The pool patch goes
    // in before the router is required, as the other *-postgres tests do.
    require('../src/db/pool').getPool = () => pool;
    const middleware = require('../src/middleware/admin');
    const realGate = middleware.adminMiddleware;
    middleware.adminMiddleware = (req, res, next) => {
      req.user = { id: ada, username: 'ada', is_admin: true, admin_readonly: false };
      next();
    };
    const { adminRoutes } = require('../src/routes/admin');
    const express = require('express');
    const appRouter = express();
    appRouter.use(adminRoutes({}));
    const server = appRouter.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    st.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      middleware.adminMiddleware = realGate;
      await pool.query(`UPDATE apps SET release_stall = NULL, status = 'running', last_failure = NULL WHERE id = $1`, [app]);
    });
    const port = server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/api/admin/incidents?kind=build_interrupted&days=7`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.days, 7);
    assert.equal(body.kind, 'build_interrupted');
    assert.equal(body.limit, 100);
    assert.equal(body.total, 1);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].app, 'page-turners');
    assert.equal(body.items[0].runId, 914);
    assert.ok(body.kinds.some((k) => k.kind === 'build_interrupted'));
    assert.ok(Array.isArray(body.daily) && body.daily.length === 1);
    assert.equal(body.daily[0].total, 1);
    assert.deepEqual(body.signals.releaseStalls.map((s) => s.slug), ['page-turners']);
    assert.deepEqual(body.signals.failedDeploys.map((s) => s.slug), ['page-turners']);
    assert.equal(body.signals.failedDeploys[0].stage, 'build');

    // An unknown kind means all kinds.
    const all = await fetch(`http://127.0.0.1:${port}/api/admin/incidents`);
    assert.equal(all.status, 200);
    const allBody = await all.json();
    assert.equal(allBody.kind, null);
    assert.equal(allBody.total, 1);
    assert.equal(allBody.items[0].sessionId, session);
  });
});