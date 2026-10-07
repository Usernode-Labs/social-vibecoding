'use strict';

// An invite by @username is the same way in as an invite link.
//
// First-session run-through, 5 October 2026: alex_t1005 made "Page Turners"
// (a Group: only its people can see it, so being invited in is how anybody
// joins it). priya came in by the link and got the invite page, "You're in"
// and the tour. mo was invited by username from the same sheet, and:
//
//   1. the maker was told nothing when it went (routes/collaborators.js now
//      answers a refusal with a `code` the sheet words: unknown_user, …);
//   3. the sheet's rule line said "With one other person using it" with
//      priya in and mo invited (community-invites.js joiningRule now counts
//      the vote's own headcount plus the invites still waiting);
//   4. mo's notification said "invited you to build", with no note and no
//      headcount (the invite now carries the maker's note, and the pending
//      invite and its notification say it is an invitation to join);
//   5. Accept dropped mo in the chat (the accept now answers with what
//      "You're in" needs, the welcome the link path ends on).
//
// Against the REAL schema in a throwaway PostgreSQL database, through the
// real routes. Skipped when no server is reachable, and required when
// TEST_DATABASE_URL is set, like tests/invite-accept-pin-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('an invite by username joins a group the way its link does, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'username_invite_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  // pool.end() resolves once its idle connections are handed their end, not
  // once their sockets close, so the teardown's DROP DATABASE ... WITH
  // (FORCE) can reach one still closing. The server then terminates it
  // (57P01) and the pool re-emits that as 'error'. src/db/pool.js listens
  // and logs it; this pool did not, so it surfaced as an uncaughtException
  // that failed the file on its teardown (5 of 6 runs). Expected here.
  pool.on('error', () => {});
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const config = {
    databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true,
    challengeScorer: { intervalMinutes: 0 },
  };
  const { getPool } = require('../src/db/pool');
  t.after(async () => {
    await getPool(config).end().catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  // No live sockets here: the pushes and the events are best-effort and are
  // not what is under test.
  require('../src/services/ws').pushNotificationToUser = () => {};
  require('../src/services/events').record = async () => {};
  const invites = require('../src/services/community-invites');
  const notifications = require('../src/services/notifications');
  const communities = require('../src/services/communities');

  async function user(username, { displayName = null, daysOld = 0 } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password, has_platform_access, created_at)
       VALUES ($1, $2, 'x', TRUE, NOW() - make_interval(days => $3)) RETURNING id, username`,
      [username, displayName, daysOld]
    );
    return rows[0];
  }
  async function project(slug, { createdBy, view = 'private', collab = 'private' }) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility, icon_emoji)
       VALUES ($1, $2, $3, 'running', $4, $5, '📚') RETURNING id`,
      [slug === 'page-turners' ? 'Page Turners' : slug, slug, createdBy, view, collab]
    );
    // What POST /api/apps writes for its maker (routes/apps.js).
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [rows[0].id, createdBy]
    );
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  }

  const alex = await user('alex_t1005');
  const priya = await user('priya_t1006');
  // An account that was there before the invite, as mo_t1006 was.
  const mo = await user('mo_t1006', { daysOld: 2 });
  const turners = await project('page-turners', { createdBy: alex.id });

  const express = require('express');
  const { collaboratorRoutes } = require('../src/routes/collaborators');
  const communityInviteRoutes = require('../src/routes/community-invites');
  const server = express();
  server.use(express.json());
  let as = null;
  server.use((req, _res, next) => {
    req.user = { id: as.id, username: as.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(collaboratorRoutes(config));
  server.use(communityInviteRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (who, method, p, body) => {
    as = who;
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const rule = async () => (await call(alex, 'GET', `/api/apps/${turners.slug}/invite-links`)).body.joiningRule;

  await t.test('3. the rule line counts the people in it, and the invites still waiting', async () => {
    assert.equal(await rule(),
      'With one other person using it, a change goes live when you both say yes, '
      + 'or 3 days after one of you says yes if the other doesn\'t answer.',
      'alone in it: the maker and the first person they bring');

    // priya follows the maker's link.
    const link = await invites.createInvite(pool, { app: turners, user: { id: alex.id, isAdmin: false }, days: 0, maxUses: 0 });
    assert.equal(link.ok, true);
    const joined = await invites.redeem(pool, { token: link.link.token, user: { id: priya.id, isAdmin: false, hasPlatformAccess: true } });
    assert.equal(joined.status, 'joined');
    assert.equal(await rule(),
      'With one other person using it, a change goes live when you both say yes, '
      + 'or 3 days after one of you says yes if the other doesn\'t answer.',
      'two in it: priya is the one other person');

    // mo is invited by username: three, one of them still invited.
    const sent = await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'mo_t1006', note: 'Come read with us!' });
    assert.equal(sent.status, 201);
    assert.equal(await rule(),
      'With 3 people in it, counting 1 invited, a change goes live when 2 of you say yes, '
      + 'or 3 days after the first yes if nobody says no.');
  });

  await t.test('1. a refusal says why in a code the sheet words, and a note is checked like a link\'s', async () => {
    let got = await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'mo_t1066' });
    assert.deepEqual([got.status, got.body.code], [404, 'unknown_user'], 'a misspelt username');
    got = await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'MO_T1006' });
    assert.deepEqual([got.status, got.body.code, got.body.username], [409, 'already_invited', 'mo_t1006']);
    got = await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'priya_t1006' });
    assert.deepEqual([got.status, got.body.code], [409, 'already_member']);
    got = await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'alex_t1005' });
    assert.deepEqual([got.status, got.body.code], [400, 'self']);
    got = await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'priya_t1006', note: 'x'.repeat(281) });
    assert.equal(got.status, 400, 'a note past 280 characters, before anything is written');
  });

  await t.test('4. the invite is to join, with the maker\'s note and how many are in it', async () => {
    const { rows: [row] } = await pool.query(
      'SELECT status, invite_note FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [turners.id, mo.id]);
    assert.deepEqual(row, { status: 'invited', invite_note: 'Come read with us!' });
    const { rows: [notif] } = await pool.query(
      `SELECT kind, detail, source_user_id FROM notifications WHERE user_id = $1 AND kind = 'collab_invite'`, [mo.id]);
    assert.deepEqual(notif, { kind: 'collab_invite', detail: 'join', source_user_id: alex.id });
    const pending = await notifications.listPendingInvites(pool, mo.id);
    assert.equal(pending.length, 1);
    const { createdAt, ...rest } = pending[0];
    assert.ok(createdAt);
    assert.deepEqual(rest, {
      kind: 'collab', appId: turners.id, appSlug: 'page-turners', appName: 'Page Turners',
      invitedBy: 'alex_t1005', joins: true, note: 'Come read with us!', memberCount: 2,
    });
  });

  await t.test('5. accepting answers with the link path\'s welcome, once', async () => {
    const got = await call(mo, 'POST', `/api/invites/${turners.id}/accept`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {
      ok: true,
      appSlug: 'page-turners',
      welcome: {
        slug: 'page-turners', name: 'Page Turners', iconEmoji: '📚', iconUrl: null,
        // Nothing to fill "You're in" with yet: no line, no picture, and no
        // first version on its way.
        description: null, picture: null,
        inviterName: 'alex_t1005', inviterMadeIt: true, building: false, newAccount: false,
      },
    });
    assert.equal(await communities.isMember(pool, turners.id, mo.id), true, 'in the group');
    assert.equal(await rule(),
      'With 3 people using it, a change goes live when 2 of you say yes, '
      + 'or 3 days after the first yes if nobody says no.', 'and counted as one of them');
    const again = await call(mo, 'POST', `/api/invites/${turners.id}/accept`);
    assert.deepEqual(again.body, { ok: true, appSlug: 'page-turners', alreadyMember: true },
      'a second tab joins nothing, so it opens no welcome');
  });

  await t.test('an account made for this invite hears what Homeroom is', async () => {
    const sam = await user('sam_new');
    await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'sam_new' });
    const got = await call(sam, 'POST', `/api/invites/${turners.id}/accept`);
    assert.equal(got.body.welcome.newAccount, true);
    assert.equal(got.body.welcome.inviterMadeIt, true);
  });

  await t.test('on a project anyone can use, it is an invite to build, and a member joined nothing new', async () => {
    const owner = await user('dee', { displayName: 'Dee' });
    const lib = await project('open-library', { createdBy: owner.id, view: 'public', collab: 'private' });
    const reader = await user('reader');
    await communities.join(pool, lib, reader.id);
    const sent = await call(owner, 'POST', `/api/apps/${lib.slug}/invites`, { username: 'reader' });
    assert.equal(sent.status, 201);
    const { rows: [notif] } = await pool.query(
      `SELECT detail, invite_note FROM notifications n JOIN app_collaborators c ON c.app_id = n.app_id AND c.user_id = n.user_id
        WHERE n.user_id = $1 AND n.kind = 'collab_invite'`, [reader.id]);
    assert.deepEqual(notif, { detail: null, invite_note: null }, 'no note was written, and it is not a join');
    const [pending] = await notifications.listPendingInvites(pool, reader.id);
    assert.equal(pending.joins, false);
    const got = await call(reader, 'POST', `/api/invites/${lib.id}/accept`);
    assert.deepEqual(got.body, { ok: true, appSlug: 'open-library' }, 'already in its community: no "You joined"');
  });

  // First-session run-through, 5 October 2026. A test account
  // (services/test-accounts.js) is made ahead of time by an admin, so its
  // created_at said it was not new, and "You're in" gave it the welcome for
  // an account that was already there. Its first sign-in is its sign-up.
  async function testAccount(username, { daysOld = 2, signedInMinutesAgo = 1 } = {}) {
    const made = await user(username, { daysOld });
    await pool.query('UPDATE users SET test_account_created_at = created_at WHERE id = $1', [made.id]);
    if (signedInMinutesAgo != null) {
      await pool.query(
        `INSERT INTO sessions (token, user_id, expires_at, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() - make_interval(mins => $3))`,
        [crypto.randomBytes(24).toString('hex'), made.id, signedInMinutesAgo]);
    }
    return made;
  }
  const testAccounts = require('../src/services/test-accounts');

  await t.test('a test account on its first sign-in is welcomed as new; a real account as before', async () => {
    const fresh = await testAccount('tester_first_run');
    const earlier = await testAccount('tester_seasoned', { signedInMinutesAgo: 3 * 24 * 60 });
    const never = await testAccount('tester_never', { signedInMinutesAgo: null });
    const real = await user('real_old_t1007', { daysOld: 2 });
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [crypto.randomBytes(24).toString('hex'), real.id]);
    assert.equal(await testAccounts.onFirstRun(pool, fresh.id), true, 'first signed in a minute ago');
    assert.equal(await testAccounts.onFirstRun(pool, earlier.id), false, 'first signed in days ago');
    assert.equal(await testAccounts.onFirstRun(pool, never.id), false, 'never signed in');
    assert.equal(await testAccounts.onFirstRun(pool, real.id), false, 'a real account is never read as one');
    assert.equal(await testAccounts.onFirstRun(pool, 'x'), false);

    // An invite by username, accepted.
    for (const [who, isNew] of [[fresh, true], [earlier, false], [real, false]]) {
      await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: who.username });
      const got = await call(who, 'POST', `/api/invites/${turners.id}/accept`);
      assert.equal(got.status, 200);
      assert.equal(got.body.welcome.newAccount, isNew, who.username);
    }

    // A link followed once signed in (App._followInvite's confirm, or Join
    // pressed on the link's page before a password sign-in).
    const link = await invites.createInvite(pool, { app: turners, user: { id: alex.id, isAdmin: false }, days: 0, maxUses: 0 });
    const tester = await testAccount('tester_link');
    const realOld = await user('real_link_t1008', { daysOld: 2 });
    const viaTester = await call(tester, 'POST', `/api/invite-links/by-token/${link.link.token}/redeem`);
    assert.deepEqual([viaTester.status, viaTester.body.status, viaTester.body.newAccount], [200, 'joined', true]);
    const viaReal = await call(realOld, 'POST', `/api/invite-links/by-token/${link.link.token}/redeem`);
    assert.deepEqual([viaReal.status, viaReal.body.status, viaReal.body.newAccount], [200, 'joined', false],
      'a real account following a link signed in had its account before it, as the shell always said');
    const again = await call(tester, 'POST', `/api/invite-links/by-token/${link.link.token}/redeem`);
    assert.deepEqual([again.body.status, again.body.newAccount], ['member', false], 'nothing joined, nothing to welcome');
    // And the link's standing for the test account, once in.
    const standing = await invites.standing(pool, link.link.token, { id: tester.id });
    assert.equal(standing.mine, 'joined');
    assert.equal(standing.newAccount, true);
  });

  await t.test('"You\'re in" gets the project\'s picture at an address a member can read, and whether it is being made', async () => {
    // Page Turners, still being built, with the sketch its maker was shown.
    await pool.query(
      `INSERT INTO app_sketches (app_id, user_id, status, design, ready_at)
       VALUES ($1, $2, 'ready', $3::jsonb, NOW())`,
      [turners.id, alex.id, JSON.stringify({ kind: 'card', emoji: '📚', tagline: 'A book club', points: ['Pick the next book'], source: 'model' })]);
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, status, issue_number)
       VALUES ($1, $2, 'A book club that meets monthly', TRUE, 'filed', 1)`,
      [turners.id, alex.id]);
    await pool.query(`UPDATE apps SET manifest_snapshot = '{"description":"A book club that meets monthly"}'::jsonb WHERE id = $1`, [turners.id]);
    const sam = await user('sam_sketch');
    await call(alex, 'POST', `/api/apps/${turners.slug}/invites`, { username: 'sam_sketch' });
    const got = await call(sam, 'POST', `/api/invites/${turners.id}/accept`);
    assert.deepEqual(got.body.welcome.picture, { kind: 'sketch', url: null, darkUrl: null, card: { emoji: '📚', tagline: 'A book club', points: ['Pick the next book'] } });
    assert.equal(got.body.welcome.description, 'A book club that meets monthly');
    assert.equal(got.body.welcome.building, true, 'its first version is on its way');
    assert.equal(await invites.firstVersionPending(pool, turners.id), true);
    // The link's own page says the same: "alex is making Page Turners".
    const link = await invites.createInvite(pool, { app: turners, user: { id: alex.id, isAdmin: false }, days: 0, maxUses: 0 });
    const preview = await invites.preview(pool, link.link.token);
    assert.equal(preview.building, true);
    assert.equal(preview.project.picture.kind, 'sketch');
    // Once a proposal for it has merged, it is made.
    const { rows: [session] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'merged') RETURNING id`, [turners.id, alex.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 1, 'live', 'ready', $2)`,
      [turners.id, session.id]);
    assert.equal(await invites.firstVersionPending(pool, turners.id), false);
    assert.equal((await invites.preview(pool, link.link.token)).building, false);
  });
});
