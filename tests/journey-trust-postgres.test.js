'use strict';

// The Journey page's trust checks (#3369), against the real schema in a
// throwaway database: required when TEST_DATABASE_URL is set, skipped when no
// server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const journey = require('../src/services/journey');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('live without a group vote, the team share, and possible lockstep', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_trust_' + crypto.randomBytes(6).toString('hex');
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });

  const week = journey.parseWeek('2026-09-21', new Date('2026-10-07T12:00:00Z'));
  const user = async (username, isAdmin = false, { bot = false, test = false } = {}) => (await pool.query(
    `INSERT INTO users (username, password, is_admin, is_synthetic, test_account_created_at)
     VALUES ($1, 'x', $2, $3, CASE WHEN $4::boolean THEN NOW() END) RETURNING id`,
    [username, isAdmin, bot, test])).rows[0].id;
  const ana = await user('ana');
  const ben = await user('ben');
  const boss = await user('boss', true);
  const ring = [];
  for (let i = 0; i < 3; i += 1) ring.push(await user(`ring${i}`));
  const app = (await pool.query(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ('Run Club', 'run-club', $1, 'running') RETURNING id", [ana])).rows[0].id;
  const change = async (author, mergedAt, issue = null) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, pr_number, created_from_issue_number)
     VALUES ($1, $2, 'merged', $3, 1, $4) RETURNING id`,
    [app, author, mergedAt, issue])).rows[0].id;
  const vote = (sessionId, userId, at) => pool.query(
    "INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', $3)", [sessionId, userId, at]);

  // ana: one change with ben's yes, one with only the team's yes (forced).
  const withGroup = await change(ana, '2026-09-22T10:00:00Z');
  await vote(withGroup, ben, '2026-09-22T08:00:00Z');
  const alone = await change(ana, '2026-09-23T10:00:00Z');
  await vote(alone, boss, '2026-09-23T09:00:00Z');
  await pool.query(
    `INSERT INTO events (user_id, session_id, event_type, metadata, created_at)
     VALUES ($1, $2, 'pr_merged', '{"forced":true}', '2026-09-23T10:00:00Z')`, [ana, alone]);
  // The team's own change.
  await change(boss, '2026-09-24T10:00:00Z');
  // Six changes the ring says yes to within two seconds of each other; ben
  // votes on the same changes hours later.
  for (let i = 0; i < 6; i += 1) {
    const c = await change(ana, `2026-09-25T1${i}:00:00Z`);
    for (let k = 0; k < ring.length; k += 1) await vote(c, ring[k], `2026-09-25T0${i}:00:0${k}Z`);
    await vote(c, ben, `2026-09-25T0${i}:30:00Z`);
  }

  // The Homeroom bot built two of ben's requests: one with ana's yes, one
  // nobody else said yes to. Both are ben's changes; the second went live
  // without the group. A test account's own change is nobody's.
  const bot = await user('homeroom_bot', false, { bot: true });
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 21, $2), ($1, 22, $2)', [app, ben]);
  const builtWithYes = await change(bot, '2026-09-26T10:00:00Z', 21);
  await vote(builtWithYes, ana, '2026-09-26T09:00:00Z');
  const builtAlone = await change(bot, '2026-09-26T11:00:00Z', 22);
  await vote(builtAlone, ben, '2026-09-26T10:30:00Z');
  const tester = await user('tess', false, { test: true });
  await change(tester, '2026-09-26T12:00:00Z');

  const trust = await journey.trustChecks(pool, { week });
  assert.equal(trust.withoutGroupVote.count, 2);
  assert.equal(trust.withoutGroupVote.of, 10, 'out of the live changes by real people, the bot\'s builds for them included');
  assert.equal(trust.withoutGroupVote.atLeastForced, 1);
  assert.deepEqual([...trust.withoutGroupVote.changes].sort((a, b) => a.author.localeCompare(b.author)), [
    { slug: 'run-club', project: 'Run Club', author: 'ana', forced: true },
    { slug: 'run-club', project: 'Run Club', author: 'ben', forced: false },
  ], 'the bot\'s build is credited to the person who asked, and their own yes is not the group\'s');
  assert.deepEqual(trust.teamShare, { team: 1, of: 11 }, 'a test account\'s change is not counted at all');
  assert.deepEqual(trust.lockstep.possible.map((p) => p.name).sort(), ['ring0', 'ring1', 'ring2'],
    'the accounts voting within seconds of each other, not ben who votes on the same changes later');
  assert.deepEqual(trust.lockstep.cutoffs, journey.LOCKSTEP_CUTOFFS);

  const left = await journey.trustChecks(pool, { week, leftOutIds: [ring[0]] });
  assert.deepEqual(left.lockstep.possible.map((p) => p.name).sort(), ['ring1', 'ring2'],
    'a left-out account is not a real person here either');
});
