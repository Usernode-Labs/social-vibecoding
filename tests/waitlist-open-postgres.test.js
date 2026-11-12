'use strict';

// The waitlist switched off (#6633) against the real schema in a throwaway
// database: an account each self-serve sign-up makes (email code, phone,
// Google or Apple) is let in at once by waitlist.admitIfOpen, the grant is an
// UPDATE so what a hand admit sets off happens too (Homeroom's own community,
// a queued invite, the welcome message), and with the switch on nothing
// changes. Then the people already waiting: kept, or let in by the
// "Let them all in" run (services/waitlist-open.js), the email following the
// release-email switch. Required when TEST_DATABASE_URL is set, skipped when
// no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the waitlist switch on the real schema: sign-ups, the grant\'s triggers, and the people already waiting',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'waitlist_open_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 6 });
    const poolPath = require.resolve('../src/db/pool');
    const originalPool = require.cache[poolPath];
    t.after(async () => {
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    // The mailer's bookkeeping finds this database through db/pool.
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true, id: poolPath, filename: poolPath, paths: originalPool ? originalPool.paths : [],
    };
    await require('../src/db/email-template-seeds').seedEmailTemplates(pool);

    const waitlist = require('../src/services/waitlist');
    const settings = require('../src/services/release-mail-setting');
    const waitlistOpen = require('../src/services/waitlist-open');
    const emailSignup = require('../src/services/email-signup');
    const phoneAuth = require('../src/services/firebase-phone-auth');
    const providers = require('../src/services/sign-in-providers');
    const journey = require('../src/services/journey');
    const { createSession } = require('../src/routes/auth');

    const sent = [];
    const config = {
      databaseUrl: String(url),
      sessionSecret: 'test-only-secret',
      mailTransport: { provider: 'test', send: async (m) => { sent.push(m); } },
      mailStagingLogOnly: false,
    };

    const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
    const account = (id) => one(
      `SELECT has_platform_access, platform_access_granted_at, invite_generation,
              (SELECT COUNT(*)::int FROM events e WHERE e.user_id = u.id AND e.event_type = 'open_signup_let_in') AS marked,
              (SELECT COUNT(*)::int FROM welcome_dm_queue q WHERE q.user_id = u.id) AS welcomed,
              (SELECT COUNT(*)::int FROM waitlist_signups w WHERE w.linked_user_id = u.id) AS spots
         FROM users u WHERE u.id = $1`, [id]);

    // Homeroom's own community, and a member's invite link somebody waits on.
    const maker = (await one("INSERT INTO users (username, password, has_platform_access) VALUES ('maker', 'x', TRUE) RETURNING id")).id;
    const community = (await one('INSERT INTO communities DEFAULT VALUES RETURNING id')).id;
    const home = (await one(
      "INSERT INTO apps (name, slug, created_by, status, self_hosted, community_id) VALUES ('Homeroom', 'homeroom', $1, 'running', TRUE, $2) RETURNING id",
      [maker, community])).id;
    await pool.query("INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined') ON CONFLICT DO NOTHING", [community, maker]);
    const club = (await one('INSERT INTO communities DEFAULT VALUES RETURNING id')).id;
    const clubApp = (await one(
      "INSERT INTO apps (name, slug, created_by, status, community_id) VALUES ('Club', 'club', $1, 'running', $2) RETURNING id",
      [maker, club])).id;
    await pool.query("INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined') ON CONFLICT DO NOTHING", [club, maker]);
    const invite = (await one(
      "INSERT INTO community_invites (token, community_id, app_id, created_by) VALUES ('tok-club', $1, $2, $3) RETURNING id",
      [club, clubApp, maker])).id;
    assert.ok(home);
    // The welcome message is queued only while its own switch is on.
    await pool.query("INSERT INTO platform_settings (key, value) VALUES ('welcome_dm_enabled', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'");

    const emailCode = async (email) => {
      await pool.query(
        `INSERT INTO mobile_otp_codes (email, code_hash, attempts, expires_at, created_at, updated_at)
         VALUES ($1, $2, 0, NOW() + INTERVAL '10 minutes', NOW(), NOW())`,
        [email, await bcrypt.hash('123456', 4)]);
      return emailSignup.verifyCode(pool, email, '123456', { createSession });
    };
    const googleClaims = (subject, email) => ({ subject, email, emailVerified: true, name: null });
    // What the phone route and the provider callback do with a sign-in's
    // result, in their order (routes/phone-auth.js, routes/sign-in-providers.js afterSignIn).
    const phoneSignUp = async (uid, phoneNumber) => {
      const result = await phoneAuth.signIn(pool, { uid, phoneNumber }, { createSession });
      if (result.created) await waitlist.admitIfOpen(pool, result.userId);
      return result;
    };
    const providerSignUp = async (subject, email) => {
      const result = await providers.signIn(pool, 'google', googleClaims(subject, email), { createSession });
      if (result.created) {
        await waitlist.linkUserByEmail(pool, { userId: result.userId, email: result.email, newAccount: true });
        await waitlist.admitIfOpen(pool, result.userId);
      }
      await waitlist.ensureAccountSignup(pool, { userId: result.userId });
      return result;
    };

    await t.test('on by default: no row is on, and every sign-up waits as before', async () => {
      assert.equal(await settings.waitlistEnabled(pool, { fresh: true }), true);
      const mail = await emailCode('on.email@example.test');
      assert.equal(mail.created, true);
      assert.equal(mail.waitlisted, true);
      const a = await account(mail.userId);
      assert.equal(a.has_platform_access, false);
      assert.equal(a.marked, 0);
      assert.equal(a.spots, 1, 'a waiting account has its waitlist spot');

      const phone = await phoneSignUp('uid-on', '+15550000001');
      assert.equal(phone.created, true);
      assert.equal((await account(phone.userId)).has_platform_access, false);

      const google = await providerSignUp('g-on', 'on.google@example.test');
      assert.equal(google.created, true);
      assert.equal((await account(google.userId)).has_platform_access, false);
      assert.equal((await account(google.userId)).spots, 1);

      assert.equal(await waitlist.admitIfOpen(pool, mail.userId), false, 'asked directly, it still lets nobody in');
      assert.equal((await account(mail.userId)).has_platform_access, false);
    });

    await t.test('off: each sign-up lets its new account in at once, as an UPDATE that sets off what a hand admit does', async () => {
      await settings.setWaitlistEnabled(pool, { enabled: false, actorId: maker });
      assert.equal(await settings.waitlistEnabled(pool), false);

      const mail = await emailCode('off.email@example.test');
      assert.equal(mail.created, true);
      assert.equal(mail.waitlisted, false, 'the client is told there is no waiting room');
      const a = await account(mail.userId);
      assert.equal(a.has_platform_access, true);
      assert.ok(a.platform_access_granted_at);
      assert.equal(a.invite_generation, null, 'not a release by hand: no generation-0 skips');
      assert.equal(a.marked, 1, 'marked as open sign-up');
      assert.equal(a.spots, 0, 'no waitlist row: nobody was released, so no reminders are owed');
      assert.equal(a.welcomed, 1, 'the welcome message is queued');
      const inHome = await one('SELECT source FROM community_members WHERE community_id = $1 AND user_id = $2', [community, mail.userId]);
      assert.equal(inHome && inHome.source, 'auto', "joined Homeroom's own community");

      // A queued invite applies on the grant (that trigger is UPDATE-only).
      const phone = await phoneAuth.signIn(pool, { uid: 'uid-off', phoneNumber: '+15550000002' }, { createSession });
      assert.equal(phone.created, true);
      await pool.query("INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')", [invite, phone.userId]);
      assert.equal(await waitlist.admitIfOpen(pool, phone.userId), true);
      const p = await account(phone.userId);
      assert.equal(p.has_platform_access, true);
      assert.equal(p.marked, 1);
      const redemption = await one('SELECT status FROM community_invite_redemptions WHERE invite_id = $1 AND user_id = $2', [invite, phone.userId]);
      assert.equal(redemption.status, 'joined', 'the queued invite applied');

      const google = await providerSignUp('g-off', 'off.google@example.test');
      const g = await account(google.userId);
      assert.equal(g.has_platform_access, true);
      assert.equal(g.marked, 1);
      assert.equal(g.spots, 0);

      assert.equal(sent.length, 0, 'no "you\'re in" email for anybody let in this way');
      assert.equal(await waitlist.admitIfOpen(pool, mail.userId), false, 'a second call lets nobody in again');
      assert.equal((await account(mail.userId)).marked, 1);
    });

    await t.test('off: somebody who was already waiting is not let in by signing in again', async () => {
      const waiting = await one("SELECT id FROM users WHERE email = 'on.email@example.test'");
      const again = await emailCode('on.email@example.test');
      assert.equal(again.userId, waiting.id);
      assert.notEqual(again.created, true);
      assert.equal((await account(waiting.id)).has_platform_access, false);
      const phoneAgain = await phoneSignUp('uid-on', '+15550000001');
      assert.notEqual(phoneAgain.created, true);
      assert.equal((await account(phoneAgain.userId)).has_platform_access, false);
    });

    await t.test('Journey: an open sign-up is its own door, not an activation code or a grant', async () => {
      const off = await one("SELECT id FROM users WHERE email = 'off.email@example.test'");
      const mile = await journey.firstMile(pool, { day: 'other_way' });
      const person = mile.people.find((p) => p.userId === Number(off.id));
      assert.ok(person, 'the account is in "Came in another way"');
      assert.equal(person.door, 'open_signup');
      const dialog = await journey.person(pool, { userId: off.id });
      assert.equal(dialog.cameIn.door, 'open_signup');
      // The maker has access with no admit and no mark: the old class.
      const makerRow = mile.people.find((p) => p.name === 'maker');
      if (makerRow) assert.equal(makerRow.door, 'code_wallet_or_grant');
    });

    await t.test('a read that fails says the waitlist is on', async () => {
      const broken = { query: async () => { throw new Error('down'); } };
      assert.equal(await settings.waitlistEnabled(broken, { fresh: true }), true);
      assert.equal(await waitlist.admitIfOpen(broken, 1), false);
    });

    await t.test('the people already waiting: kept until a run is started, then let in under the release-email switch', async () => {
      // Three address-only rows from the marketing form, beside the three
      // accounts that signed up while the waitlist was on.
      for (const email of ['a@example.test', 'b@example.test', 'c@example.test']) {
        await pool.query('INSERT INTO waitlist_signups (email, more_token) VALUES ($1, $2)', [email, crypto.randomBytes(8).toString('hex')]);
      }
      const before = await waitlistOpen.countWaiting(pool);
      assert.equal(before, 5, 'two accounts with a spot and three addresses');

      // Kept: with no run, the clock does nothing.
      assert.deepEqual(await waitlistOpen.admitAllTick(config, pool), { off: true });
      assert.equal(await waitlistOpen.countWaiting(pool), before);

      // Let them all in, the release email on: a few a beat, each emailed.
      assert.equal(await waitlistOpen.startAdmitAll(pool, { actorId: maker }), before);
      // Somebody who joins after the click is not part of the run.
      await pool.query("INSERT INTO waitlist_signups (email, more_token) VALUES ('late@example.test', 'late-token')");
      const first = await waitlistOpen.admitAllTick(config, pool);
      assert.equal(first.admitted, waitlistOpen.PER_RUN_MAILED);
      assert.equal(sent.length, waitlistOpen.PER_RUN_MAILED, 'each person admitted was emailed');
      assert.equal((await waitlistOpen.readAdmitAll(pool)) !== null, true, 'the run carries on from where it stopped');
      const waitingAccount = await one("SELECT id FROM users WHERE email = 'on.email@example.test'");
      const let1 = await account(waitingAccount.id);
      assert.equal(let1.has_platform_access, true, 'the account that was waiting is in');
      assert.equal(let1.invite_generation, 0, 'admitted as by hand');
      assert.equal(let1.marked, 0, 'and not marked as an open sign-up');

      // The release email switched off mid-run: the rest are let in, unmailed.
      await settings.setReleaseMail(pool, { enabled: false });
      const mailedSoFar = sent.length;
      let guard = 0;
      while (await waitlistOpen.readAdmitAll(pool)) {
        await waitlistOpen.admitAllTick(config, pool);
        guard += 1;
        assert.ok(guard < 10, 'the run ends');
      }
      assert.equal(sent.length, mailedSoFar, 'nobody is emailed with the release email off');
      assert.equal(await waitlistOpen.countWaiting(pool), 1, 'only the one who joined after the click still waits');
      assert.deepEqual(await waitlistOpen.admitAllTick(config, pool), { off: true }, 'a finished run is not run again');
    });

    await t.test('switching the waitlist back on ends a run where it stands, and new accounts wait again', async () => {
      assert.equal(await waitlistOpen.startAdmitAll(pool, { actorId: maker }), 1);
      await settings.setWaitlistEnabled(pool, { enabled: true, actorId: maker });
      assert.deepEqual(await waitlistOpen.admitAllTick(config, pool), { ended: 'waitlist_on' });
      assert.equal(await waitlistOpen.readAdmitAll(pool), null);
      assert.equal(await waitlistOpen.countWaiting(pool), 1);

      const mail = await emailCode('back.on@example.test');
      assert.equal(mail.waitlisted, true);
      assert.equal((await account(mail.userId)).has_platform_access, false);
    });

    await t.test('a run with nobody waiting starts nothing', async () => {
      await pool.query('UPDATE waitlist_signups SET released_at = NOW() WHERE released_at IS NULL');
      assert.equal(await waitlistOpen.startAdmitAll(pool, { actorId: maker }), 0);
      assert.equal(await waitlistOpen.readAdmitAll(pool), null);
    });
  });

test('the three sign-ups call admitIfOpen for an account they just made, before its waitlist spot and any invite', () => {
  const email = read('src/services/email-signup.js');
  assert.match(email, /if \(result\.created\) \{\s+await waitlist\.linkUserByEmail\([^\n]+\n(?:\s+\/\/[^\n]*\n)+\s+await waitlist\.admitIfOpen\(pool, result\.userId\);\s+\}/);
  assert.ok(email.indexOf('waitlist.admitIfOpen(') < email.indexOf('waitlist.ensureAccountSignup(pool, { userId: result.userId })'));

  const phone = read('src/routes/phone-auth.js');
  assert.match(phone, /if \(result\.created\) await waitlist\.admitIfOpen\(pool, result\.userId\);/);
  assert.ok(phone.indexOf('waitlist.admitIfOpen(') < phone.indexOf('communityInvites.redeemCarried(pool, req, res, result.userId'));

  const provider = read('src/routes/sign-in-providers.js');
  const after = provider.slice(provider.indexOf('async function afterSignIn('));
  const created = after.slice(after.indexOf('if (result.created) {'), after.indexOf('await waitlist.ensureAccountSignup('));
  assert.match(created, /await waitlist\.linkUserByEmail\([^\n]+\n(?:\s+\/\/[^\n]*\n)+\s+await waitlist\.admitIfOpen\(pool, result\.userId\);/);
  assert.ok(after.indexOf('waitlist.admitIfOpen(') < after.indexOf('communityInvites.redeemCarried('));
});
