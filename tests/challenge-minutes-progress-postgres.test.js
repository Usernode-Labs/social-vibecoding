'use strict';

// #6463: the "Use apps for N minutes" challenge, counted for the person
// doing it, against the full schema.
//
// WHAT THIS PINS. The challenge page and Home's card read the viewer's
// minutes so far (`minutes` on each list row), and the app frame's timer
// reads GET /api/v4/me/minutes-challenge. Both come from minutesProgress,
// which must count exactly what the scorer pays for: time in apps the
// person did not make, inside the challenge's window (this week's slice of
// it on a weekly challenge). The suggested apps, up to three, are running
// public apps the viewer did not make: the most used this week, then the
// featured ones to fill, each app once.
//
// Run with: node --test tests/challenge-minutes-progress-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('minutes so far, the timer endpoint and the suggested apps (PostgreSQL)', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (error) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw error;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `minutes_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let listener = null;
  t.after(async () => {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  require('../src/db/pool').getPool = () => pool;

  const scorer = require('../src/services/topochain/challenge-scorer');
  const { suggestedApps } = require('../src/services/topochain/minutes-suggestion');

  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('mia', 'x'), ('maker', 'x'), ('other', 'x')
     RETURNING id, username`);
  const [mia, maker, other] = people;
  const app = async (slug, createdBy, fields = {}) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id, slug`,
    [fields.name || slug, slug, createdBy, fields.status || 'running', fields.view || 'public'])).rows[0];
  const puzzle = await app('daily-puzzle', maker.id, { name: 'Daily Puzzle' });
  const garden = await app('garden', maker.id, { name: 'Garden' });
  const mine = await app('mias-diary', mia.id, { name: 'Mia diary' });
  const hidden = await app('hidden', maker.id, { view: 'private' });
  const down = await app('down', maker.id, { status: 'error' });

  const time = (appId, userId, seconds, daysAgo = 0) => pool.query(
    `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
     VALUES ($1, $2, $3, CURRENT_DATE - $4::int)
     ON CONFLICT (app_id, user_id, date) DO UPDATE SET seconds_spent = EXCLUDED.seconds_spent`,
    [appId, userId, seconds, daysAgo]);

  // ── minutesProgress: the scorer's rows, for one person ──────────────
  await time(puzzle.id, mia.id, 120, 0);
  await time(garden.id, mia.id, 60, 1);
  await time(mine.id, mia.id, 900, 0); // her own app: never counts
  await time(puzzle.id, other.id, 400, 0); // somebody else's minutes
  await time(puzzle.id, mia.id, 300, 20); // before the window below
  const now = Date.now();
  const window = { startMs: now - 5 * 86400000, endMs: now + 5 * 86400000 };
  assert.deepEqual(await scorer.minutesProgress(pool, mia.id, window), { seconds: 180 },
    'two other people\'s apps, inside the window, without her own app or anyone else\'s time');
  assert.deepEqual(await scorer.minutesProgress(pool, mia.id, { startMs: null, endMs: null }), { seconds: 480 },
    'an open window counts all of it, as the scorer does');

  // The scorer agrees: at a 3-minute target she is a candidate with the
  // same seconds, at 4 minutes she is not.
  const at3 = await scorer.loadCandidates(pool, 'USE_APPS_MINUTES', window, { target: 3 });
  assert.equal(at3.filter((c) => Number(c.userId) === Number(mia.id)).length, 1);
  const at4 = await scorer.loadCandidates(pool, 'USE_APPS_MINUTES', window, { target: 4 });
  assert.equal(at4.filter((c) => Number(c.userId) === Number(mia.id)).length, 0);

  // ── The suggested apps: up to three ────────────────────────────────
  const chess = await app('chess', other.id, { name: 'Chess' });
  const cards = await app('cards', other.id, { name: 'Cards' });
  await pool.query("UPDATE apps SET icon_emoji = '♟' WHERE id = $1", [chess.id]);
  await pool.query("UPDATE apps SET icon_image_id = 'gardenicon' WHERE id = $1", [garden.id]);
  await time(garden.id, other.id, 2000, 2);
  await time(hidden.id, other.id, 9000, 0);
  await time(down.id, other.id, 9000, 0);
  await time(mine.id, other.id, 9000, 0);
  const slugsFor = async (userId) => (await suggestedApps(pool, userId)).map((a) => a.slug);
  assert.deepEqual(await slugsFor(mia.id), ['garden', 'daily-puzzle'],
    'most used first; never her own app, a private one or one not running; fewer than three is what there is');
  await pool.query('INSERT INTO featured_apps (app_id, sort_order) VALUES ($1, 2), ($2, 0), ($3, 1), ($4, 3)',
    [garden.id, chess.id, cards.id, mine.id]);
  assert.deepEqual(await slugsFor(mia.id), ['garden', 'daily-puzzle', 'chess'],
    'featured apps fill the rest, each app once, and never more than three');
  assert.deepEqual(await slugsFor(maker.id), ['mias-diary', 'chess', 'cards'],
    'for somebody else, the apps they did not make');
  const [first] = await suggestedApps(pool, mia.id);
  assert.deepEqual(first, { slug: 'garden', name: 'Garden', icon_url: '/app-icons/gardenicon', icon_emoji: null },
    'the icon as a server-built path');
  assert.deepEqual((await suggestedApps(pool, mia.id))[2],
    { slug: 'chess', name: 'Chess', icon_url: null, icon_emoji: '♟' }, 'or its emoji');
  await pool.query('DELETE FROM app_activity WHERE date > CURRENT_DATE - 7');
  assert.deepEqual(await slugsFor(mia.id), ['chess', 'cards', 'garden'],
    'with no recent use, the featured apps in the admin\'s order, without her own');
  await pool.query('DELETE FROM featured_apps');
  assert.deepEqual(await suggestedApps(pool, mia.id), [], 'nothing used and nothing featured: no suggestion');

  // ── The routes ─────────────────────────────────────────────────────
  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Season', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Season', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);
  const { rows: templates } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, task, reward) VALUES
       ('PERSISTENT', 'Use apps for 10 minutes', 'Use apps.', '200 pts'),
       ('WEEKLY', 'Use apps for 5 minutes this week', 'Use apps.', '100 pts'),
       ('PERSISTENT', 'Make a proposal', 'Propose.', '300 pts')
     RETURNING id, goal`);
  const tpl = (goal) => templates.find((r) => r.goal === goal).id;
  const challenge = async (goal, start = null, end = null) => Number((await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id, display_order, schedule_start, schedule_end)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`, [event.id, tpl(goal), start, end])).rows[0].id);
  const ten = await challenge('Use apps for 10 minutes',
    // Ends in a minute: sooner than any week, so it is the timer's pick
    // whatever day this runs.
    new Date(now - 10 * 86400000).toISOString(), new Date(now + 60000).toISOString());
  const weekly = await challenge('Use apps for 5 minutes this week');
  const proposal = await challenge('Make a proposal');
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_id, target, points) VALUES
       ('Ten', 'USE_APPS_MINUTES', $1, 10, 200),
       ('Five', 'USE_APPS_MINUTES', $2, 5, 100),
       ('Propose', 'PROPOSAL_SENT', $3, NULL, 300)`, [ten, weekly, proposal]);

  // Mia's time this run: 3 minutes in the last ten days, of which today's
  // 2 are this week, and her own app's time, which never counts.
  await time(puzzle.id, mia.id, 120, 0);
  await time(garden.id, mia.id, 60, 8);
  await time(mine.id, mia.id, 900, 0);

  let viewer = { id: mia.id, username: 'mia', isAdmin: false };
  const server = express();
  server.use((req, _res, next) => { if (viewer) req.user = viewer; next(); });
  server.use(require('../src/routes/topochain/public').topochainPublicRoutes({}));
  server.use(require('../src/routes/home-panels').homePanelRoutes({}));
  listener = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };

  await t.test('the list carries the viewer\'s minutes on a minutes challenge, and only there', async () => {
    const { status, body } = await get(`/api/v4/season-events/${event.id}/challenges`);
    assert.equal(status, 200);
    const row = (id) => body.data.find((r) => Number(r.id) === id);
    assert.deepEqual(row(ten).counted_by, { measure: 'USE_APPS_MINUTES', target: 10 },
      'the rule\'s minutes ride on counted_by too');
    assert.deepEqual(row(ten).minutes, { seconds: 180, target_seconds: 600, weekly: false, credited: false });
    assert.deepEqual(row(ten).suggested_apps,
      [{ slug: 'daily-puzzle', name: 'Daily Puzzle', icon_url: null, icon_emoji: null }],
      'the most used app this week she did not make');
    assert.deepEqual(row(weekly).minutes, { seconds: 120, target_seconds: 300, weekly: true, credited: false },
      'a weekly challenge counts this week only: eight days ago is never this week');
    assert.equal(row(proposal).minutes, undefined, 'no minutes on any other challenge');
    assert.equal(row(proposal).suggested_apps, undefined);
  });

  await t.test('signed out, the list carries no minutes', async () => {
    viewer = null;
    const { body } = await get(`/api/v4/season-events/${event.id}/challenges`);
    assert.equal(body.data.find((r) => Number(r.id) === ten).minutes, undefined);
    viewer = { id: mia.id, username: 'mia', isAdmin: false };
  });

  await t.test('Home\'s challenge rows carry the same minutes', async () => {
    const { body } = await get('/api/home-panels');
    const panel = body.panels.find((p) => p.key === 'challenges');
    const row = panel.challenges.find((c) => c.id === ten);
    assert.deepEqual(row.minutes, { seconds: 180, target_seconds: 600, weekly: false, credited: false });
  });

  await t.test('the timer endpoint: the soonest-ending open challenge, and whether this app counts', async () => {
    const { status, body } = await get('/api/v4/me/minutes-challenge?app=daily-puzzle');
    assert.equal(status, 200);
    assert.deepEqual(body.challenge, {
      challengeId: ten, eventId: Number(event.id), seconds: 180, targetSeconds: 600, weekly: false, counts: true,
    });
    const own = await get('/api/v4/me/minutes-challenge?app=mias-diary');
    assert.equal(own.body.challenge.counts, false, 'time in an app she made does not count');
    const unknown = await get('/api/v4/me/minutes-challenge?app=nope');
    assert.equal(unknown.body.challenge.counts, false);
  });

  await t.test('once a challenge\'s credit lands, the timer moves to the next one, then to none', async () => {
    await pool.query(
      `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, metadata, activity_at, challenge_id)
       VALUES ($1, $2, 'challenge_completion', 200, '{}'::jsonb, NOW(), $3)`, [mia.id, event.id, ten]);
    const list = await get(`/api/v4/season-events/${event.id}/challenges`);
    assert.equal(list.body.data.find((r) => Number(r.id) === ten).minutes.credited, true);
    const next = await get('/api/v4/me/minutes-challenge?app=daily-puzzle');
    assert.equal(next.body.challenge.challengeId, weekly);
    await pool.query(
      `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, metadata, activity_at, challenge_id)
       VALUES ($1, $2, 'challenge_completion', 100, '{}'::jsonb, NOW(), $3)`, [mia.id, event.id, weekly]);
    const none = await get('/api/v4/me/minutes-challenge?app=daily-puzzle');
    assert.deepEqual(none.body, { success: true, challenge: null });
  });

  await t.test('signed out, the timer endpoint answers 401', async () => {
    viewer = null;
    const { status } = await get('/api/v4/me/minutes-challenge?app=daily-puzzle');
    assert.equal(status, 401);
    viewer = { id: mia.id, username: 'mia', isAdmin: false };
  });
});
