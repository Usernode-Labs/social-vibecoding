'use strict';

// Test accounts end to end against the full PostgreSQL schema
// (services/test-accounts.js, routes/test-accounts.js): what create makes,
// that it signs in through the ordinary form, the cap and the limiter, what
// retire takes down and in which order, and every fence that keeps a test
// account away from real outcomes — the bot DM list across a rename, the
// welcome DM, the active-member denominator and the vote tallies (D1). The
// native sign-in's wallet rule (D2) is in tests/native-installation-postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');
const cookieParser = require('cookie-parser');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// The teardown's best-effort externals are stubbed so the test drops no real
// database and needs no object store; the row delete is real.
const teardownCalls = { drops: [], prefixes: [] };
function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/db-manager'), {
  appDbName: (slug) => `app_${slug}`,
  dropDatabase: async (name) => { teardownCalls.drops.push(name); },
});
stub(require.resolve('../src/services/app-files'), {
  getStore: () => ({ removeAppPrefix: async (appId) => { teardownCalls.prefixes.push(appId); return 0; } }),
});

// Every log line, so the test can prove the password reached none of them.
const logged = [];
const logger = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (...args) => { logged.push(JSON.stringify(args)); };
}

const testAccounts = require('../src/services/test-accounts');
const realTeardown = require('../src/services/app-teardown');
const teardownId = require.resolve('../src/services/app-teardown');

test('test accounts against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'test_accounts_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only' };
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

  let seq = 0;
  async function realUser({ fullAdmin = false } = {}) {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, is_admin, admin_readonly)
       VALUES ($1, 'x', $2, FALSE) RETURNING *`,
      [`person_${seq}`, fullAdmin]
    );
    return u;
  }
  const owner = await realUser({ fullAdmin: true });
  const row = async (id) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
  const make = (body = {}) => testAccounts.create(pool, body, { actorId: owner.id, config });

  // The routes, with the admin signed in, and the ordinary sign-in form.
  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, res, next) => {
    if (req.headers['x-test-user'] === 'admin') req.user = { id: owner.id, username: owner.username, isAdmin: true, canAdminWrite: true };
    if (req.headers['x-test-user'] === 'viewer') req.user = { id: owner.id, username: owner.username, isAdmin: true, canAdminWrite: false };
    next();
  });
  app.use(require('../src/routes/test-accounts').testAccountRoutes(config));
  app.use(require('../src/routes/auth').authRoutes(config));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, who = 'admin') => fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  await t.test('create makes a sign-in-able newcomer with the first-run flags and no history', async () => {
    const res = await call('POST', '/api/test-accounts', { note: 'Plant Pal first run' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { account } = await res.json();
    assert.match(account.username, /^member_[0-9a-f]{18}$/);
    assert.equal(account.needsUsernameChoice, true);
    assert.equal(account.platformAccess, true);
    assert.equal(typeof account.password, 'string');
    assert.ok(account.password.length >= 16);

    const u = await row(account.userId);
    assert.ok(u.test_account_created_at, 'flagged as a test account');
    assert.equal(u.test_account_created_by, owner.id);
    assert.equal(u.password_set, true);
    assert.equal(u.needs_username_choice, true);
    assert.equal(u.needs_communities_choice, true);
    assert.equal(u.getting_started_gate, true);
    assert.equal(u.exclude_podium, true);
    assert.equal(u.tour_done_at, null);
    assert.equal(u.email, null);
    assert.notEqual(u.password, account.password, 'only the hash is stored');
    assert.equal((await pool.query('SELECT 1 FROM user_terms_consents WHERE user_id = $1', [u.id])).rowCount, 0, 'terms still to accept');
    // Let in, the way an invite lets somebody in: no invite-tree skips.
    assert.equal(u.has_platform_access, true);
    assert.equal(u.invite_generation, null);

    // The ordinary sign-in form takes it.
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: account.username, password: account.password }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.id, account.userId);
    const wrong = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: account.username, password: 'not-it-at-all' }),
    });
    assert.equal(wrong.status, 401);

    // The Journey entry and the audit row exist, and the password is in
    // neither, nor in any log line.
    const { rows: [setting] } = await pool.query("SELECT value FROM platform_settings WHERE key = 'journey_left_out'");
    const entry = JSON.parse(setting.value).find((e) => e.userId === account.userId);
    assert.deepEqual({ reason: entry.reason, note: entry.note, addedBy: entry.addedBy }, { reason: 'test', note: 'Plant Pal first run', addedBy: owner.id });
    const { rows: audit } = await pool.query(
      "SELECT actor_user_id, reason, payload FROM support_actions WHERE target_user_id = $1 AND action = 'test_account_create'",
      [account.userId]
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, owner.id);
    assert.equal(audit[0].reason, 'Plant Pal first run');
    for (const text of [setting.value, JSON.stringify(audit), ...logged]) {
      assert.equal(text.includes(account.password), false, 'the password is never written down');
    }
  });

  await t.test('a chosen username, the waiting room, and the refusals', async () => {
    const named = await make({ username: 'qa_tester_one', platformAccess: false });
    assert.equal(named.username, 'qa_tester_one');
    assert.equal(named.needsUsernameChoice, false);
    const u = await row(named.userId);
    assert.equal(u.needs_username_choice, false);
    assert.equal(u.has_platform_access, false, 'left in the waiting room');
    await assert.rejects(make({ username: 'QA_Tester_One' }), { status: 409, code: 'username_taken' });
    await assert.rejects(make({ username: 'bad name!' }), { status: 400, code: 'invalid_username' });
    await assert.rejects(make({ note: 'x'.repeat(201) }), { status: 400, code: 'note_too_long' });
    await assert.rejects(make({ welcomeDm: 'yes' }), { status: 400, code: 'invalid_request' });
    // Only a full admin, at the route.
    assert.equal((await call('POST', '/api/test-accounts', {}, 'viewer')).status, 403);
    assert.equal((await call('GET', '/api/test-accounts', undefined, 'viewer')).status, 403);
    assert.equal((await call('POST', `/api/test-accounts/${named.userId}/retire`, { confirm: 'RETIRE' }, 'viewer')).status, 403);
  });

  await t.test('list shows the live ones with their apps, and never a password', async () => {
    const res = await call('GET', '/api/test-accounts');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.max, 25);
    assert.ok(body.accounts.length >= 2);
    const first = body.accounts.find((a) => a.note === 'Plant Pal first run');
    assert.ok(first);
    assert.equal(first.createdBy, owner.username);
    assert.ok(first.lastActiveAt, 'the sign-in above counts as activity');
    assert.deepEqual(first.apps, []);
    assert.equal(JSON.stringify(body).includes('"password"'), false);
  });

  await t.test('the welcome DM skips a test account unless it was asked for', async () => {
    await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('welcome_dm_enabled', 'on')
      ON CONFLICT (key) DO UPDATE SET value = 'on'`);
    const quiet = await make();
    const welcomed = await make({ welcomeDm: true });
    const queued = async (id) => (await pool.query('SELECT 1 FROM welcome_dm_queue WHERE user_id = $1', [id])).rowCount;
    assert.equal(await queued(quiet.userId), 0);
    assert.equal(await queued(welcomed.userId), 1);
    const person = await realUser();
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [person.id]);
    assert.equal(await queued(person.id), 1, 'a real person is still welcomed');
    await pool.query("UPDATE platform_settings SET value = 'off' WHERE key = 'welcome_dm_enabled'");
  });

  await t.test('the bot DM place follows a first-run rename and is cleared on retire', async () => {
    const dm = await make({ homeroomBotDm: true });
    const members = async () => JSON.parse((await pool.query("SELECT value FROM platform_settings WHERE key = 'homeroom_bot_dm_users'")).rows[0].value);
    assert.ok((await members()).includes(dm.username));
    const usernames = require('../src/services/usernames');
    const chosen = await usernames.chooseFirstUsername(pool, dm.userId, 'Fresh_Tester');
    assert.equal(chosen.username, 'Fresh_Tester');
    const after = await members();
    assert.ok(after.includes('fresh_tester'), 'the place moved to the new name');
    assert.equal(after.includes(dm.username), false, 'and left the old one');
    const retired = await testAccounts.retire(pool, { userId: dm.userId, confirmation: 'RETIRE' }, { actorId: owner.id, config });
    assert.equal(retired.homeroomBotDm, true);
    assert.equal((await members()).includes('fresh_tester'), false, 'retiring frees the place');
  });

  await t.test('retire refuses a real account, takes the apps down first, then anonymises', async () => {
    const person = await realUser();
    await assert.rejects(
      testAccounts.retire(pool, { userId: person.id, confirmation: 'RETIRE' }, { actorId: owner.id, config }),
      { status: 404, code: 'not_test_account' }
    );
    assert.equal((await call('POST', `/api/test-accounts/${person.id}/retire`, { confirm: 'RETIRE' })).status, 404);
    const tester = await make({ note: 'retire me' });
    assert.equal((await call('POST', `/api/test-accounts/${tester.userId}/retire`, {})).status, 400, 'confirm is required');

    const apps = [];
    for (const slug of ['tester-app-a', 'tester-app-b']) {
      apps.push((await pool.query(
        "INSERT INTO apps (name, slug, created_by, status) VALUES ($1, $1, $2, 'running') RETURNING *",
        [slug, tester.userId]
      )).rows[0]);
    }
    const listed = (await testAccounts.list(pool)).find((a) => a.userId === tester.userId);
    assert.deepEqual(listed.apps, [{ slug: 'tester-app-a', status: 'running' }, { slug: 'tester-app-b', status: 'running' }]);

    // An app that cannot be taken down stops the retire before the account.
    stub(teardownId, {
      teardownApp: async (p, c, a) => {
        if (a.slug === 'tester-app-b') throw new Error('runtime unreachable');
        return realTeardown.teardownApp(p, c, a);
      },
    });
    try {
      await assert.rejects(
        testAccounts.retire(pool, { userId: tester.userId, confirmation: 'RETIRE' }, { actorId: owner.id, config }),
        (err) => err.status === 502 && err.code === 'app_delete_failed'
          && JSON.stringify(err.extra.removedApps) === '["tester-app-a"]' && err.extra.failedApp === 'tester-app-b'
      );
    } finally {
      stub(teardownId, realTeardown);
    }
    let u = await row(tester.userId);
    assert.equal(u.anonymised_at, null, 'the account is kept while one of its apps is still up');
    assert.equal((await pool.query('SELECT 1 FROM apps WHERE id = $1', [apps[0].id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM apps WHERE id = $1', [apps[1].id])).rowCount, 1);

    // Again, and it finishes.
    teardownCalls.drops.length = 0;
    const res = await call('POST', `/api/test-accounts/${tester.userId}/retire`, { confirm: 'RETIRE' });
    assert.equal(res.status, 200);
    const { retired } = await res.json();
    assert.deepEqual(retired.appsDeleted, ['tester-app-b']);
    assert.deepEqual(teardownCalls.drops, ['app_tester-app-b'], 'the app database went too');
    u = await row(tester.userId);
    assert.ok(u.anonymised_at, 'anonymised');
    assert.equal(u.password_set, false);
    assert.ok(u.test_account_created_at, 'still reads as a test account');
    assert.equal((await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [tester.userId])).rowCount, 0);
    assert.equal((await pool.query(
      "SELECT 1 FROM support_actions WHERE target_user_id = $1 AND action = 'test_account_retire'", [tester.userId]
    )).rowCount, 1);
    assert.equal((await testAccounts.list(pool)).some((a) => a.userId === tester.userId), false, 'no longer listed');
    await assert.rejects(
      testAccounts.retire(pool, { userId: tester.userId, confirmation: 'RETIRE' }, { actorId: owner.id, config }),
      { status: 409, code: 'already_retired' }
    );
  });

  await t.test('a test account neither raises a real app\'s threshold nor moves its tally (D1)', async () => {
    const activeUsers = require('../src/services/active-users');
    const governance = require('../src/services/governance');
    const { countedVotePredicateSql, currentVotePredicateSql } = require('../src/services/pr-vote-revision');
    const person = await realUser();
    const other = await realUser();
    const tester = await make();
    const insertApp = async (slug, createdBy) => (await pool.query(
      'INSERT INTO apps (name, slug, created_by) VALUES ($1, $1, $2) RETURNING id', [slug, createdBy]
    )).rows[0].id;
    const realApp = await insertApp('real-people-app', person.id);
    const testApp = await insertApp('tester-made-app', tester.userId);
    await pool.query('UPDATE apps SET community_id = NULL WHERE id = ANY($1::int[])', [[realApp, testApp]]);
    for (const appId of [realApp, testApp]) {
      for (const userId of [person.id, other.id, tester.userId]) {
        await pool.query('INSERT INTO app_activity (app_id, user_id, seconds_spent) VALUES ($1, $2, 120)', [appId, userId]);
      }
    }
    assert.equal((await activeUsers.getActiveUserStats(pool, realApp)).active, 2, 'the tester is not in the denominator');
    assert.equal((await activeUsers.getActiveUserStats(pool, testApp)).active, 3, 'on a test-made app it is');
    assert.equal((await activeUsers.listActiveUserIds(pool, realApp)).includes(tester.userId), false,
      'nor asked for a vote or sent the digest: the list matches the denominator');
    assert.deepEqual((await activeUsers.listActiveUserIds(pool, realApp)).sort((x, y) => x - y),
      [person.id, other.id].sort((x, y) => x - y));
    assert.ok((await activeUsers.listActiveUserIds(pool, testApp)).includes(tester.userId),
      'on a test-made app it is asked like anybody');

    const proposal = async (appId) => (await pool.query(
      "INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id", [appId, person.id]
    )).rows[0].id;
    const realSession = await proposal(realApp);
    const testSession = await proposal(testApp);
    for (const sessionId of [realSession, testSession]) {
      await pool.query("INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes'), ($1, $3, 'yes')",
        [sessionId, person.id, tester.userId]);
    }
    assert.deepEqual(await governance.qualifiedCounts(pool, 'pr', realSession, null), { yes: 1, no: 0 });
    assert.deepEqual(await governance.qualifiedCounts(pool, 'pr', testSession, null), { yes: 2, no: 0 });
    assert.deepEqual(await governance.qualifiedCounts(pool, 'pr', realSession, [person.id, tester.userId]), { yes: 1, no: 0 });
    const batch = await governance.qualifiedCountsBatch(pool, 'pr', [realSession, testSession], [person.id, tester.userId]);
    // otherYes is the member floor's count (a Yes from someone other than the
    // author): the test account's uncounted Yes is not one on a real app.
    assert.deepEqual(batch.get(realSession), { yes: 1, no: 0, otherYes: 0 });
    assert.deepEqual(batch.get(testSession), { yes: 2, no: 0, otherYes: 1 });
    assert.deepEqual(await governance.qualifiedCounts(pool, 'pr', realSession, null, { authorId: person.id }),
      { yes: 1, no: 0, otherYes: 0 });
    // The vote is still the voter's own: recorded, current, and shown.
    const { rows: [shown] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE ${currentVotePredicateSql('pv', 'cs')})::int AS current,
              COUNT(*) FILTER (WHERE ${countedVotePredicateSql('pv', 'cs')})::int AS counted,
              BOOL_OR(NOT counts_toward_outcome($2, cs.app_id)) AS uncounted
         FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
        WHERE pv.session_id = $1`,
      [realSession, tester.userId]
    );
    assert.deepEqual(shown, { current: 2, counted: 1, uncounted: true });
    const { rows: [mine] } = await pool.query('SELECT NOT counts_toward_outcome($1, $2) AS uncounted', [person.id, realApp]);
    assert.equal(mine.uncounted, false, 'a real person\'s vote is never flagged');

    // Governance proposals (closing a request and the like) follow the same rule.
    const issueOn = async (appId) => (await pool.query(
      "INSERT INTO issues (app_id, title, kind, created_by) VALUES ($1, 'Close #1', 'close_issue', $2) RETURNING id", [appId, person.id]
    )).rows[0].id;
    const realIssue = await issueOn(realApp);
    const testIssue = await issueOn(testApp);
    for (const issueId of [realIssue, testIssue]) {
      await pool.query("INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'up'), ($1, $3, 'up')",
        [issueId, person.id, tester.userId]);
    }
    assert.deepEqual(await governance.qualifiedCounts(pool, 'issue', realIssue, null), { yes: 1, no: 0 });
    assert.deepEqual(await governance.qualifiedCounts(pool, 'issue', testIssue, null), { yes: 2, no: 0 });
    const issueBatch = await governance.qualifiedCountsBatch(pool, 'issue', [realIssue, testIssue], [person.id, tester.userId]);
    assert.deepEqual(issueBatch.get(realIssue), { yes: 1, no: 0, otherYes: 0 });
    assert.deepEqual(issueBatch.get(testIssue), { yes: 2, no: 0, otherYes: 1 });
    assert.deepEqual(await governance.qualifiedCounts(pool, 'issue', testIssue, null, { authorId: person.id }),
      { yes: 2, no: 0, otherYes: 1 });
  });

  await t.test('the live cap and the per-admin limiter refuse', async () => {
    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL'
    );
    // Top up to the cap directly; the service then refuses the 26th.
    for (let i = n; i < testAccounts.MAX_LIVE; i += 1) {
      await pool.query(
        "INSERT INTO users (username, password, test_account_created_by, test_account_created_at) VALUES ($1, 'x', $2, NOW())",
        [`capfill_${i}`, owner.id]
      );
    }
    await assert.rejects(make(), (err) => err.status === 429 && err.code === 'at_capacity' && err.extra.max === 25);
    const res = await call('POST', '/api/test-accounts', {});
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, 'at_capacity');
    await pool.query("DELETE FROM users WHERE username LIKE 'capfill\\_%'");

    // The limiter: ten creates an hour per admin through the route. Two went
    // through the route above (one at the start, one refused at the cap,
    // which a refusal does not spend).
    let status = 200;
    let made = 1;
    while (status === 200 && made < 20) {
      // eslint-disable-next-line no-await-in-loop
      status = (await call('POST', '/api/test-accounts', {})).status;
      if (status === 200) made += 1;
    }
    assert.equal(status, 429);
    assert.equal(made, 10, 'ten creates an hour, then refused');
    assert.equal((await call('GET', '/api/test-accounts')).status, 200, 'listing has its own room');
  });
});
