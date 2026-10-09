'use strict';

// Test release emails end to end against the full PostgreSQL schema
// (services/test-accounts.js sendRelease, routes/test-accounts.js, the
// connector's send_test_release_email): the waitlist's real "you're in" mail
// sent to an address a full admin reads, its link, the email-code sign-up it
// starts, and the account that makes — a test account, fenced before it is
// let in, listed, and retired with its waitlist row. Also: the refusals, the
// rows kept out of Admin → Waitlist and the Journey, an existing account
// never let in by a test release, the throttle reported rather than hidden,
// the cap, and the week after which an unused release is withdrawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');
const cookieParser = require('cookie-parser');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const logged = [];
const logger = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (...args) => { logged.push(JSON.stringify(args)); };
}

const testAccounts = require('../src/services/test-accounts');
const waitlist = require('../src/services/waitlist');

test('test release emails against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'test_releases_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  // Every mail the platform sends, as its transport receives it.
  const mails = [];
  const config = {
    databaseUrl: String(url),
    jwtSecret: 'synthetic-test-only',
    mailStagingLogOnly: false,
    mailTransport: { provider: 'test', async send(message) { mails.push(message); } },
  };
  const routePool = require('../src/db/pool').getPool(config);
  let server = null;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('welcome_dm_enabled', 'on')
    ON CONFLICT (key) DO UPDATE SET value = 'on'`);

  let seq = 0;
  async function realUser({ fullAdmin = false, email = null } = {}) {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, is_admin, admin_readonly, email, email_confirmed)
       VALUES ($1, 'x', $2, FALSE, $3::varchar, $3::varchar IS NOT NULL) RETURNING *`,
      [`person_${seq}`, fullAdmin, email]
    );
    return u;
  }
  const owner = await realUser({ fullAdmin: true, email: 'Evan.Tester+inbox@Example.com' });
  const row = async (id) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
  const send = (body = {}, actorId = owner.id) => testAccounts.sendRelease(pool, body, { actorId, config });
  const releaseMails = (to) => mails.filter((m) => m.kind === 'waitlist_released' && m.to === to);

  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, res, next) => {
    if (req.headers['x-test-user'] === 'admin') req.user = { id: owner.id, username: owner.username, isAdmin: true, canAdminWrite: true };
    if (req.headers['x-test-user'] === 'viewer') req.user = { id: owner.id, username: owner.username, isAdmin: true, canAdminWrite: false };
    next();
  });
  app.use(require('../src/routes/test-accounts').testAccountRoutes(config));
  app.use(require('../src/routes/auth').authRoutes(config));
  app.use(require('../src/routes/topochain/admin').topochainAdminRoutes(config));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, { who = 'admin', cookie } = {}) => fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(who ? { 'x-test-user': who } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let alias;
  let madeId;

  await t.test('with no address, the real release mail goes to a fresh +test alias of the admin\'s own', async () => {
    const res = await call('POST', '/api/test-accounts/release-emails', { note: 'Release mail copy, round 1' });
    assert.equal(res.status, 200);
    const { release } = await res.json();
    alias = release.email;
    assert.match(alias, /^evan\.tester\+test[0-9a-f]{6}@example\.com$/, 'the +tag is replaced, the address lowercased');
    assert.equal(release.hasAccount, false);
    assert.equal(release.signsInTo, null);
    assert.deepEqual(release.mail, { status: 'sent', error: null });

    const [mail] = releaseMails(alias);
    assert.ok(mail, 'the transport got the waitlist_released mail');
    assert.equal(mail.hasAccount, false);
    const link = new URL(mail.url);
    assert.equal(link.searchParams.get('signup'), '1');
    // The link's token is the row's own, and resolves to the address: the
    // signup screen prefills it from there (GET /api/public/waitlist/more).
    const signup = await waitlist.getSignupByMoreToken(pool, link.searchParams.get('t'));
    assert.equal(signup.email, alias);
    assert.ok(signup.released_at, 'released like an admitted signup');
    assert.ok(signup.confirmed_at);
    assert.equal(signup.linked_user_id, null);
    assert.equal(Number(signup.id), release.signupId);

    const pending = await testAccounts.listReleases(pool);
    assert.deepEqual(pending.map((p) => [p.email, p.note, p.createdBy]), [[alias, 'Release mail copy, round 1', owner.username]]);
    assert.equal(new Date(pending[0].expiresAt) - new Date(pending[0].lastSentAt), testAccounts.RELEASE_TTL_DAYS * 86400000);
    const listed = await (await call('GET', '/api/test-accounts')).json();
    assert.equal(listed.releases.length, 1);
    assert.equal(listed.releases[0].email, alias);
  });

  await t.test('signing up from the mail makes a test account, fenced before it is let in', async () => {
    assert.equal((await call('POST', '/api/auth/otp/request', { email: alias }, { who: null })).status, 200);
    const otp = mails.filter((m) => m.kind === 'otp' && m.to === alias).pop();
    assert.ok(otp && /^[0-9]{6}$/.test(otp.code), 'the sign-in code went to the same address');
    const verify = await call('POST', '/api/auth/otp/verify', { email: alias, code: otp.code }, { who: null });
    assert.equal(verify.status, 200);
    const verified = await verify.json();
    assert.equal(verified.next, 'set-password');
    assert.equal(verified.created, true);
    assert.equal(verified.waitlisted, false, 'let in by the release, so no waiting room');
    const cookie = (verify.headers.get('set-cookie') || '').split(';')[0];
    const done = await call('POST', '/api/auth/otp/set-password', {
      username: 'release_tester', password: 'a-long-password-1', passwordConfirmation: 'a-long-password-1',
    }, { who: null, cookie });
    assert.equal(done.status, 200);
    madeId = (await done.json()).user.id;

    const u = await row(madeId);
    assert.equal(u.username, 'release_tester');
    assert.equal(u.email, alias);
    assert.ok(u.test_account_created_at, 'a test account');
    assert.equal(u.test_account_created_by, owner.id);
    assert.equal(u.exclude_podium, true);
    assert.equal(u.has_platform_access, true);
    assert.equal(u.invite_generation, null, 'not a release by hand: no invite-tree skips');
    assert.equal((await pool.query('SELECT 1 FROM welcome_dm_queue WHERE user_id = $1', [madeId])).rowCount, 0,
      'marked before access arrived, so the welcome DM trigger skipped it');
    const { rows: [setting] } = await pool.query("SELECT value FROM platform_settings WHERE key = 'journey_left_out'");
    const entry = JSON.parse(setting.value).find((e) => e.userId === madeId);
    assert.deepEqual({ reason: entry.reason, note: entry.note, addedBy: entry.addedBy },
      { reason: 'test', note: 'Release mail copy, round 1', addedBy: owner.id });
    const { rows: [rel] } = await pool.query(
      'SELECT t.used_by, w.linked_user_id FROM test_waitlist_releases t JOIN waitlist_signups w ON w.id = t.signup_id WHERE w.email = $1',
      [alias]
    );
    assert.deepEqual(rel, { used_by: madeId, linked_user_id: String(madeId) });

    const accounts = await testAccounts.list(pool);
    const listed = accounts.find((a) => a.userId === madeId);
    assert.equal(listed.email, alias);
    assert.equal(listed.note, 'Release mail copy, round 1');
    assert.deepEqual(await testAccounts.listReleases(pool), [], 'used, so no longer pending');
  });

  await t.test('sending again to an address with a live test account sends the sign-in version, and reports the throttle', async () => {
    const again = await send({ email: alias.toUpperCase() });
    assert.equal(again.email, alias);
    assert.equal(again.hasAccount, true);
    assert.equal(again.signsInTo, 'release_tester');
    // The first mail went out under a minute ago: the throttle holds this one,
    // and the result says so rather than reading as sent.
    assert.equal(again.mail.status, 'suppressed_rate_limit');
    assert.match(again.mail.error, /waitlist_released/);
    assert.equal(releaseMails(alias).length, 1);
  });

  await t.test('test releases are kept out of the Admin waitlist and the Journey\'s admitted cohorts', async () => {
    const person = await waitlist.joinWaitlist(pool, { email: 'someone.real@example.org' });
    assert.equal(person.created, true);
    // Admin → Waitlist: the list and its count, the search, the export and
    // the analytics see only the real signup.
    const list = await (await call('GET', '/api/v4/admin/waitlist')).json();
    assert.deepEqual(list.data.map((r) => r.email), ['someone.real@example.org']);
    assert.equal(list.meta.total, 1);
    const search = await (await call('GET', `/api/v4/admin/waitlist?q=${encodeURIComponent('+test')}`)).json();
    assert.deepEqual(search.data, []);
    const csv = await (await call('GET', '/api/v4/admin/waitlist/export-csv')).text();
    assert.equal(csv.includes(alias), false);
    assert.ok(csv.includes('someone.real@example.org'));
    const analytics = (await (await call('GET', '/api/v4/admin/waitlist/analytics')).json()).data;
    assert.deepEqual([analytics.totalSignups, analytics.admitted, analytics.waiting], [1, 0, 1]);
    assert.equal(analytics.series.reduce((sum, d) => sum + d.count, 0), 1);
  });

  await t.test('real accounts and real signups are refused, and so are bad input and a missing own address', async () => {
    const real = await realUser({ email: 'Member@Example.net' });
    await assert.rejects(send({ email: 'member@example.net' }), { status: 409, code: 'real_account' });
    await assert.rejects(send({ email: 'someone.real@example.org' }), { status: 409, code: 'real_signup' });
    await assert.rejects(send({ email: 'not an address' }), { status: 400, code: 'invalid_email' });
    await assert.rejects(send({ note: 'x'.repeat(201) }), { status: 400, code: 'note_too_long' });
    await assert.rejects(send({ welcomeDm: 'yes' }), { status: 400, code: 'invalid_request' });
    const noMail = await realUser({ fullAdmin: true });
    await assert.rejects(send({}, noMail.id), { status: 400, code: 'email_required' });
    // Nothing was changed by any of them.
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM test_waitlist_releases');
    assert.equal(n, 1);
    assert.equal((await row(real.id)).test_account_created_at, null);
    // Only a full admin, at the route.
    assert.equal((await call('POST', '/api/test-accounts/release-emails', {}, { who: 'viewer' })).status, 403);
  });

  await t.test('an account that already existed is never linked to a test release, nor let in by one', async () => {
    const pending = await send({ email: 'qa+held@example.com' });
    const waiting = await realUser({ email: 'qa+held@example.com' });
    await pool.query('UPDATE users SET has_platform_access = FALSE WHERE id = $1', [waiting.id]);
    await waitlist.linkUserByEmail(pool, { userId: waiting.id, email: 'qa+held@example.com' });
    const after = await row(waiting.id);
    assert.equal(after.has_platform_access, false);
    assert.equal(after.test_account_created_at, null);
    const { rows: [signup] } = await pool.query('SELECT linked_user_id FROM waitlist_signups WHERE id = $1', [pending.signupId]);
    assert.equal(signup.linked_user_id, null);
    await pool.query('DELETE FROM users WHERE id = $1', [waiting.id]);
  });

  await t.test('welcomeDm lets the welcome DM reach the account the mail makes', async () => {
    const sent = await send({ email: 'qa+welcome@example.com', welcomeDm: true });
    assert.equal(sent.welcomeDm, true);
    const user = await realUser({ email: 'qa+welcome@example.com' });
    await pool.query('UPDATE users SET has_platform_access = FALSE WHERE id = $1', [user.id]);
    await waitlist.linkUserByEmail(pool, { userId: user.id, email: 'qa+welcome@example.com', newAccount: true });
    const u = await row(user.id);
    assert.ok(u.test_account_created_at);
    assert.equal(u.test_account_welcome_dm, true);
    assert.equal(u.has_platform_access, true);
    assert.equal((await pool.query('SELECT 1 FROM welcome_dm_queue WHERE user_id = $1', [user.id])).rowCount, 1);
  });

  await t.test('the cap counts the account a mail would make, not the mails', async () => {
    const live = async () => (await pool.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL')).rows[0].n;
    const fillers = [];
    while (await live() < testAccounts.MAX_LIVE) {
      // eslint-disable-next-line no-await-in-loop
      fillers.push((await testAccounts.create(pool, {}, { actorId: owner.id, config })).userId);
    }
    await assert.rejects(send({ email: 'qa+full@example.com' }), { status: 429, code: 'at_capacity' });
    // An address whose test account is already live makes no new one.
    const resend = await send({ email: 'qa+welcome@example.com' });
    assert.equal(resend.hasAccount, true);
    await pool.query('UPDATE users SET test_account_created_at = NULL WHERE id = ANY($1::int[])', [fillers]);
  });

  await t.test('a release nobody used is withdrawn a week after its last send', async () => {
    const stale = await send({ email: 'qa+stale@example.com' });
    await pool.query("UPDATE test_waitlist_releases SET last_sent_at = NOW() - INTERVAL '8 days' WHERE signup_id = $1", [stale.signupId]);
    await send({ email: 'qa+fresh@example.com' });
    assert.equal((await pool.query('SELECT 1 FROM waitlist_signups WHERE id = $1', [stale.signupId])).rowCount, 0);
    const emails = (await testAccounts.listReleases(pool)).map((r) => r.email);
    assert.ok(emails.includes('qa+fresh@example.com'));
    assert.ok(!emails.includes('qa+stale@example.com'));
    // A pending release is an admitted address with no account, the shape
    // the Journey counts as a newcomer; a test release is nobody's admit.
    const journey = require('../src/services/journey');
    assert.deepEqual((await journey.cohorts(pool, { now: new Date(), leftOutIds: [] })).cohorts, []);
  });

  await t.test('retiring the account deletes its waitlist row and release with it, so the address starts over', async () => {
    const retired = await testAccounts.retire(pool, { userId: madeId, confirmation: 'RETIRE' }, { actorId: owner.id, config });
    assert.equal(retired.userId, madeId);
    assert.equal((await pool.query('SELECT 1 FROM waitlist_signups WHERE LOWER(email) = $1', [alias])).rowCount, 0);
    assert.equal((await pool.query(
      'SELECT 1 FROM test_waitlist_releases t LEFT JOIN waitlist_signups w ON w.id = t.signup_id WHERE w.id IS NULL')).rowCount, 0);
    // The address can take a new release: no row, no account.
    const fresh = await send({ email: alias });
    assert.equal(fresh.hasAccount, false);
  });

  await t.test('no address reaches a test-account or waitlist log line', async () => {
    const ours = logged.filter((line) => /^\["(test-accounts|waitlist)"/.test(line));
    assert.ok(ours.some((line) => line.includes('Test release email sent')));
    for (const line of ours) {
      assert.equal(/@example\.(com|net|org)/i.test(line), false, `logged an address: ${line.slice(0, 200)}`);
    }
  });
});
