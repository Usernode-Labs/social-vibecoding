// GET /api/me/summary — the Me page's three stat cards and "Your
// contributions", in one me-scoped read (src/routes/profile.js).
//
// The navigation prototype's Me leads with merged / kudos / challenges and
// closes with the viewer's recent merged proposals. #2740 deferred both
// because the numbers live in three subsystems and nothing added them up.
// This pins what each number MEANS, that the route is one round of reads
// the database can index, and that ?demo=1 fills a staging preview (whose
// chat_sessions are staging:private) without ever covering real data.
//
// Run with: node --test tests/me-summary.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

const profile = require('../src/routes/profile');

// ─── What each number means ─────────────────────────────────────────────

test('kudos is what the product calls kudos RECEIVED: direct PR kudos plus awarded bounties', () => {
  const summary = profile.shapeSummary({
    counts: { merged: 9, apps: 3, direct_kudos: 2, bounty_kudos: 1, member_since: '2026-03-04T10:00:00Z' },
    contributions: [],
    challenges: { done: 2, total: 7, season: { id: '3', name: 'Season 3' } },
  });
  assert.equal(summary.merged, 9);
  assert.equal(summary.apps, 3);
  assert.equal(summary.kudos, 3, 'the same two arms the Top users board adds up');
  assert.equal(summary.memberSince, '2026-03-04T10:00:00.000Z');
  assert.deepEqual(summary.challenges, { done: 2, total: 7, season: { id: 3, name: 'Season 3' } });
});

test('an account with nothing yet is zeros, not a failure', () => {
  const summary = profile.shapeSummary({ counts: undefined, contributions: undefined, challenges: null });
  assert.deepEqual(summary, {
    merged: 0, apps: 0, proposalsTotal: 0, inProgress: 0, kudos: 0, memberSince: null,
    challenges: { done: 0, total: 0, season: null },
    contributions: [],
    week: { weekStart: null, totalSeconds: 0, apps: [] },
  });
});

test('a contribution carries what its row needs to open it, and a title it can always show', () => {
  const base = {
    session_id: 41, pr_number: 213, pr_title: 'Messages as a tab', session_title: 'chat title',
    merged_at: '2026-09-20T10:00:00Z', created_at: '2026-09-01T10:00:00Z',
    app_slug: 'usernode-2d5619', app_name: 'Homeroom', icon_emoji: null, icon_image_id: null,
    self_hosted: true, kudos: '4',
  };
  assert.deepEqual(profile.shapeContribution(base), {
    sessionId: 41, prNumber: 213, title: 'Messages as a tab',
    appSlug: 'usernode-2d5619', appName: 'Homeroom', appIconEmoji: null, appIconUrl: null,
    platform: true, mergedAt: '2026-09-20T10:00:00.000Z', kudos: 4,
  });
  // The fallbacks, in order: the session's title, then the PR number.
  assert.equal(profile.shapeContribution({ ...base, pr_title: '  ' }).title, 'chat title');
  assert.equal(profile.shapeContribution({ ...base, pr_title: null, session_title: null }).title, 'Proposal #213');
  // A legacy merge with no merged_at is dated by when it started.
  assert.equal(profile.shapeContribution({ ...base, merged_at: null }).mergedAt, '2026-09-01T10:00:00.000Z');
  // The icon is only ever the platform's own /app-icons/<id> path.
  assert.equal(profile.shapeContribution({ ...base, icon_image_id: 'abc123' }).appIconUrl, '/app-icons/abc123');
  assert.equal(profile.shapeContribution({ ...base, icon_image_id: '../x' }).appIconUrl, null);
});

test('the SQL counts the viewer\'s own, authored, non-headless proposals and bounded rows', () => {
  const route = read('src/routes/profile.js');
  const counts = collapse(route.slice(route.indexOf('const SUMMARY_COUNTS_SQL'), route.indexOf('const SUMMARY_CONTRIBUTIONS_SQL')));
  // Counted once live (live_at): a merge still going live is in progress.
  assert.match(counts, /COUNT\(\*\) FILTER \(WHERE cs\.status = 'merged' AND cs\.live_at IS NOT NULL\)::int AS merged/);
  assert.match(counts, /WHERE cs\.user_id = \$1 AND cs\.is_headless = FALSE/,
    'auto sessions are not proposals anybody authored');
  assert.match(counts, /FROM pr_kudos pk JOIN chat_sessions ks ON ks\.id = pk\.session_id WHERE ks\.user_id = \$1/);
  assert.match(counts, /ib\.awarded_user_id = \$1 AND ib\.status = 'awarded'/);
  const list = collapse(route.slice(route.indexOf('const SUMMARY_CONTRIBUTIONS_SQL'), route.indexOf('const SELF_APP_SQL')));
  assert.match(list, /cs\.status = 'merged' AND cs\.live_at IS NOT NULL/);
  assert.match(list, /ORDER BY cs\.merged_at DESC NULLS LAST, cs\.id DESC LIMIT \$2/);
  assert.equal(profile.SUMMARY_CONTRIBUTIONS_LIMIT, 5);
});

// ─── The demo overlay ───────────────────────────────────────────────────

const SELF_APP = { slug: 'usernode-2d5619', name: 'Homeroom', icon_emoji: null, icon_image_id: null };
const EMPTY = profile.shapeSummary({ counts: {}, contributions: [], challenges: { done: 1, total: 9, season: { id: 1, name: 'S1' } } });

test('?demo=1 fills an EMPTY lower half, and never covers real data', () => {
  const demo = profile.withDemoSummary(EMPTY, SELF_APP, Date.parse('2026-09-23T00:00:00Z'));
  assert.equal(demo.demo, true);
  assert.equal(demo.merged, profile.DEMO_CONTRIBUTIONS.length);
  assert.equal(demo.contributions.length, profile.DEMO_CONTRIBUTIONS.length);
  assert.ok(demo.contributions.every((c) => c.appSlug === 'usernode-2d5619' && c.platform));
  assert.deepEqual(demo.challenges, EMPTY.challenges, 'challenge totals survive the clone and are never mocked');
  const real = { ...EMPTY, merged: 1, contributions: [{ sessionId: 5 }] };
  assert.equal(profile.withDemoSummary(real, SELF_APP), real, 'REAL DATA WINS');
  assert.equal(profile.withDemoSummary(EMPTY, null), EMPTY, 'no platform app, nothing to point the rows at');
});

test('each demo row opens the very merged mock it names', () => {
  // stagingMockMerged (src/routes/votes.js) serves these ids under the same
  // flag, so a demo row's link lands on a real proposal page in a preview.
  const votes = read('src/routes/votes.js');
  const mocks = votes.slice(votes.indexOf('function stagingMockMerged('));
  for (const row of profile.DEMO_CONTRIBUTIONS) {
    assert.ok(mocks.includes(String(row.sessionId)), `${row.sessionId} is a merged mock`);
    const title = row.title.replace(/^\[Mock\] /, '');
    assert.ok(mocks.includes(title.slice(0, 30)) || mocks.includes(row.title.slice(0, 40)),
      `"${row.title}" is that mock's title`);
  }
});

// ─── The route ──────────────────────────────────────────────────────────

function mockPool(state) {
  const calls = [];
  return {
    calls,
    async query(raw, params = []) {
      const sql = collapse(raw);
      calls.push({ sql, params });
      if (sql.includes('AS direct_kudos')) return { rows: [state.counts || {}] };
      if (sql.includes("cs.status = 'merged' AND cs.live_at IS NOT NULL ORDER BY cs.merged_at")) return { rows: state.contributions || [] };
      if (sql.includes('FROM apps WHERE self_hosted = TRUE')) return { rows: state.selfApp ? [state.selfApp] : [] };
      if (sql.includes('FROM app_activity aa')) return { rows: state.week || [] };
      if (sql.includes("WHERE view_visibility = 'public'")) return { rows: state.demoApps || [] };
      if (sql.includes('FROM seasons')) return { rows: state.season ? [state.season] : [] };
      if (sql.includes('COUNT(*)::int AS total')) return { rows: [state.totals || { total: 0, done: 0 }] };
      // The season's First challenges, read so a First challenge done counts
      // the way Home counts it (profile.js viewerDoneRule, 2026-10-01). None
      // here: the totals are DONE_EXPR's alone.
      if (sql.startsWith('/* challenge onboarding */')) return { rows: state.onboardingRows || [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

function makeApp(state, { user, env } = {}) {
  const pool = mockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  const originalEnv = process.env.USERNODE_ENV;
  poolModule.getPool = () => pool;
  if (env) process.env.USERNODE_ENV = env;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/profile')];
    routes = require('../src/routes/profile').profileRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
    if (env) {
      if (originalEnv === undefined) delete process.env.USERNODE_ENV;
      else process.env.USERNODE_ENV = originalEnv;
    }
    delete require.cache[require.resolve('../src/routes/profile')];
  }
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, pool };
}

async function get(app, url) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const USER = { id: 7, username: 'viewer' };

test('signed out is a 401, like every /api/me/* read', async () => {
  const { app } = makeApp({});
  assert.equal((await get(app, '/api/me/summary')).status, 401);
});

test('one round: the counts, the list and the season go out together, scoped to the session user', async () => {
  const { app, pool } = makeApp({
    counts: { merged: 2, apps: 1, direct_kudos: 3, bounty_kudos: 0, member_since: '2026-01-01T00:00:00Z' },
    contributions: [{ session_id: 9, pr_number: 1, pr_title: 'A', merged_at: '2026-09-01T00:00:00Z', app_slug: 'a', app_name: 'A', self_hosted: false, kudos: 1 }],
    season: { id: 1, name: 'Season 1' },
    totals: { total: 9, done: 4 },
  }, { user: USER });
  const { status, body } = await get(app, '/api/me/summary');
  assert.equal(status, 200);
  assert.equal(body.merged, 2);
  assert.equal(body.kudos, 3);
  assert.deepEqual(body.challenges, { done: 4, total: 9, season: { id: 1, name: 'Season 1' } });
  assert.equal(body.contributions[0].sessionId, 9);
  assert.ok(!('demo' in body), 'not a demo payload');
  const scoped = pool.calls.filter((c) => /AS direct_kudos|ORDER BY cs\.merged_at/.test(c.sql));
  assert.equal(scoped.length, 2);
  for (const c of scoped) assert.equal(c.params[0], 7, 'the SESSION user, never a query param');
});

test('?demo=1 is inert outside staging', async () => {
  const { app } = makeApp({ counts: {}, selfApp: SELF_APP }, { user: USER, env: 'production' });
  const { body } = await get(app, '/api/me/summary?demo=1');
  assert.equal(body.contributions.length, 0);
  assert.ok(!body.demo);
});

test('?demo=1 in staging fills an empty Me from the merged mocks', async () => {
  const { app } = makeApp({ counts: {}, selfApp: SELF_APP }, { user: USER, env: 'staging' });
  const { body } = await get(app, '/api/me/summary?demo=1');
  assert.equal(body.demo, true);
  assert.equal(body.contributions.length, profile.DEMO_CONTRIBUTIONS.length);
});

// ─── "This week" (#5964) ────────────────────────────────────────────────
//
// The apps the viewer was in since Monday and their minutes. It counts the
// SAME seconds USE_APPS_MINUTES scores and leaves out the same apps — an app
// the viewer made — so this total can never exceed the minutes challenge's
// own progress, which was the confusion the request described.

const { weekStartMs } = require('../src/services/topochain/challenge-rules');

test('the week SQL reads the same rows the minutes challenge scores, per app', () => {
  const week = collapse(profile.SUMMARY_WEEK_SQL);
  assert.match(week, /FROM app_activity aa JOIN apps a ON a\.id = aa\.app_id/);
  assert.match(week, /WHERE aa\.user_id = \$1 AND aa\.date >= \$2::date AND aa\.date <= \$3::date/);
  assert.match(week, /a\.created_by IS DISTINCT FROM aa\.user_id/, 'your own apps are left out, as the challenge leaves them out');
  assert.match(week, /GROUP BY a\.id, a\.slug, a\.name, a\.icon_emoji, a\.icon_image_id/);
  assert.match(week, /HAVING SUM\(aa\.seconds_spent\) > 0/);
  assert.match(week, /ORDER BY seconds DESC, a\.slug ASC/);
  assert.ok(!/LIMIT/.test(week), 'no LIMIT: the total in the heading covers every app');
  assert.equal(profile.SUMMARY_WEEK_APPS_LIMIT, 10);
});

test('shapeWeek sums every row into the total and caps only the list', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    slug: `app-${i}`, name: `App ${i}`, icon_emoji: i === 0 ? '🎨' : null,
    icon_image_id: i === 1 ? 'abc123' : null, seconds: String(600 - i * 10),
  }));
  const week = profile.shapeWeek(rows, Date.UTC(2026, 9, 26));
  assert.equal(week.weekStart, '2026-10-26T00:00:00.000Z');
  assert.equal(week.apps.length, profile.SUMMARY_WEEK_APPS_LIMIT, 'ten rows at most');
  assert.equal(week.totalSeconds, rows.reduce((n, r) => n + Number(r.seconds), 0), 'the total counts all twelve');
  assert.deepEqual(week.apps.slice(0, 2).map((a) => [a.slug, a.seconds]), [['app-0', 600], ['app-1', 590]],
    'the most used app comes first, as the query ordered them');
  assert.equal(week.apps[0].iconEmoji, '🎨');
  assert.equal(week.apps[1].iconUrl, '/app-icons/abc123');
});

test('a week with nothing in it is a zero and an empty list, never a failure', () => {
  assert.deepEqual(profile.shapeWeek([], Date.UTC(2026, 9, 26)), {
    weekStart: '2026-10-26T00:00:00.000Z', totalSeconds: 0, apps: [],
  });
  // And the summary always carries one, so the client never has to tell
  // "not computed" from "nothing this week".
  const summary = profile.shapeSummary({ counts: {}, contributions: [], challenges: null });
  assert.deepEqual(summary.week, { weekStart: null, totalSeconds: 0, apps: [] });
});

test('withDemoWeek fills only an empty week, and never covers real rows', () => {
  const empty = profile.shapeWeek([], Date.UTC(2026, 9, 26));
  const demoApps = [
    { slug: 'pixel-board', name: 'Pixel Board', icon_emoji: '🎨', icon_image_id: null },
    { slug: 'book-swap', name: 'Book Swap', icon_emoji: '📚', icon_image_id: 'x1' },
  ];
  const demo = profile.withDemoWeek(empty, demoApps);
  assert.equal(demo.demo, true);
  assert.equal(demo.apps.length, 2);
  assert.deepEqual(demo.apps.map((a) => a.seconds), profile.DEMO_WEEK_MINUTES.slice(0, 2).map((m) => m * 60));
  assert.equal(demo.totalSeconds, demo.apps.reduce((n, a) => n + a.seconds, 0));
  assert.equal(demo.weekStart, empty.weekStart, 'the week it fills is the real one');
  const real = profile.shapeWeek([{ slug: 'real', name: 'Real', seconds: 60 }], Date.UTC(2026, 9, 26));
  assert.equal(profile.withDemoWeek(real, demoApps), real, 'REAL DATA WINS');
});

test('the route asks for that Monday through today, for the session user', async () => {
  const { app, pool } = makeApp({
    counts: {},
    week: [{ slug: 'pixel-board', name: 'Pixel Board', icon_emoji: '🎨', icon_image_id: null, seconds: 840 }],
    season: null,
  }, { user: USER });
  const { status, headers, body } = await get(app, '/api/me/summary');
  assert.equal(status, 200);
  const call = pool.calls.find((c) => c.sql.includes('FROM app_activity aa'));
  assert.ok(call, 'the week is read in the summary round');
  assert.equal(call.params[0], 7, 'the SESSION user, never a query param');
  const now = Date.now();
  assert.equal(call.params[1], new Date(weekStartMs(now)).toISOString().slice(0, 10),
    'the week starts on Monday 00:00 UTC, the challenge\'s own boundary');
  assert.equal(call.params[2], new Date(now).toISOString().slice(0, 10));
  assert.equal(body.week.apps[0].slug, 'pixel-board');
  assert.equal(body.week.totalSeconds, 840);
  assert.match(headers.get('cache-control') || '', /no-store/,
    'per-viewer and now time-dependent: a shared cache would show one week to the next person');
});

test('?demo=1 fills the week from public apps the viewer did not make', async () => {
  const demoApps = [{ slug: 'pixel-board', name: 'Pixel Board', icon_emoji: '🎨', icon_image_id: null }];
  const { app, pool } = makeApp({ counts: {}, season: null, demoApps }, { user: USER, env: 'staging' });
  const { body } = await get(app, '/api/me/summary?demo=1');
  assert.equal(body.week.demo, true);
  assert.equal(body.week.apps[0].slug, 'pixel-board');
  const demoCall = pool.calls.find((c) => c.sql.includes("WHERE view_visibility = 'public'"));
  assert.equal(demoCall.params[0], 7, 'never the capture account\'s real usage, and nothing written to app_activity');
});

test('the week SQL really counts engaged seconds per app on a real database (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const { Pool } = require('pg');
    const crypto = require('node:crypto');
    const DSN = process.env.TEST_DATABASE_URL
      || process.env.DATABASE_URL
      || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2_000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
      return;
    }
    const name = `me_week_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 2 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    await pool.query(read('src/db/schema.sql'));

    const me = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('week_me', 'unused') RETURNING id`
    )).rows[0];
    const other = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('week_other', 'unused') RETURNING id`
    )).rows[0];
    const makeApp = async (slug, createdBy) => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, 'public', 'public') RETURNING id`, [slug, slug, createdBy]
    )).rows[0].id;
    const pixel = await makeApp('pixel-board', other.id);
    const mine = await makeApp('my-own-app', me.id);
    const used = await makeApp('used-once-last-week', other.id);
    const days = { monday: '2026-10-26', tuesday: '2026-10-27', lastSunday: '2026-10-25' };
    const put = (appId, date, seconds) => pool.query(
      `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, $3::date, $4)`,
      [appId, me.id, date, seconds]
    );
    await put(pixel, days.monday, 600);
    await put(pixel, days.tuesday, 300);
    await put(mine, days.tuesday, 9999);          // an app I made myself: left out
    await put(used, days.lastSunday, 500);        // before this Monday: out of the week

    const { rows } = await pool.query(profile.SUMMARY_WEEK_SQL, [me.id, days.monday, days.tuesday]);
    const week = profile.shapeWeek(rows, weekStartMs(Date.parse(`${days.tuesday}T12:00:00Z`)));
    assert.deepEqual(week.apps.map((a) => [a.slug, a.seconds]), [['pixel-board', 900]]);
    assert.equal(week.totalSeconds, 900);
    assert.equal(week.weekStart, '2026-10-26T00:00:00.000Z');
  });
