'use strict';

// The Journey page's weekly readings (#3369): the seven stages, active groups
// with their lifecycle, the groups one short, and the navigation coverage
// line. Real schema in a throwaway database: required when TEST_DATABASE_URL
// is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('stages, groups and coverage for one finished week', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_week_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // The week under test: Monday 21 Sep 2026. Its next week ends 5 Oct.
  const now = new Date('2026-10-07T12:00:00Z');
  const week = journey.parseWeek('2026-09-21', now);
  const user = async (username, extra = {}) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_admin) VALUES ($1, 'x', TRUE, $2) RETURNING id`,
    [username, !!extra.admin])).rows[0].id;
  const [ana, ben, cy, dee, eve, boss] = [
    await user('ana'), await user('ben'), await user('cy'), await user('dee'), await user('eve'), await user('boss', { admin: true }),
  ];
  const app = async (slug, createdBy, selfHosted = false) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, self_hosted) VALUES ($1, $1, $2, 'running', $3) RETURNING id`,
    [slug, createdBy, selfHosted])).rows[0].id;
  const runClub = await app('run-club', ana);
  const tally = await app('tally', dee);
  const homeroom = await app('homeroom', boss, true);
  const change = async (appId, author, { merged = null, status = 'merged', promoted = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, promoted_at, pr_number, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, COALESCE($4, $5, NOW())) RETURNING id`,
    [appId, author, status, merged, promoted])).rows[0].id;
  const vote = (sessionId, userId, at, v = 'yes') => pool.query(
    'INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, $3, $4)', [sessionId, userId, v, at]);

  // Run Club is an active group in the week (ana's change, ben's yes) and was
  // one the week before too: still active.
  const c1 = await change(runClub, ana, { merged: '2026-09-23T10:00:00Z' });
  await vote(c1, ben, '2026-09-22T10:00:00Z');
  await vote(c1, ana, '2026-09-22T09:00:00Z');
  const c0 = await change(runClub, ben, { merged: '2026-09-16T10:00:00Z' });
  await vote(c0, ana, '2026-09-15T10:00:00Z');
  // Tally: dee merged alone this week (one short); last week dee and eve were
  // an active group there, so the group is not "went quiet" (it shows up in
  // one short) — and an older active week at Tally makes nothing "back".
  await change(tally, dee, { merged: '2026-09-24T10:00:00Z' });
  // Homeroom's own project is never counted as a group.
  const h = await change(homeroom, cy, { merged: '2026-09-25T10:00:00Z' });
  await vote(h, ana, '2026-09-25T09:00:00Z');
  // eve has a change waiting for anybody else's yes.
  await change(tally, eve, { status: 'promoted', promoted: '2026-09-24T12:00:00Z' });
  // An admin's yes does not make a group.
  const lone = await change(tally, dee, { merged: '2026-09-26T10:00:00Z' });
  await vote(lone, boss, '2026-09-26T09:00:00Z');

  // Stages: cy found Run Club this week (30 s+), ana came back to it,
  // eve gave feedback, ben's yes on ana's change is Belong.
  await pool.query(`INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES
    ($1, $2, 45, '2026-09-22'), ($1, $3, 10, '2026-09-10'), ($1, $3, 20, '2026-09-23'), ($1, $3, 5, '2026-09-29')`,
  [runClub, cy, ana]);
  await pool.query(
    "INSERT INTO feedback_reports (user_id, target, description, created_at) VALUES ($1, 'platform', 'x', '2026-09-24T10:00:00Z')",
    [eve]);
  await pool.query(
    `INSERT INTO events (user_id, event_type, metadata, created_at) VALUES
     ($1, 'ui_experience', '{"kind":"screen_visit","screen":"home","build":"abc1234"}', '2026-09-22T08:00:00Z'),
     ($1, 'ui_experience', '{"kind":"screen_visit","screen":"app_detail","build":"abc1234"}', '2026-09-22T08:01:00Z')`,
    [cy]);

  const s = await journey.stages(pool, { week, now });
  const by = Object.fromEntries(s.people.map((p) => [p.name, p]));
  assert.equal(by.boss, undefined, 'admins are not real people');
  assert.equal(by.cy.explore, true, 'found an app this week and stayed 30 seconds');
  assert.equal(by.ana.explore, true, 'came back to an app used on an earlier day');
  assert.equal(by.ana.use, true, 'a change of hers went live with ben\'s yes');
  assert.deepEqual(by.ana.activateKinds, ['change', 'vote'], 'her own change with a pull request, and a vote');
  assert.equal(by.ben.belong, true, 'he said yes to somebody else\'s change');
  assert.equal(by.eve.activate, true);
  assert.deepEqual(by.eve.activateKinds, ['change', 'feedback'], 'feedback, and the change she put to a vote');
  assert.equal(by.dee.use, false, 'an admin\'s yes does not make a change "used"');
  assert.equal(by.ana.stay, true, 'ana came back the next week');
  assert.equal(by.cy.stay, false);
  assert.equal(s.counts.use, 2, 'ana in Run Club and cy in Homeroom itself: Use is about the person, not the project');
  assert.equal(typeof s.counts.stay, 'number');

  const current = await journey.stages(pool, { week: journey.parseWeek('2026-10-05', now), now });
  assert.deepEqual(current.counts.stay, { recorded: false, reason: 'Known once the following week has ended.' },
    'Stay for an unfinished next week is "not known yet", never zero');

  const g = await journey.activeGroups(pool, { week, now });
  assert.equal(g.count, 1);
  assert.deepEqual(g.groups.map((x) => [x.slug, x.lifecycle, x.people.map((p) => p.name).sort()]),
    [['run-club', 'still_active', ['ana', 'ben']]]);
  assert.deepEqual(g.homeroom, { changes: 1, people: 2 }, 'Homeroom itself is reported, never counted');
  assert.deepEqual(g.oneShort.map((x) => [x.slug, x.people.map((p) => p.name)[0]]).sort(),
    [['tally', 'dee'], ['tally', 'eve']]);
  assert.deepEqual(g.wentQuiet, []);
  assert.equal(g.trend.length, journey.TREND_WEEKS, 'eight weeks of the North Star');
  assert.deepEqual(g.trend.at(-1), { week: '2026-09-21', count: g.count }, 'ending with the week shown');
  assert.equal(g.trend[0].week, '2026-08-03', 'oldest first, a Monday each');
  const before = await journey.activeGroups(pool, { week: journey.parseWeek('2026-09-14', now), now });
  assert.equal(g.trend.at(-2).count, before.count, 'each past week counts as that week would on its own');

  const quiet = await journey.activeGroups(pool, { week: journey.parseWeek('2026-09-28', now), now });
  assert.deepEqual(quiet.wentQuiet.map((x) => x.slug), ['run-club'], 'active last week, not this one');

  const full = await journey.activeGroups(pool, { week, now, trendAll: true });
  assert.equal(full.trend[0].week, '2026-09-14', 'all time starts at the week of the first live change');
  assert.equal(full.trend.at(-1).count, g.count);
  const mine = await journey.activeGroups(pool, { week, now, memberIds: new Set([cy]) });
  assert.equal(mine.count, 0, 'a cohort sees only the groups its members were in');

  const ever = await journey.stages(pool, { week: journey.allTime(now), now });
  const everBy = Object.fromEntries(ever.people.map((p) => [p.name, p]));
  assert.equal(ever.week, 'all');
  assert.equal(everBy.ana.stay, true, 'ana arrived two weeks in a row at some point');
  assert.equal(typeof ever.counts.stay, 'number');
  const narrowed = await journey.stages(pool, { week, now, memberIds: new Set([eve]) });
  assert.deepEqual(narrowed.people.map((p) => p.name), ['eve']);

  const left = await journey.activeGroups(pool, { week, now, leftOutIds: [ben] });
  assert.equal(left.count, 0, 'a left-out person does not make a group');

  const cov = await journey.coverage(pool, { week });
  assert.equal(cov.activePeople >= 4, true);
  assert.equal(cov.withNavigation, 1, 'only navigation screens count, not the failure journeys');
  assert.deepEqual(cov.byDay, [{ day: '2026-09-22', build: 'abc1234', rows: 1 }]);
});
