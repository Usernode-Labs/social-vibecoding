'use strict';

// The invite measure's window is applied BEFORE one row per invitee is
// picked (#4048). Against the REAL schema in a throwaway PostgreSQL
// database — schema.sql applied as the boot migration applies it — so what
// is tested is the SQL that ships: src/services/topochain/challenge-scorer.js
// INVITES_JOINED_SQL, read through loadCandidates the way the scoring tick
// reads it.
//
// The report this answers: somebody's counter stayed at "1/3 joined" though
// a person joined through their invite inside the challenge, because that
// person's first-ever invite was older than the window and the old SQL
// picked the first invite across all time before it looked at the window.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set — the same contract as tests/challenge-join-scoring-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const scorer = require('../src/services/topochain/challenge-scorer');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DAY = 24 * 3600 * 1000;

test('a join inside the window credits the inviter whose invite the person took inside it (#4048)', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'invites_joined_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function user(username) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, needs_communities_choice)
       VALUES ($1, 'x', TRUE, TRUE) RETURNING id`, [username]);
    return row;
  }
  async function app() {
    const n = ++seq;
    await pool.query(
      `INSERT INTO apps (name, slug, self_hosted, view_visibility, collab_visibility, status)
       VALUES ($1, $2, FALSE, 'public', 'public', 'running')`, [`App ${n}`, `app-${n}`]);
    const { rows: [row] } = await pool.query('SELECT * FROM apps WHERE slug = $1', [`app-${n}`]);
    return row;
  }
  // A link on one of the inviter's projects, followed and applied at the
  // given age: the first record of an invite taken.
  async function linkJoin(invitee, inviter, appliedAgo) {
    const a = await app();
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days') RETURNING id`,
      [`tok${crypto.randomBytes(8).toString('hex')}`, a.community_id, a.id, inviter.id]);
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at)
       VALUES ($1, $2, 'joined', NOW() - $3::interval)`, [invite.id, invitee.id, appliedAgo]);
  }
  // An invite accepted by username: the second record of an invite taken.
  async function accepted(appId, invitee, inviter, acceptedAgo) {
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES ($1, $2, 'member', $3, NOW() - $4::interval)`, [appId, invitee.id, inviter.id, acceptedAgo]);
  }

  const reporter = await user('reporter');
  const otherInviter = await user('other_inviter');
  const reporterApp = await app();
  const otherApp = await app();

  const ana = await user('ana'); // her first-ever invite predates the window; she took the reporter's inside it
  const sol = await user('sol'); // his only invite predates the window
  const pia = await user('pia'); // invited by both inviters inside the window
  const selfy = await user('selfy'); // "invited" themselves

  await linkJoin(ana, otherInviter, '90 days');
  await accepted(reporterApp.id, ana, reporter, '1 hour');
  await linkJoin(sol, otherInviter, '90 days');
  await accepted(reporterApp.id, pia, reporter, '2 hours');
  await accepted(otherApp.id, pia, otherInviter, '1 hour');
  await accepted(reporterApp.id, selfy, selfy, '1 hour');

  const out = await scorer.loadCandidates(pool, 'INVITES_JOINED',
    { startMs: Date.now() - DAY, endMs: Date.now() + DAY }, { target: 3 });

  assert.deepEqual(out.map((c) => [c.userId, c.sourceKey]), [
    [reporter.id, `invitee:${pia.id}`], // the earlier of the two in-window invites names pia's one inviter
    [reporter.id, `invitee:${ana.id}`], // #4048: the join she made inside the window credits the reporter
  ], 'in-window joins credit their inviter; the pre-window joins credit nobody');
  assert.ok(!out.some((c) => c.sourceKey === `invitee:${sol.id}`),
    'a person whose every invite was taken before the window still yields nothing');
  assert.ok(!out.some((c) => c.sourceKey === `invitee:${selfy.id}`),
    'a self-invite is still not a person brought in');
  assert.deepEqual(out.map((c) => c.description), ['@pia joined by your invite', '@ana joined by your invite']);
});