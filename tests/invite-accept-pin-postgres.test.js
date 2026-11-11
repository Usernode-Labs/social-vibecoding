'use strict';

// Accepting an invite pins the project's COMMUNITY to Home, whichever way the
// invite was sent (src/services/collab-invites.js acceptInvite). One Home
// (#6361) pins a community and an app separately; joining pins the community.
//
// An invite LINK always pinned it: apply_community_invite() writes
// home_community_pins (one-home-pins.sql), as the Join button does
// (communities.join). An invite by @username, or by an email address once
// it is claimed (src/services/email-invites.js), is accepted through
// acceptInvite instead. The pin is not decoration: the daily vote digest
// (src/services/vote-digest.js PENDING_SQL) finds people through the
// app_stakes view (a member who keeps it on Home) and the creator, so a
// member added by name who was not pinned would never be told a vote was
// waiting on them.
//
// Against the REAL schema in a throwaway PostgreSQL database. Skipped when
// no server is reachable, and required when TEST_DATABASE_URL is set, like
// tests/communities-postgres.test.js. The first-run join screen accepts
// through the same function; tests/onboarding-postgres.test.js pins that its
// accepted invite is pinned too.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('accepting an invite pins the project, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'invite_pin_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // #5104: accounts start out reachable only by people they share a project
  // with, and out of searches. This file's people are strangers who write
  // to, invite and find each other, which is what it pins, so here they
  // start out open; tests/contact-privacy-postgres.test.js pins the defaults.
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone',
                                      ALTER COLUMN profile_discoverable SET DEFAULT TRUE`);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  // No live sockets or mail here: the pushes and the event are best-effort
  // and are not what is under test.
  require('../src/services/ws').pushNotificationToUser = () => {};
  require('../src/services/events').record = async () => {};
  require('../src/services/mail').sendProjectInviteMail = async () => {};
  const collabInvites = require('../src/services/collab-invites');
  const emailInvites = require('../src/services/email-invites');
  const { PENDING_SQL, MIN_GAP_HOURS } = require('../src/services/vote-digest');

  let seq = 0;
  async function user(fields = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, email, email_confirmed)
       VALUES ($1, 'x', TRUE, $2, $3) RETURNING id, username`,
      [`pin_${n}`, fields.email || null, !!fields.email]
    );
    return rows[0];
  }
  const owner = await user();
  const { rows: made } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility)
     VALUES ('Book club', 'book-club', $1, 'running', 'private', 'private') RETURNING id`,
    [owner.id]
  );
  const club = (await pool.query('SELECT * FROM apps WHERE id = $1', [made[0].id])).rows[0];
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
    [club.id, owner.id]);
  // A proposal waiting for a vote, written by the owner. #6402: the digest
  // finds one only once its checks passed; this file is about the invite's
  // pin, not the gate.
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, check_state)
     VALUES ($1, $2, 'promoted', 1, 'passing')`,
    [club.id, owner.id]
  );

  const pin = async (userId) => ((await pool.query(
    'SELECT 1 FROM home_community_pins WHERE community_id = $1 AND user_id = $2',
    [club.community_id, userId])).rowCount ? { pinned: true } : null);
  const appHidden = async (userId) => (await pool.query(
    'SELECT hidden FROM app_favorites WHERE app_id = $1 AND user_id = $2', [club.id, userId])).rows[0]?.hidden ?? null;
  const source = async (userId) => (await pool.query(
    'SELECT source FROM community_members WHERE community_id = $1 AND user_id = $2',
    [club.community_id, userId])).rows[0]?.source || null;
  const owed = async (userId) => {
    // 11 Nov 2026: the digest reads whether a change is open for votes off
    // its stored work state, derived once the drain has run.
    await require('./lib/work-states').settleWorkStates(pool);
    const row = (await pool.query(PENDING_SQL, [String(MIN_GAP_HOURS)])).rows
      .find((r) => Number(r.user_id) === Number(userId));
    return row ? Number(row.pending) : 0;
  };

  await t.test('accepting by @username pins the project, and the vote digest then finds them', async () => {
    const friend = await user();
    const sent = await collabInvites.sendInvite(pool, { app: club, target: friend, inviterId: owner.id });
    assert.equal(sent.ok, true);
    assert.equal(await pin(friend.id), null, 'a pending invite pins nothing');
    assert.equal(await owed(friend.id), 0, 'and is not yet asked for a vote');

    const accepted = await collabInvites.acceptInvite(pool, { appId: club.id, user: friend });
    assert.deepEqual(accepted, { ok: true, appSlug: club.slug });
    assert.deepEqual(await pin(friend.id), { pinned: true }, 'its community on Home, as an invite link would put it');
    assert.equal(await source(friend.id), 'collaborator',
      'the membership still says how they came in: the pin does not relabel it');
    assert.equal(await owed(friend.id), 1, 'the daily digest counts the proposal waiting on them');
  });

  await t.test('accepting pins the community and leaves an app opt-out alone', async () => {
    const quiet = await user();
    await collabInvites.sendInvite(pool, { app: club, target: quiet, inviterId: owner.id });
    await pool.query('INSERT INTO app_favorites (app_id, user_id, hidden) VALUES ($1, $2, TRUE)', [club.id, quiet.id]);
    await collabInvites.acceptInvite(pool, { appId: club.id, user: quiet });
    assert.deepEqual(await pin(quiet.id), { pinned: true });
    assert.equal(await appHidden(quiet.id), true, 'the app stays off Home: that pin is its own');
  });

  await t.test('a second accept is the idempotent answer and writes nothing', async () => {
    const twoTabs = await user();
    await collabInvites.sendInvite(pool, { app: club, target: twoTabs, inviterId: owner.id });
    await collabInvites.acceptInvite(pool, { appId: club.id, user: twoTabs });
    // Took the community off Home afterwards, as a member.
    await pool.query('DELETE FROM home_community_pins WHERE community_id = $1 AND user_id = $2', [club.community_id, twoTabs.id]);
    const again = await collabInvites.acceptInvite(pool, { appId: club.id, user: twoTabs });
    assert.deepEqual(again, { ok: true, appSlug: club.slug, alreadyMember: true });
    assert.equal(await pin(twoTabs.id), null, 'a stale tab does not put it back on Home');
  });

  await t.test('no invite, no pin', async () => {
    const stranger = await user();
    const refused = await collabInvites.acceptInvite(pool, { appId: club.id, user: stranger });
    assert.deepEqual(refused, { ok: false, status: 404, error: 'Invite not found' });
    assert.equal(await pin(stranger.id), null);
    assert.equal(await source(stranger.id), null);
  });

  await t.test('an invite sent by email is accepted the same way, and pinned the same way', async () => {
    const reader = await user({ email: 'reader@example.com' });
    const out = await emailInvites.inviteByEmail(pool, {}, {
      app: club, emails: ['Reader@Example.com'], inviter: owner,
    });
    assert.deepEqual(out, { invited: 1, mailed: 0 }, 'a confirmed address invites its account directly');
    await collabInvites.acceptInvite(pool, { appId: club.id, user: reader });
    assert.deepEqual(await pin(reader.id), { pinned: true });
    assert.equal(await owed(reader.id), 1);
  });
});
