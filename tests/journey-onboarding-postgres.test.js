'use strict';

// The admin Journey's onboarding readings over the records already kept:
// the made screen and the maker's tour (journey.js madeScreenReading, from
// `first_session_moment`), a first version's stages and how it ended
// (firstVersionSummary, from `first_version_stage`, the build runs and the
// maker's telemetry), and what each maker asked for (the first version's
// brief, or the ready-made app). Real schema in a throwaway database:
// required when TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function freshDatabase(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = 'journey_onboarding_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const user = async (username, cols = {}) => {
    const base = { has_platform_access: true, ...cols };
    const keys = Object.keys(base);
    return (await pool.query(
      `INSERT INTO users (username, password, ${keys.join(', ')})
       VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [username, ...keys.map((k) => base[k])])).rows[0].id;
  };
  const app = async (slug, createdBy, createdAt) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, created_at)
     VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
    [slug.replace(/-/g, ' '), slug, createdBy, createdAt])).rows[0].id;
  const event = (type, { userId = null, appId = null, at, metadata = {} }) => pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`, [userId, appId, type, JSON.stringify(metadata), at]);
  return { pool, user, app, event };
}

const plus = (iso, seconds) => new Date(new Date(iso).getTime() + seconds * 1000).toISOString();

test('the made screen and the maker\'s tour: people per step, each card, and where the tour was left', { timeout: 120000 }, async (t) => {
  const db = await freshDatabase(t);
  if (!db) return;
  const { user, app, event } = db;
  const week = journey.parseWeek('2026-10-12', new Date('2026-10-20T00:00:00Z'));
  const moments = async (userId, appId, start, list) => {
    for (const [i, m] of list.entries()) {
      const [kind, detail] = Array.isArray(m) ? m : [m, {}];
      await event('first_session_moment', { userId, appId, at: plus(start, i * 10), metadata: { kind, ...detail } });
    }
  };
  const cards = (n) => Array.from({ length: n }, (_, i) => ['tour_step_shown', { step: i + 1, steps: 6 }]);
  const made = (entry = 'first_session') => ['made_shown', { entry }];

  // ana: the whole way, and the tour to its end.
  const ana = await user('ana');
  const anaApp = await app('ana-one', ana, '2026-10-13T09:00:00Z');
  await moments(ana, anaApp, '2026-10-13T09:00:00Z', [made(), 'questions_shown', ['submit_tapped', { count: 2 }],
    'invite_shown', 'share_invite_tapped', ['invite_sent', { how: 'shared' }], 'continue_tapped',
    ['tour_started', { steps: 6 }], ...cards(6), ['tour_ended', { step: 6, steps: 6, how: 'done' }]]);
  // Her second project, from Create: another made screen, not her first session's.
  const anaTwo = await app('ana-two', ana, '2026-10-14T09:00:00Z');
  await moments(ana, anaTwo, '2026-10-14T09:00:00Z', [made('create'), 'invite_shown', 'invite_later_tapped']);
  // ben: Invite later, then skips the tour on its second card.
  const ben = await user('ben');
  const benApp = await app('ben-one', ben, '2026-10-13T10:00:00Z');
  await moments(ben, benApp, '2026-10-13T10:00:00Z', [made(), 'invite_shown', 'invite_later_tapped', 'continue_tapped',
    ['tour_started', { steps: 6 }], ...cards(2), ['tour_ended', { step: 2, steps: 6, how: 'skipped' }]]);
  // cy: starts the tour and leaves on its first card, with no end recorded.
  const cy = await user('cy');
  const cyApp = await app('cy-one', cy, '2026-10-14T10:00:00Z');
  await moments(cy, cyApp, '2026-10-14T10:00:00Z', [made(), 'invite_shown', 'continue_tapped', ['tour_started', { steps: 6 }], ...cards(1)]);
  // Not counted: a made screen from Create only, a test account's, and one
  // the week before.
  const dot = await user('dot');
  await moments(dot, await app('dot-one', dot, '2026-10-13T11:00:00Z'), '2026-10-13T11:00:00Z', [made('create'), 'invite_shown']);
  const tester = await user('tester_9', { test_account_created_at: '2026-10-12T00:00:00Z' });
  await moments(tester, await app('tester-one', tester, '2026-10-13T12:00:00Z'), '2026-10-13T12:00:00Z', [made(), 'invite_shown']);
  const eve = await user('eve');
  await moments(eve, await app('eve-one', eve, '2026-10-06T12:00:00Z'), '2026-10-06T12:00:00Z', [made(), 'invite_shown']);

  const read = (await journey.firstSession(db.pool, { week })).made;
  assert.equal(read.people, 3, 'ana, ben and cy');
  assert.deepEqual(Object.fromEntries(read.steps.map((s) => [s.key, s.reached])), {
    made_shown: 3, questions_shown: 1, submit_tapped: 1, invite_shown: 3, share_invite_tapped: 1,
    invite_sent: 1, invite_later_tapped: 1, continue_tapped: 3, tour_started: 3,
  }, 'ana\'s Create screen does not lend her Invite later');
  assert.deepEqual(read.steps.map((s) => s.key), journey.MADE_STEPS, 'in the order the screen offers them');
  assert.equal(read.tour.started, 3);
  assert.deepEqual(read.tour.cards.map((c) => c.reached), [3, 2, 1, 1, 1, 1], 'how many saw each card');
  assert.equal(read.tour.done, 1);
  assert.deepEqual(read.tour.skipped, [{ step: 2, count: 1 }]);
  assert.deepEqual(read.tour.left, [{ step: 1, count: 1 }], 'started, no end recorded: left on the last card seen');

  // One cohort narrows it; the week before is not recorded.
  const narrowed = (await journey.firstSession(db.pool, { week, memberIds: new Set([ben]) })).made;
  assert.equal(narrowed.people, 1);
  const before = journey.parseWeek('2026-09-28', new Date('2026-10-20T00:00:00Z'));
  assert.deepEqual((await journey.firstSession(db.pool, { week: before })).made,
    journey.notRecorded('Not recorded before the made screen\'s moments were.'));

  // One person: their first session's made screen, moment by moment, never
  // their Create one.
  const p = await journey.person(db.pool, { userId: ben, now: new Date('2026-10-20T00:00:00Z') });
  assert.deepEqual(p.madeScreen.map((m) => m.kind), ['made_shown', 'invite_shown', 'invite_later_tapped', 'continue_tapped',
    'tour_started', 'tour_step_shown', 'tour_step_shown', 'tour_ended']);
  assert.deepEqual(p.madeScreen[p.madeScreen.length - 1], { kind: 'tour_ended', at: plus('2026-10-13T10:00:00Z', 70), how: 'skipped', step: 2, steps: 6 });
  const a = await journey.person(db.pool, { userId: ana, now: new Date('2026-10-20T00:00:00Z') });
  assert.equal(a.madeScreen[0].at, '2026-10-13T09:00:00.000Z', 'the first session\'s screen, not the later one');
});

test('first versions: each stage reached and its time, how each ended, and its maker when it went live', { timeout: 120000 }, async (t) => {
  const db = await freshDatabase(t);
  if (!db) return;
  const { pool, user, app, event } = db;
  const now = new Date('2026-10-15T12:00:00Z');
  const week = journey.parseWeek('2026-10-12', new Date('2026-10-20T00:00:00Z'));
  const firstVersion = (appId, userId, brief, issue = 1) => pool.query(
    "INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number) VALUES ($1, $2, $3, 'filed', $4)",
    [appId, userId, brief, issue]);
  const stages = async (appId, userId, start, secs) => {
    const order = ['plan_written', 'go_ahead', 'picked_up', 'spec_started', 'first_look_saved', 'build_started',
      'build_done', 'review_round', 'testing_started', 'merged', 'live'];
    for (const [i, sec] of secs.entries()) {
      await event('first_version_stage', { userId, appId, at: plus(start, sec), metadata: { stage: order[i] } });
    }
  };
  const run = (appId, cols) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok) VALUES ($1, 1, 'live', $2, $3)`,
    [appId, cols.verdict || 'ready', cols.buildOk ?? null]);
  const seen = (userId, at, appId = null, kind = 'screen_visit') => event('ui_experience', {
    userId, appId, at, metadata: { kind, screen: appId ? 'app' : 'home' } });

  // ana: live 1000 s after Make it; she was there, and opened it 300 s later.
  const ana = await user('ana');
  const A = '2026-10-13T09:00:00Z';
  const anaApp = await app('ana-one', ana, A);
  await firstVersion(anaApp, ana, '  A list of   the books\nour club wants to read.  ');
  await stages(anaApp, ana, A, [20, 90, 100, 105, 180, 190, 500, 510, 700, 900, 1000]);
  await run(anaApp, { buildOk: true });
  await seen(ana, plus(A, 1000 - 120));
  await seen(ana, plus(A, 1000 + 300), anaApp);
  // ben: its latest build run failed after the build started.
  const ben = await user('ben');
  const B = '2026-10-13T10:00:00Z';
  const benApp = await app('ben-one', ben, B);
  await firstVersion(benApp, ben, 'Plan our runs');
  await stages(benApp, ben, B, [20, 120, 130, 135, 200, 210]);
  await run(benApp, { buildOk: true });
  await run(benApp, { verdict: 'failed', buildOk: false });
  // cy: its plan waits on her.
  const cy = await user('cy');
  const cyApp = await app('cy-one', cy, '2026-10-14T09:00:00Z');
  await firstVersion(cyApp, cy, 'Keep score');
  await stages(cyApp, cy, '2026-10-14T09:00:00Z', [25]);
  // dee: picked up, then nothing for hours.
  const dee = await user('dee');
  const deeApp = await app('dee-one', dee, '2026-10-14T10:00:00Z');
  await firstVersion(deeApp, dee, 'Bird log');
  await stages(deeApp, dee, '2026-10-14T10:00:00Z', [20, 60, 80]);
  // eve: picked up ten minutes ago, still under way.
  const eve = await user('eve');
  const eveApp = await app('eve-one', eve, '2026-10-15T11:45:00Z');
  await firstVersion(eveApp, eve, 'Book swap');
  await stages(eveApp, eve, '2026-10-15T11:45:00Z', [20, 200, 300]);
  // fin: a ready-made app. Nothing for the bot to build; what was made is the template.
  const fin = await user('fin');
  const finApp = await app('fin-one', fin, '2026-10-14T12:00:00Z');
  await event('app_created', { userId: fin, appId: finApp, at: '2026-10-14T12:00:00Z', metadata: { template: 'tally', from: 'first-session' } });

  const path = await journey.creationPath(pool, { week, now });
  const fv = path.firstVersion;
  assert.equal(fv.of, 5, 'the five the bot builds; the ready-made app has no first version to build');
  assert.deepEqual(fv.outcomes, { live: 1, failed: 1, stalled: 1, waiting: 1, building: 1 });
  assert.deepEqual(fv.stoppedAt, [{ key: 'plan_written', count: 1 }, { key: 'picked_up', count: 2 }, { key: 'build_started', count: 1 }],
    'where the ones not live are, in pipeline order');
  const stage = Object.fromEntries(fv.stages.map((s) => [s.key, s]));
  assert.deepEqual([stage.plan_written.reached, stage.go_ahead.reached, stage.build_started.reached, stage.live.reached], [5, 4, 2, 1]);
  assert.deepEqual([stage.live.medianFromStart, stage.live.medianFromPrevious], [1000, 100]);
  assert.deepEqual([stage.go_ahead.medianFromPrevious], [85], 'the median of 70, 100, 40 and 180');
  assert.deepEqual(fv.maker, { live: 1, nearLive: 1, cameBack: 1, medianBackSeconds: 300 });
  assert.deepEqual([fv.stallMinutes, fv.nearMinutes], [journey.STALL_MINUTES, journey.LIVE_NEAR_MINUTES]);
  assert.ok(fv.from, 'counted from the first stage on record');

  const ex = Object.fromEntries(path.examples.map((e) => [e.slug, e]));
  assert.equal(ex['ana-one'].asked, 'A list of the books our club wants to read.', 'one line, as typed');
  assert.deepEqual(ex['ana-one'].firstVersion, { recorded: true, outcome: 'live', last: 'live' });
  assert.deepEqual(ex['ben-one'].firstVersion, { recorded: true, outcome: 'failed', last: 'build_started' });
  assert.deepEqual([ex['fin-one'].asked, ex['fin-one'].template, ex['fin-one'].firstVersion], [null, 'tally', null]);

  // A project made before the stages were recorded is not counted as a no.
  const early = journey.parseWeek('2026-10-05', new Date('2026-10-20T00:00:00Z'));
  const oldApp = await app('old-one', ana, '2026-10-06T09:00:00Z');
  await firstVersion(oldApp, ana, 'Old');
  assert.deepEqual((await journey.creationPath(pool, { week: early, now })).firstVersion,
    { from: fv.from, ...journey.notRecorded('Not recorded for first versions started before their stages were first recorded.') });

  // One person: what they made, what they asked for, and how it went.
  const p = await journey.person(pool, { userId: ben, now });
  assert.equal(p.made.length, 1);
  assert.deepEqual([p.made[0].slug, p.made[0].asked, p.made[0].firstVersion.outcome, p.made[0].firstVersion.last],
    ['ben-one', 'Plan our runs', 'failed', 'build_started']);
  const a = await journey.person(pool, { userId: ana, now });
  assert.deepEqual(a.made.map((m) => m.slug), ['ana-one', 'old-one'], 'newest first');
  assert.deepEqual([a.made[0].firstVersion.nearLive, a.made[0].firstVersion.backSeconds], [true, 300]);
  assert.deepEqual([a.made[1].firstVersion.recorded, a.made[1].firstVersion.outcome], [false, null],
    'made before stages were recorded, with none on record: not recorded, never stalled');
});
