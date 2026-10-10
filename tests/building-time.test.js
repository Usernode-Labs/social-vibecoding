'use strict';

// A person's own week of Homeroom bot building time, on Settings' "AI usage &
// models" page (services/building-time.js, GET /api/me/building-time,
// frontend/src/features/settings/building-time.tsx). Pinned here:
//
//   * shares of the week, never money: no amount and no cap leave the
//     server, a sliver says "Under 1%", and a week with no limit is shared
//     out of what was used;
//   * the allowance's own rule against the full schema: the charged runs
//     whose payer, else the requester, is the person, since Monday 00:00
//     UTC, one row per request, largest first, a request they asked the bot
//     to build for somebody else marked as such;
//   * the card as it renders, and the empty marker the shell prerenders;
//   * the route, its words and its declared check.
//
// Run with: node --test tests/building-time.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const buildingTime = require('../src/services/building-time');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CARD = 'frontend/src/features/settings/building-time.tsx';

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const row = (over) => ({ slug: 'bread', name: 'Bread', issue_number: 3, title: 'Rye', asked: false, runs: 1, usd: 1, ...over });

test('the week in shares of the person\'s building time, never money', () => {
  const week = buildingTime.weekView({
    capCents: 5000, spentCents: 3100, resetsAt: '2026-10-12T00:00:00.000Z',
    rows: [row({ usd: 15.5, runs: 3 }), row({ issue_number: 9, title: null, usd: 0.15, asked: true, slug: 'garden', name: 'Garden' })],
  });
  assert.deepEqual(week, {
    limited: true,
    usedShare: 0.62,
    usedUp: false,
    resetsAt: '2026-10-12T00:00:00.000Z',
    requests: [
      { app: { slug: 'bread', name: 'Bread' }, issueNumber: 3, title: 'Rye', share: 0.31, asked: false, runs: 3 },
      { app: { slug: 'garden', name: 'Garden' }, issueNumber: 9, title: null, share: 0.003, asked: true, runs: 1 },
    ],
    otherShare: 0.307,
  });
  assert.doesNotMatch(JSON.stringify(week), /usd|cents|\b5000\b|\b3100\b|15\.5/, 'no amount or cap leaves the server');
  const out = buildingTime.weekView({ capCents: 5000, spentCents: 5200, rows: [], resetsAt: null });
  assert.deepEqual([out.usedShare, out.usedUp], [1.04, true]);
  const free = buildingTime.weekView({ capCents: 0, spentCents: 400, rows: [row({ usd: 3 })], resetsAt: null });
  assert.deepEqual([free.limited, free.usedShare, free.usedUp, free.requests[0].share, free.otherShare], [false, null, false, 0.75, 0.25],
    'with no limit, a request\'s share is of what was used');
  const quiet = buildingTime.weekView({ capCents: 5000, spentCents: 0, rows: [], resetsAt: null });
  assert.deepEqual([quiet.usedShare, quiet.requests, quiet.otherShare], [0, [], 0]);
});

test('staging\'s demo week is obviously fake and marked as a demo', () => {
  const demo = buildingTime.demoWeek('2026-10-12T00:00:00.000Z');
  assert.equal(demo.demo, true);
  assert.ok(demo.requests.every((r) => r.title === null || r.title.startsWith('Staging demo')));
  assert.ok(demo.requests.some((r) => r.asked) && demo.requests.some((r) => r.share < 0.01), 'it shows a request asked for and a sliver');
});

test('the card: how much is used, when it resets, each request\'s share and where it is', () => {
  const { BuildingTimeView, percentOf, requestPath, buildingTimeUrl } = loadTsx(CARD);
  const week = buildingTime.demoWeek('2026-10-12T00:00:00.000Z');
  const html = renderToHtml(createElement(BuildingTimeView, { week, reset: { day: 'Sunday', time: '8:00 PM', utc: 'Mon, Oct 12, 00:00 UTC' } }));
  assert.match(html, /^<div class="mb-3" data-building-time="">/);
  assert.match(html, />Homeroom bot building time</);
  assert.match(html, /data-building-time-summary="">62% of this week&#x27;s building time used</);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="62"[\s\S]*?bg-\[color:var\(--lit-ink\)\]" style="width:62%"/);
  assert.match(html, /title="Mon, Oct 12, 00:00 UTC">Resets Sunday at 8:00 PM\.</);
  assert.deepEqual([...html.matchAll(/href="([^"]+)" data-building-time-request="([^"]+)"/g)].map((m) => [m[1], m[2]]), [
    ['#app/staging-demo/dev/issues/12', 'staging-demo#12'],
    ['#app/staging-demo/dev/issues/15', 'staging-demo#15'],
    ['#app/staging-garden/dev/issues/4', 'staging-garden#4'],
    ['#app/staging-garden/dev/issues/7', 'staging-garden#7'],
  ]);
  assert.match(html, />Staging demo: a dark mode for the board<[\s\S]*?>Staging demo board<[\s\S]*?>31%</);
  assert.match(html, />Staging demo garden · You asked for this</);
  assert.match(html, />Request #7<[\s\S]*?>Under 1%</, 'a request with no known title, and a sliver');
  assert.match(html, /data-building-time-demo="">Staging demo figures, not real numbers\.</);
  assert.doesNotMatch(html, /\$|&#x24;/, 'never money');

  const out = renderToHtml(createElement(BuildingTimeView, { week: { ...week, usedShare: 1.1, usedUp: true, demo: false }, reset: null }));
  assert.match(out, />You&#x27;ve used this week&#x27;s building time</);
  assert.match(out, /bg-\[color:var\(--state-attention\)\]" style="width:100%"/, 'used up: the attention ink, a full bar');
  assert.doesNotMatch(out, /Resets/, 'the reset waits for the viewer\'s clock');
  const none = renderToHtml(createElement(BuildingTimeView, { week: { ...week, usedShare: 0, requests: [], otherShare: 0, demo: false }, reset: null }));
  assert.match(none, />You haven&#x27;t used any building time this week</);
  const free = renderToHtml(createElement(BuildingTimeView, { week: { ...week, limited: false, usedShare: null, demo: false }, reset: null }));
  assert.match(free, />Your building time has no weekly limit</);
  assert.doesNotMatch(free, /role="progressbar"/);

  assert.deepEqual([percentOf(0.004), percentOf(0.31), percentOf(0)], [{ under: true, percent: 1 }, { under: false, percent: 31 }, { under: false, percent: 0 }]);
  assert.equal(requestPath('bread', 12), '#app/bread/dev/issues/12');
  assert.equal(buildingTimeUrl(true), '/api/me/building-time?demo=1');
});

test('the shell prerenders only an empty marker, so hydration has nothing to disagree with', () => {
  const { BuildingTime } = loadTsx(CARD);
  assert.equal(renderToHtml(createElement(BuildingTime)), '<div aria-hidden="true" class="h-px"></div>');
  const usage = read('frontend/src/features/settings/sections/usage.tsx');
  assert.ok(usage.indexOf('<AiBudgetRow />') < usage.indexOf('<BuildingTime />') && usage.indexOf('<BuildingTime />') < usage.indexOf('id="settings-spend"'),
    'under the AI allowance, above the own-key spend');
});

test('the route is the viewer\'s own, with a staging demo; its words are catalog entries; a check reads it', () => {
  const auth = read('src/routes/auth.js');
  const start = auth.indexOf("router.get('/api/me/building-time'");
  assert.ok(start > 0);
  const handler = auth.slice(start, auth.indexOf('router.post(', start));
  assert.match(handler, /if \(!req\.user\) return res\.status\(401\)/);
  assert.match(handler, /if \(IS_STAGING && req\.query\.demo === '1'\)/);
  assert.match(handler, /buildingTime\.weekFor\(pool, req\.user\.id\)/);
  const catalog = JSON.parse(read('frontend/locales/en/settings.json'));
  for (const key of ['title', 'used', 'usedUp', 'none', 'unlimited', 'resets', 'percent', 'underOne', 'untitled', 'askedFor', 'others', 'explainLimited', 'explainUnlimited', 'demo']) {
    const entry = catalog[`settings:usage.buildingTime.${key}`] || catalog[`usage.buildingTime.${key}`];
    assert.ok(entry && entry.text && entry.description, key);
  }
  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find((t) => t.path === '/?demo=1#settings/api-key' && /data-credits-remaining/.test(t.expectSelector || ''));
  assert.match(check.expectSelector, /\[data-building-time-request\]/, 'the AI-credit check also finds the building time card');
  assert.ok(check.expectSelector.length <= 256);
});

test('a person\'s week against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `building_time_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));

  const user = async (username) => (await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [username])).rows[0].id;
  const maya = await user('maya');
  const sam = await user('sam');
  const app = async (slug, label) => (await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility) VALUES ($1, $2, 'running', 'public', 'public') RETURNING id`, [label, slug],
  )).rows[0].id;
  const bread = await app('bread', 'Bread');
  const garden = await app('garden', 'Garden');
  for (const [appId, issue, who, title] of [[bread, 3, maya, 'Rye loaves'], [bread, 4, maya, 'Sourdough timer'], [garden, 8, sam, 'Water reminders']]) {
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)', [appId, issue, who, title]);
  }
  const weekStart = new Date(`${require('../src/services/limits').weekStartUtc()}T00:00:00Z`);
  const run = (appId, issue, { mode = 'live', charged = true, payer = null, read: r = 0.05, build = 1, at = new Date() } = {}) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, build_cost_usd, charged, payer_user_id, created_at)
     VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, $8)`,
    [appId, issue, mode, r, build, charged, payer, at],
  );
  await run(bread, 3, { build: 9.95 });                    // Maya's: $10
  await run(bread, 3, { build: 4.95 });                    // read again: $5, hers
  await run(bread, 4, { build: 1.95 });                    // $2
  await run(bread, 4, { mode: 'shadow', charged: false });  // a shadow build: nobody's
  await run(bread, 4, { charged: false, build: 20 });      // the bot's own fix: nobody's
  await run(garden, 8, { payer: maya, build: 2.95 });      // Sam's request, Maya asked: $3, hers
  await run(garden, 8, { build: 7.95 });                   // Sam's own: his
  await run(bread, 3, { build: 30, at: new Date(weekStart.getTime() - 60 * 1000) }); // last week

  const settings = { userWeeklyCents: 5000, adminWeeklyCents: 10000 };
  const week = await buildingTime.weekFor(pool, maya, { settings });
  const dm = require('../src/services/homeroom-bot-dm');
  assert.equal(await dm.weeklySpentCents(pool, maya), 2000, 'the allowance reads $20 of Maya\'s');
  assert.deepEqual([week.limited, week.usedShare, week.usedUp, week.otherShare], [true, 0.4, false, 0]);
  assert.deepEqual(week.requests.map((r) => [r.app.slug, r.issueNumber, r.title, r.share, r.asked, r.runs]), [
    ['bread', 3, 'Rye loaves', 0.3, false, 2],
    ['garden', 8, 'Water reminders', 0.06, true, 1],
    ['bread', 4, 'Sourdough timer', 0.04, false, 1],
  ]);
  assert.equal(week.resetsAt, new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
  const his = await buildingTime.weekFor(pool, sam, { settings });
  assert.deepEqual([his.usedShare, his.requests.map((r) => [r.issueNumber, r.asked])], [0.16, [[8, false]]],
    'Sam pays for his own run, not the one Maya asked for');
});
