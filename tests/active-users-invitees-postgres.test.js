'use strict';

// Accepted invitees count as voters (src/services/active-users.js, concept
// #4 and the Private community floor) against the REAL schema in a
// throwaway PostgreSQL database. A person who accepted an invite in the last
// 10 days is in the electorate before they have used the app; after that
// they are not, unless the project is a Private community, which counts at
// least two once two people who can vote are in it. Self-hosted apps and
// test accounts on a real person's project are left out of both.
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set: the same contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('accepted invitees in the vote electorate, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'active_invitees_' + crypto.randomBytes(6).toString('hex');
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const activeUsers = require('../src/services/active-users');
  const { acceptInvite } = require('../src/services/collab-invites');

  let seq = 0;
  async function user({ testAccount = false } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, test_account_created_at)
       VALUES ($1, 'x', TRUE, CASE WHEN $2::boolean THEN NOW() END) RETURNING id, username`,
      [`voter_${n}`, testAccount]
    );
    return rows[0];
  }
  // A project as POST /api/apps leaves it: the creator a building member
  // whose row is stamped accepted. Private means a Private community once
  // somebody else is in it.
  async function project(creator, { view = 'private', collab = 'private', selfHosted = false } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [`Project ${n}`, `project-${n}`, creator.id, selfHosted, view, collab]
    );
    const appId = rows[0].id;
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member', accepted_at = NOW()`,
      [appId, creator.id]
    );
    return appId;
  }
  const invite = (appId, invitee, inviter) => pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'invited', $3)`,
    [appId, invitee.id, inviter.id]
  );
  const used = (appId, u) => pool.query(
    'INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)',
    [appId, u.id]
  );
  const acceptedDaysAgo = (appId, u, days) => pool.query(
    `UPDATE app_collaborators SET accepted_at = NOW() - make_interval(days => $3), created_at = NOW() - make_interval(days => $3 + 1)
      WHERE app_id = $1 AND user_id = $2`,
    [appId, u.id, days]
  );
  const ids = (list) => [...list].sort((x, y) => x - y);
  // Who the project is for, by the Workshop's own rule. The floor writes that
  // rule out as a constant, so each case pins the audience it relies on.
  const { audienceSql } = require('../src/services/communities');
  const audience = async (appId) => (await pool.query(
    `SELECT ${audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')} AS audience
       FROM apps a WHERE a.id = $1`, [appId]
  )).rows[0].audience;

  await t.test('an invitee who accepted and has not used the app is a voter, so two people need two votes', async () => {
    const creator = await user();
    const invitee = await user();
    const appId = await project(creator);
    await used(appId, creator);
    // Before anyone else is in, the creator alone is the electorate.
    assert.equal(await audience(appId), 'solo');
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 1);

    await invite(appId, invitee, creator);
    assert.equal(await audience(appId), 'invited', 'a pending invite already makes it a Private community');
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 1,
      'a pending invite is not a vote');
    assert.equal(await activeUsers.isUserActive(pool, appId, invitee.id), false);

    const accepted = await acceptInvite(pool, { appId, user: invitee });
    assert.equal(accepted.ok, true);
    const { rows: [row] } = await pool.query(
      'SELECT status, accepted_at FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [appId, invitee.id]
    );
    assert.equal(row.status, 'member');
    assert.ok(row.accepted_at, 'accepting stamps accepted_at, which is what the electorate reads');

    const stats = await activeUsers.getActiveUserStats(pool, appId);
    assert.deepEqual(stats, { active: 2, majority: 2 }, 'the invitee counts with no app activity');
    assert.equal(activeUsers.requiredVotes(stats.active, 0), 2, 'the creator\'s own Yes no longer merges alone');
    // The electorate the merge gate and the Workshop's approval rule read
    // (GET /api/apps/:slug/community): "2 yes votes (2 active members)".
    const governance = require('../src/services/governance');
    const electorate = await governance.getElectorate(pool, appId, await governance.getGovernance(pool, appId));
    assert.equal(electorate.active, 2);
    const gate = governance.computeGate(await governance.getGovernance(pool, appId), electorate.active, 1, 0,
      new Date(), new Date());
    assert.equal(gate.mergeable, false, 'one yes of two does not merge on the spot');
    assert.equal(gate.lazyArmed, true, 'it starts the wait instead');
    assert.deepEqual(ids(await activeUsers.listActiveUserIds(pool, appId)), ids([creator.id, invitee.id]),
      'and is asked for a vote');
    assert.equal(await activeUsers.isUserActive(pool, appId, invitee.id), true);
    assert.equal(await activeUsers.acceptedInviteRecently(pool, appId, invitee.id), true);
    assert.equal(await activeUsers.hasQualifyingActivity(pool, appId, invitee.id), false,
      'having accepted is not having tested the app');
  });

  await t.test('after 10 days the invite alone stops counting, and a Private community keeps its floor of two', async () => {
    const creator = await user();
    const invitee = await user();
    const appId = await project(creator);
    await used(appId, creator);
    await invite(appId, invitee, creator);
    await acceptInvite(pool, { appId, user: invitee });

    await acceptedDaysAgo(appId, invitee, 10);
    assert.equal(await activeUsers.acceptedInviteRecently(pool, appId, invitee.id), true, 'day 10 is still inside');

    await acceptedDaysAgo(appId, invitee, 11);
    await acceptedDaysAgo(appId, creator, 30);
    assert.equal(await audience(appId), 'invited');
    assert.equal(await activeUsers.acceptedInviteRecently(pool, appId, invitee.id), false);
    assert.equal(await activeUsers.isUserActive(pool, appId, invitee.id), false, 'no longer counted for themselves');
    assert.deepEqual(await activeUsers.listActiveUserIds(pool, appId), [creator.id], 'nor asked for a vote');
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 2,
      'but the Private community still counts two, so one person cannot merge alone');

    // The floor is the people who can vote, capped at two: a third member
    // does not raise it, and only real activity does.
    const third = await user();
    await invite(appId, third, creator);
    await acceptInvite(pool, { appId, user: third });
    await acceptedDaysAgo(appId, third, 20);
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 2);
    await used(appId, third);
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 2,
      'two who used the app; the floor neither adds to nor takes from a real count');
    await used(appId, invitee);
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 3);
  });

  await t.test('without the floor: a public project counts a recent invitee, then stops', async () => {
    const creator = await user();
    const member = await user();
    const appId = await project(creator, { view: 'public', collab: 'private' });
    await used(appId, creator);
    await invite(appId, member, creator);
    await acceptInvite(pool, { appId, user: member });
    assert.equal(await audience(appId), 'open');
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 2);
    await acceptedDaysAgo(appId, member, 11);
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 1,
      'a public community has no floor beyond one');
  });

  await t.test('a test account invited to a real person\'s project neither counts nor raises the floor', async () => {
    const creator = await user();
    const tester = await user({ testAccount: true });
    const appId = await project(creator);
    await used(appId, creator);
    await invite(appId, tester, creator);
    await acceptInvite(pool, { appId, user: tester });
    assert.equal(await audience(appId), 'invited');
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 1);
    await acceptedDaysAgo(appId, tester, 11);
    assert.equal((await activeUsers.getActiveUserStats(pool, appId)).active, 1,
      'the floor counts only people whose vote counts');
  });

  await t.test('a self-hosted app gets neither the invite rule nor the floor', async () => {
    const creator = await user();
    const invitee = await user();
    const appId = await project(creator, { view: 'private', collab: 'private', selfHosted: true });
    const before = await activeUsers.getActiveUserStats(pool, appId);
    const listedBefore = ids(await activeUsers.listActiveUserIds(pool, appId));
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [appId, invitee.id]
    );
    assert.equal(await activeUsers.acceptedInviteRecently(pool, appId, invitee.id), false);
    assert.equal(await activeUsers.isUserActive(pool, appId, invitee.id), false);
    assert.deepEqual(await activeUsers.getActiveUserStats(pool, appId), before,
      'the self-hosted union is activity on any app, and an invite adds nothing to it');
    assert.deepEqual(ids(await activeUsers.listActiveUserIds(pool, appId)), listedBefore);
    assert.equal(listedBefore.includes(invitee.id), false);
  });
});
