'use strict';

// The Journey page's loops and next steps (#3369), against the real schema in
// a throwaway database: required when TEST_DATABASE_URL is set, skipped when
// no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const journey = require('../src/services/journey');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the change loop in turns, the invite loop, and next steps from navigation', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_loops_' + crypto.randomBytes(6).toString('hex');
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });

  const now = new Date('2026-10-07T12:00:00Z');
  const week = journey.parseWeek('2026-09-28', now);
  const user = async (username, cols = {}) => {
    const base = { has_platform_access: true, platform_access_granted_at: '2026-09-20T00:00:00Z', ...cols };
    const keys = Object.keys(base);
    return (await pool.query(
      `INSERT INTO users (username, password, ${keys.join(', ')})
       VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [username, ...keys.map((k) => base[k])])).rows[0].id;
  };
  const ana = await user('ana');
  const ben = await user('ben');
  const boss = await user('boss', { is_admin: true });
  const guest = await user('guest', { admitted_by: ana, platform_access_granted_at: '2026-09-29T10:00:00Z' });
  const app = (await pool.query(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ('Run Club', 'run-club', $1, 'running') RETURNING id", [ana])).rows[0].id;

  // Turn 7: ana's request, ben backs it, ben builds it, it goes live this week.
  const req7 = (await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by, created_at)
     VALUES ($1, 7, 'Dark mode', $2, '2026-09-25T10:00:00Z') RETURNING id`, [app, ana])).rows[0].id;
  await pool.query("INSERT INTO issue_votes (issue_id, user_id, vote, created_at) VALUES ($1, $2, 'up', '2026-09-26T10:00:00Z')", [req7, ben]);
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, created_at, promoted_at, merged_at)
     VALUES ($1, $2, 'merged', '{7}', '2026-09-27T10:00:00Z', '2026-09-28T10:00:00Z', '2026-09-30T10:00:00Z')`, [app, ben]);
  // Turn 8: ben's feedback, nobody has picked it up.
  await pool.query(
    `INSERT INTO feedback_reports (user_id, target, app_id, issue_number, title, description, created_at)
     VALUES ($1, 'app', $2, 8, 'Slow map', 'x', '2026-09-29T10:00:00Z')`, [ben, app]);
  // An admin's request is not a user's turn, and neither is a test account's.
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by, created_at)
     VALUES ($1, 9, 'Internal', $2, '2026-09-29T10:00:00Z')`, [app, boss]);
  const tess = await user('tess', { test_account_created_at: '2026-09-01T00:00:00Z' });
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by, created_at)
     VALUES ($1, 10, 'Trying it out', $2, '2026-09-30T10:00:00Z')`, [app, tess]);

  const loop = await journey.changeLoop(pool, { week, now });
  assert.deepEqual(loop.steps, ['notice', 'make_sense', 'sketch', 'decide', 'go_live', 'hear_back']);
  assert.deepEqual(loop.atStep.hear_back, { status: 'coming' }, 'Hear back is coming, never a number');
  assert.deepEqual(loop.turnsClosed, { status: 'coming' });
  assert.equal(loop.atStep.go_live, 1);
  assert.equal(loop.atStep.notice, 1);
  assert.deepEqual(loop.live.map((x) => [x.number, x.daysFromNotice, x.reporter.name]), [[7, 5, 'ana']]);
  assert.deepEqual(loop.open.map((x) => [x.number, x.step, x.holder, x.days]), [[8, 'notice', null, 8]],
    'open turns, oldest first, with nobody holding one that was never picked up');
  assert.deepEqual(loop.perProject, [{ slug: 'run-club', project: 'Run Club', thisWeek: 1, lastWeek: 0, alsoLastWeek: false }]);

  const invites = await journey.inviteLoop(pool, { week });
  assert.deepEqual(invites.counts, { invited: 1, arrived: 0, did_something: 0, invited_someone: 0 });
  assert.deepEqual(invites.pairs.map((p) => [p.host.name, p.invitee.name]), [['ana', 'guest']]);

  // Navigation: guest walks in circles; ana's delivery lost events, so her
  // path is left out rather than read as jumps.
  const nav = (userId, seconds, screen, via = 'own', kind = 'screen_visit') => pool.query(
    `INSERT INTO events (user_id, event_type, metadata, created_at)
     VALUES ($1, 'ui_experience', jsonb_build_object('kind', $3::text, 'screen', $4::text, 'via', $5::text, 'sequence', $2::int),
             '2026-10-01T10:00:00Z'::timestamptz + make_interval(secs => $2::int))`,
    [userId, seconds, kind, screen, via]);
  const path = ['home', 'discover', 'home', 'communities', 'home', 'messages', 'home', 'discover', 'home', 'profile'];
  for (let i = 0; i < path.length; i += 1) await nav(guest, i * 3, path[i]);
  await nav(ana, 0, 'home');
  await nav(ana, 5, 'discover');
  await pool.query(
    `INSERT INTO events (user_id, event_type, metadata, created_at)
     VALUES ($1, 'ui_telemetry_delivery', '{"batchId":"b1","droppedEvents":2}', '2026-10-01T10:01:00Z')`, [ana]);
  const steps = await journey.newcomerNextSteps(pool, { now });
  assert.equal(steps.people, 1);
  assert.deepEqual(steps.leftOut.droppedEvents, [ana], 'a gap in the data is never read as a move');
  const home = steps.rows.find((r) => r.screen === 'home');
  assert.equal(home.moves, 5);
  assert.equal(home.people, 1);
  assert.equal(steps.starts[0].screen, 'home');
  const { byPerson } = await journey.visitsFor(pool, {
    userIds: [guest], from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(journey.lostReading(byPerson.get(guest)[0]).possiblyLost, true);
});
