'use strict';

// The Journey page's trust checks (#3369), against the real schema in a
// throwaway database: required when TEST_DATABASE_URL is set, skipped when no
// server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('live without a group vote, the team share, and possible lockstep', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_trust_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const week = journey.parseWeek('2026-09-21', new Date('2026-10-07T12:00:00Z'));
  const user = async (username, isAdmin = false) => (await pool.query(
    "INSERT INTO users (username, password, is_admin) VALUES ($1, 'x', $2) RETURNING id", [username, isAdmin])).rows[0].id;
  const ana = await user('ana');
  const ben = await user('ben');
  const boss = await user('boss', true);
  const ring = [];
  for (let i = 0; i < 3; i += 1) ring.push(await user(`ring${i}`));
  const app = (await pool.query(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ('Run Club', 'run-club', $1, 'running') RETURNING id", [ana])).rows[0].id;
  const change = async (author, mergedAt) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, pr_number) VALUES ($1, $2, 'merged', $3, 1) RETURNING id`,
    [app, author, mergedAt])).rows[0].id;
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

  const trust = await journey.trustChecks(pool, { week });
  assert.equal(trust.withoutGroupVote.count, 1);
  assert.equal(trust.withoutGroupVote.of, 8, 'out of the live changes by real people');
  assert.equal(trust.withoutGroupVote.atLeastForced, 1);
  assert.deepEqual(trust.withoutGroupVote.changes, [{ slug: 'run-club', project: 'Run Club', author: 'ana', forced: true }]);
  assert.deepEqual(trust.teamShare, { team: 1, of: 9 });
  assert.deepEqual(trust.lockstep.possible.map((p) => p.name).sort(), ['ring0', 'ring1', 'ring2'],
    'the accounts voting within seconds of each other, not ben who votes on the same changes later');
  assert.deepEqual(trust.lockstep.cutoffs, journey.LOCKSTEP_CUTOFFS);

  const left = await journey.trustChecks(pool, { week, leftOutIds: [ring[0]] });
  assert.deepEqual(left.lockstep.possible.map((p) => p.name).sort(), ['ring1', 'ring2'],
    'a left-out account is not a real person here either');
});
