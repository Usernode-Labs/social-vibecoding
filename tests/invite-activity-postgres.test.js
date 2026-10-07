'use strict';

// WP-E against the full schema (src/services/invite-activity.js): what an
// invite link brings back to its maker. Opens are counted once per person
// and never named, an open made signed out is remembered and its maker
// hears only when that browser signs in or opens the link signed in, a join
// and a first hello name the person who came by the link, each kind rings
// once a day per project and folds the rest into a count, and none of it
// reaches anybody but the link's maker. An open is news only until that
// person joins: the join replaces it.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/invite-activity-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const activity = require('../src/services/invite-activity');

test('invite activity against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `invite_activity_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  async function user(username) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [username]);
    return u;
  }
  const maya = await user('maya');
  const sam = await user('sam');
  const alex = await user('alex');
  const old = await user('old_member');

  let n = 0;
  async function project() {
    n += 1;
    const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, community_id) VALUES ($1, $2, 'running', $3, $4)
       RETURNING id, community_id, name, slug`,
      [`Run Club ${n}`, `run-club-${n}`, maya.id, community.id]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [app.community_id, maya.id]);
    const token = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days') RETURNING id, token`,
      [token, app.community_id, app.id, maya.id]);
    return { app, invite };
  }
  async function joinBy(invite, app, who) {
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at) VALUES ($1, $2, 'joined', NOW())`,
      [invite.id, who.id]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [app.community_id, who.id]);
  }
  async function say(app, who, content = 'hi all') {
    const { rows: [m] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3) RETURNING id`,
      [app.id, who.id, content]);
    return m.id;
  }
  const rowsOf = async (userId, kind) => (await pool.query(
    `SELECT id, app_id, source_user_id, chat_message_id, detail, read_at FROM notifications
      WHERE user_id = $1 AND kind = $2 ORDER BY id`, [userId, kind])).rows;

  await t.test('schema: the two push categories and their kinds', async () => {
    const { rows } = await pool.query(
      `SELECT kind, category, default_enabled FROM mobile_push_kind_categories
        WHERE category IN ('builds', 'invite_activity') ORDER BY kind`);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.category}:${r.default_enabled}`), [
      'build_live:builds:true', 'build_needs_you:builds:true', 'build_ready:builds:true', 'build_stopped:builds:true',
      'first_message:invite_activity:true', 'invite_opened:invite_activity:true', 'member_joined:invite_activity:true',
    ]);
    // A person may switch either off.
    await pool.query(`INSERT INTO mobile_push_preferences (user_id, category, enabled) VALUES ($1, 'builds', FALSE), ($1, 'invite_activity', FALSE)`, [alex.id]);
    const { rows: cols } = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'activity_email'`);
    assert.equal(cols[0].is_nullable, 'NO');
    assert.match(cols[0].column_default, /true/);
  });

  await t.test('a join names who came by the link, to its maker only, and the day folds into one row', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, sam);
    const first = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: sam.id } });
    assert.equal(first.fresh, true);
    await joinBy(invite, app, alex);
    const second = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: alex.id } });
    assert.equal(second.fresh, false, 'folded, not a second ring');
    const rows = (await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '2');
    assert.equal(rows[0].source_user_id, alex.id, 'the newest person leads');
    assert.equal((await rowsOf(sam.id, 'member_joined')).length, 0);
    // The maker following their own link is not news.
    assert.equal(await activity.noteJoined(pool, { inviteId: invite.id, user: { id: maya.id } }), null);
  });

  // A browser, as the route hands it over: the hash of its cookie.
  const browser = (name) => crypto.createHash('sha256').update(`test-browser:${name}`).digest('hex');
  const opensOf = async (app) => (await pool.query(
    `SELECT user_id, browser, notification_id FROM community_invite_opens WHERE app_id = $1 ORDER BY id`, [app.id])).rows;
  const openEvents = async (invite) => (await pool.query(
    `SELECT user_id, app_id, metadata FROM events
      WHERE event_type = 'invite_opened' AND (metadata->>'inviteId')::int = $1`, [invite.id])).rows;
  const waitForEvents = async (invite, n) => {
    for (let i = 0; i < 40 && (await openEvents(invite)).length < n; i += 1) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    return openEvents(invite);
  };

  await t.test('three people on the first day ring once, and the push waits for a join', async () => {
    const { app, invite } = await project();
    await pool.query(
      `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
       VALUES ('production', 'social-prod', TRUE, NOW() - INTERVAL '1 hour')
       ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = EXCLUDED.send_not_before`);
    // A phone needs a native session behind it; that chain is not what this
    // checks, so the scratch database drops the link to it.
    await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '30 days')`,
      [maya.id, `nsc_${String(maya.id).padStart(43, '0')}`, crypto.randomUUID(), crypto.randomBytes(32).toString('hex')]);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    const first = await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('ring-a') });
    assert.equal(first.fresh, true);
    assert.equal((await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('ring-b') })).fresh, false);
    assert.equal((await activity.noteOpened(pool, { token: invite.token, viewerId: old.id, browser: browser('ring-c') })).fresh, false);
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '3', 'three people');
    assert.equal(rows[0].source_user_id, null, 'an open is never a name');
    const deliveries = (await pool.query(
      `SELECT available_at > NOW() + INTERVAL '14 minutes' AS waits, status
         FROM mobile_push_deliveries WHERE notification_id = $1`, [rows[0].id])).rows;
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    assert.equal(after - before, 1, 'one push for three opens');
    assert.deepEqual(deliveries, [{ waits: true, status: 'pending' }],
      `the open's push waits ${activity.OPEN_PUSH_DELAY_MINUTES} minutes, for a join to replace it`);
    // Each person's open is also an event for the admin Journey's first
    // session, with the account on it when they were signed in.
    const recorded = await waitForEvents(invite, 3);
    assert.equal(recorded.length, 3);
    assert.deepEqual(
      recorded.map((r) => [r.user_id, r.app_id, r.metadata.signedIn]).sort((a, b) => a[0] - b[0]),
      [[sam.id, app.id, true], [alex.id, app.id, true], [old.id, app.id, true]]);
  });

  await t.test('one person opening a link four times is one open: no count, no unread, no ring', async () => {
    const { app, invite } = await project();
    const first = await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('one-person') });
    assert.equal(first.fresh, true);
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE id = $1', [first.row.id]);
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('one-person') }),
        { row: null, fresh: false }, 'the same browser again, signed out');
    }
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('one-person') }),
      { row: null, fresh: false }, 'and the same browser, signed in');
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, null, '"Someone opened your invite", not "4 people"');
    assert.ok(rows[0].read_at, 'and it stays read');
    assert.equal((await opensOf(app)).length, 1);
    assert.equal((await waitForEvents(invite, 1)).length, 1, 'one event, as one person');

    // Signed in, they are their account on every device and browser: the
    // phone, then the laptop, then the phone signed out, then signed in.
    const signed = await project();
    await activity.noteOpened(pool, { token: signed.invite.token, viewerId: sam.id, browser: browser('sam-phone') });
    assert.deepEqual(await activity.noteOpened(pool, { token: signed.invite.token, viewerId: sam.id, browser: browser('sam-laptop') }),
      { row: null, fresh: false }, 'another device, same account');
    assert.deepEqual(await activity.noteOpened(pool, { token: signed.invite.token, browser: browser('sam-phone') }),
      { row: null, fresh: false }, 'the same phone, signed out');
    const signedRows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === signed.app.id);
    assert.equal(signedRows.length, 1);
    assert.equal(signedRows[0].detail, null);
    assert.deepEqual((await opensOf(signed.app)).map((r) => [r.user_id, r.browser]), [[sam.id, browser('sam-phone')]]);
  });

  await t.test('two people are two, and a second link of the same maker\'s does not count them again', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('two-sam') });
    await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('two-stranger') });
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '2', '"2 people opened your invite"');
    // Maya made a second link to the same project: Sam opening it is not a third.
    const token = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
      [token, app.community_id, app.id, maya.id]);
    assert.deepEqual(await activity.noteOpened(pool, { token, viewerId: sam.id, browser: browser('two-sam-2') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id)[0].detail, '2');
  });

  await t.test('a browser opened signed out is counted when it signs in, and a person seen on two rows are one', async () => {
    const { app, invite } = await project();
    // Opened signed out: remembered, nobody told.
    await activity.noteOpened(pool, { token: invite.token, browser: browser('merge-v1') });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0,
      'the click alone is not news');
    // Alex opens the link again signed in in that browser: the maker hears now.
    const told = await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('merge-v1') });
    assert.equal(told.fresh, true);
    let rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, null, 'one person');
    assert.equal((await waitForEvents(invite, 1)).length, 1,
      'the event went out at the open, and the signed-in read records no second one');
    // Opening from another browser, still signed in, is the same person:
    // one row, not counted twice.
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('merge-v2') }),
      { row: null, fresh: false });
    rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, null);
    assert.equal((await opensOf(app)).length, 1);
  });

  await t.test('a signed-out open tells nobody: no notice, no push, one Journey event', async () => {
    const { app, invite } = await project();
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('quiet') }),
      { row: null, fresh: false }, 'remembered, not told');
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0,
      'no notice');
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM mobile_push_deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE n.app_id = $1`, [app.id])).rows[0].n, 0,
      'no push for this project');
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.browser, r.notification_id]),
      [[null, browser('quiet'), null]], 'the open row waits without a notice');
    const recorded = await waitForEvents(invite, 1);
    assert.equal(recorded.length, 1, 'one Journey event, at the open');
    assert.deepEqual(recorded.map((r) => [r.user_id, r.metadata.signedIn]), [[null, false]]);
  });

  await t.test('the sign-in tells it once: the day\'s notice, its push delayed for a join', async () => {
    const { app, invite } = await project();
    await pool.query(
      `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
       VALUES ('production', 'social-prod', TRUE, NOW() - INTERVAL '1 hour')
       ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = EXCLUDED.send_not_before`);
    await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
    // One registration, for this test's one expected delivery: the earlier
    // tests' registrations for Maya are not what this checks.
    await pool.query('DELETE FROM mobile_push_registrations WHERE user_id = $1', [maya.id]);
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '30 days')`,
      [maya.id, `nsc_${String(maya.id).padStart(43, '0')}`, crypto.randomUUID(), crypto.randomBytes(32).toString('hex')]);
    await activity.noteOpened(pool, { token: invite.token, browser: browser('sign-in-once') });
    await activity.noteSignedIn(pool, { userId: sam.id, browser: browser('sign-in-once') });
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1, 'the maker hears when the browser signs in');
    const deliveries = (await pool.query(
      `SELECT available_at > NOW() + INTERVAL '14 minutes' AS waits, status
         FROM mobile_push_deliveries WHERE notification_id = $1`, [rows[0].id])).rows;
    assert.deepEqual(deliveries, [{ waits: true, status: 'pending' }],
      `the push still waits ${activity.OPEN_PUSH_DELAY_MINUTES} minutes, for a join to replace it`);
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.notification_id]),
      [[sam.id, rows[0].id]], 'the row learned the account, and is counted on the notice');
    // Signing in again, and opening the link again signed out or in, add
    // nothing.
    await activity.noteSignedIn(pool, { userId: sam.id, browser: browser('sign-in-once') });
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('sign-in-once') }),
      { row: null, fresh: false }, 'the same browser, signed out');
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('sign-in-once') }),
      { row: null, fresh: false }, 'and signed in');
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 1);
    assert.equal((await waitForEvents(invite, 1)).length, 1, 'still one event: the sign-in records none');
  });

  await t.test('the invite page\'s two reads: a signed-out preview then a signed-in standing read ring once, either way round', async () => {
    // The anonymous preview read lands first: it leaves a deferred row the
    // signed-in standing read counts.
    const preview = await project();
    await activity.noteOpened(pool, { token: preview.invite.token, browser: browser('preview-first') });
    const told = await activity.noteOpened(pool, { token: preview.invite.token, viewerId: sam.id, browser: browser('preview-first') });
    assert.equal(told.fresh, true);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === preview.app.id).length, 1);

    // The standing read lands first: it rings, and the signed-out preview
    // then only merges into the account row.
    const standing = await project();
    const first = await activity.noteOpened(pool, { token: standing.invite.token, viewerId: alex.id, browser: browser('standing-first') });
    assert.equal(first.fresh, true);
    assert.deepEqual(await activity.noteOpened(pool, { token: standing.invite.token, browser: browser('standing-first') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === standing.app.id).length, 1);
  });

  await t.test('a sign-in as the maker, or as somebody already in the community, tells nobody', async () => {
    const maker = await project();
    await activity.noteOpened(pool, { token: maker.invite.token, browser: browser('maker-browser') });
    await activity.noteSignedIn(pool, { userId: maya.id, browser: browser('maker-browser') });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === maker.app.id).length, 0);
    assert.deepEqual((await opensOf(maker.app)).map((r) => [r.user_id]), [[maya.id]],
      'the row still learned the account, so the browser is quiet from now on');

    const member = await project();
    await joinBy(member.invite, member.app, old);
    await activity.noteOpened(pool, { token: member.invite.token, browser: browser('member-browser') });
    await activity.noteSignedIn(pool, { userId: old.id, browser: browser('member-browser') });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === member.app.id).length, 0);
    assert.deepEqual((await opensOf(member.app)).map((r) => [r.user_id]), [[old.id]]);
  });

  await t.test('two people opened signed out and both sign in: one notice, counted up once', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, browser: browser('two-browsers-a') });
    await activity.noteOpened(pool, { token: invite.token, browser: browser('two-browsers-b') });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
    await activity.noteSignedIn(pool, { userId: sam.id, browser: browser('two-browsers-a') });
    await activity.noteSignedIn(pool, { userId: alex.id, browser: browser('two-browsers-b') });
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1, 'rung once, not once per sign-in');
    assert.equal(rows[0].detail, '2', 'and the two are counted on it');
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id]), [[sam.id], [alex.id]]);
  });

  await t.test('a join replaces the open: off the notice, which goes when nobody is left, its waiting push with it', async () => {
    const { app, invite } = await project();
    // Opened signed out, then signed up in the same browser and joined
    // straight away: no open notice ever existed to withdraw, and "Joined
    // through your invite" says it.
    await activity.noteOpened(pool, { token: invite.token, browser: browser('join-sam') });
    await joinBy(invite, app, sam);
    const joined = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: sam.id }, browser: browser('join-sam') });
    assert.equal(joined.fresh, true);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0,
      'no open notice at any point');
    assert.equal((await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id).length, 1);
    // They are remembered, with their account: opening the link again
    // signed out in that browser is not news.
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.notification_id]), [[sam.id, null]]);
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('join-sam') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);

    // Two opened signed in; one joins: the other is still somebody who
    // opened, and the notice — its waiting push with it — goes when nobody
    // is left on it.
    const both = await project();
    await activity.noteOpened(pool, { token: both.invite.token, viewerId: alex.id, browser: browser('join-alex') });
    const second = await activity.noteOpened(pool, { token: both.invite.token, viewerId: old.id, browser: browser('join-other') });
    await pool.query(
      `INSERT INTO mobile_push_deliveries (notification_id, environment, installation_id, available_at)
       VALUES ($1, 'production', $2, NOW() + INTERVAL '15 minutes') ON CONFLICT DO NOTHING`,
      [second.row.id, crypto.randomUUID()]);
    await joinBy(both.invite, both.app, alex);
    await activity.noteJoined(pool, { inviteId: both.invite.id, user: { id: alex.id } });
    const left = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === both.app.id);
    assert.equal(left.length, 1);
    assert.equal(left[0].detail, null, '"Someone opened your invite": the one who has not joined');
    await joinBy(both.invite, both.app, old);
    await activity.noteJoined(pool, { inviteId: both.invite.id, user: { id: old.id } });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === both.app.id).length, 0,
      'nobody left on it: the notice goes');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries WHERE notification_id = $1', [second.row.id])).rows[0].n, 0,
      'and its waiting push never goes');
  });

  await t.test('a browser counted before opens were kept by person is remembered, not counted again', async () => {
    const { app, invite } = await project();
    assert.deepEqual(
      await activity.noteOpened(pool, { token: invite.token, browser: browser('legacy'), seenBefore: true }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('legacy') }),
      { row: null, fresh: false }, 'and stays quiet once the old cookie has gone');
    assert.equal(await activity.noteOpened(pool, { token: invite.token }), null,
      'nothing to know a person by, so nothing to count once');
  });

  await t.test('an open by the maker, a member or a dead link counts nothing', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, old);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, viewerId: maya.id, browser: browser('maker') }), null);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, viewerId: old.id, browser: browser('member') }), null);
    await pool.query('UPDATE community_invites SET revoked_at = NOW() WHERE id = $1', [invite.id]);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, browser: browser('dead') }), null);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'invite_opened' AND (metadata->>'inviteId')::int = $1`,
      [invite.id])).rows[0].n, 0, 'and records no open');
  });

  await t.test('a first message from somebody the link brought is a hello; the second is not', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, sam);
    const hi = await say(app, sam, 'hello from sam');
    const first = await activity.noteFirstMessage(pool, { appId: app.id, userId: sam.id, chatMessageId: hi });
    assert.equal(first.fresh, true);
    const again = await say(app, sam, 'and again');
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: sam.id, chatMessageId: again }), null);
    const rows = (await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_message_id, hi);
    assert.equal(rows[0].source_user_id, sam.id);
  });

  await t.test('no hello from somebody who did not come by a link, or long after joining', async () => {
    const { app, invite } = await project();
    // In the community, but not by this link.
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, alex.id]);
    const m1 = await say(app, alex);
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: alex.id, chatMessageId: m1 }), null);
    // By the link, but two months ago.
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at, created_at)
       VALUES ($1, $2, 'joined', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days')`,
      [invite.id, old.id]);
    const m2 = await say(app, old);
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: old.id, chatMessageId: m2 }), null);
    assert.equal((await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id).length, 0);
  });

  await t.test('a row from yesterday is not folded into: today rings again', async () => {
    const { app, invite } = await project();
    // A signed-out open, then its browser signs in: that is yesterday's
    // notice. Past the 24 hours, the next open's sign-in rings again.
    await activity.noteOpened(pool, { token: invite.token, browser: browser('yesterday') });
    await activity.noteSignedIn(pool, { userId: sam.id, browser: browser('yesterday') });
    await pool.query(
      `UPDATE notifications SET created_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1 AND app_id = $2 AND kind = 'invite_opened'`,
      [maya.id, app.id]);
    await activity.noteOpened(pool, { token: invite.token, browser: browser('today') });
    await activity.noteSignedIn(pool, { userId: alex.id, browser: browser('today') });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 2);
  });
});
