'use strict';

// #3952: a request's own text names people with @ ("@snait lmk wyt"), and
// the people named hear about it. Against the FULL PostgreSQL schema in a
// throwaway database, through the real code: services/notifications.js and
// the filing route every in-app request and the connector's create_request
// go through (POST /api/apps/:slug/issues), with only GitHub stood in for.
//
// Pinned here:
//   * a mention tells the person named: one 'issue_mention' row per person
//     per request, its number in `detail`, read back through the bell's own
//     list with who named them, and pushed live;
//   * the author is never told about their own request;
//   * on a private project only its members are told, never a non-member;
//   * an unknown name, the Homeroom bot and a name inside code are nobody;
//   * somebody who blocked the author is not told;
//   * it rings a phone under Direct interactions, on by default;
//   * the text as GitHub stores it (safeMention's guard) reads the same.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/issue-mention-notifications-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('mentions in a request\'s text against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `issue_mention_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  require('../src/db/pool').getPool = () => pool;
  // Every frame a person's sockets would get passes through the bus.
  const frames = [];
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = (kind, routing, data) => frames.push({ kind, routing, data });
  // GitHub, stood in for: the route files the request there first.
  const github = require('../src/services/github');
  const filed = [];
  github.isEnabled = () => true;
  github.createIssue = async (owner, repo, { title, body }) => {
    filed.push({ title: github.safeMention(title), body: github.safeMention(body) });
    return { number: 3950 + filed.length, title, html_url: `https://github.com/${owner}/${repo}/issues/${3950 + filed.length}` };
  };
  github.noteIssueCreated = () => {};
  const notifications = require('../src/services/notifications');
  const { issueRoutes } = require('../src/routes/issues');

  // A phone for whoever needs one, as tests/group-channel-notify-postgres.test.js does.
  await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
  await pool.query(
    `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ('production', 'test-project', TRUE, NOW() - INTERVAL '1 hour')
     ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = NOW() - INTERVAL '1 hour'`
  );
  async function phone(who) {
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '1 day')`,
      [who.id, `nsc_${String(who.id).padStart(43, '0')}`, crypto.randomUUID(),
        crypto.randomBytes(32).toString('hex')]
    );
  }
  const deliveries = async (notificationId) => Number((await pool.query(
    'SELECT COUNT(*)::int AS n FROM mobile_push_deliveries WHERE notification_id = $1', [notificationId]
  )).rows[0].n);

  const users = {};
  async function user(username, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`,
      [username, synthetic]
    );
    users[rows[0].id] = { id: rows[0].id, username, isAdmin: false };
    return users[rows[0].id];
  }
  async function project(slug, appName, owner, { view = 'private' } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ($1, $2, 'running', $3, $4, $4, $5) RETURNING id, slug, name`,
      [appName, slug, owner.id, view, `https://github.com/usernode-bot/${slug}`]
    );
    await member(rows[0], owner);
    return rows[0];
  }
  async function member(app, who) {
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member'`,
      [app.id, who.id]
    );
  }
  const rowsFor = async (who, kind = 'issue_mention') => (await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id', [who.id, kind]
  )).rows;
  const mention = (app, author, issueNumber, text) => notifications.notifyIssueMentions(pool, {
    appId: app.id, issueNumber, authorId: author.id, text,
  });

  const evan = await user('evan');
  const snait = await user('snait');
  const outsider = await user('outsider');
  const blocker = await user('blocker');
  await user('homeroom_bot', { synthetic: true });
  const homeroom = await project('homeroom-im', 'Homeroom', evan);
  await member(homeroom, snait);
  await member(homeroom, blocker);
  await phone(snait);

  await t.test('a mention tells the person named, once, and it rings', async () => {
    const rows = await mention(homeroom, evan, 3952,
      'Allow @mentions to work inside issue texts\n\nallow names to work in requests. @snait lmk wyt');
    assert.equal(rows.length, 1);
    const [row] = await rowsFor(snait);
    assert.equal(row.app_id, homeroom.id);
    assert.equal(row.source_user_id, evan.id);
    assert.equal(row.detail, '3952', 'the request it is in');
    assert.equal(row.read_at, null);
    assert.equal(await deliveries(row.id), 1, 'a phone push under Direct interactions, on by default');
    const { rows: [policy] } = await pool.query(
      `SELECT category, default_enabled FROM mobile_push_kind_categories WHERE kind = 'issue_mention'`);
    assert.deepEqual(policy, { category: 'direct_interactions', default_enabled: true });

    const [listed] = await notifications.listForUser(pool, snait.id, { kinds: ['issue_mention'] });
    const view = notifications.serialize(listed);
    assert.equal(view.kind, 'issue_mention');
    assert.equal(view.sourceUsername, 'evan');
    assert.equal(view.appSlug, 'homeroom-im');
    assert.equal(view.detail, '3952');
    const live = frames.find((f) => f.kind === 'user' && Number(f.routing?.userId) === snait.id
      && f.data?.type === 'notification_new');
    assert.equal(live?.data.notification.kind, 'issue_mention', 'the bell hears it at once');

    assert.deepEqual(await mention(homeroom, evan, 3952, '@snait lmk wyt'), [], 'the same request never rings twice');
    assert.equal((await rowsFor(snait)).length, 1);
    assert.equal((await mention(homeroom, evan, 3953, '@snait and this one?')).length, 1, 'another request is news');
  });

  await t.test('the author is not told about their own request', async () => {
    assert.deepEqual(await mention(homeroom, evan, 3954, 'note to self @evan'), []);
    assert.equal((await rowsFor(evan)).length, 0);
  });

  await t.test('on a private project, a non-member is not told', async () => {
    assert.deepEqual(await mention(homeroom, evan, 3955, '@outsider can you look?'), []);
    assert.equal((await rowsFor(outsider)).length, 0);
    // On a public project, anybody named is.
    const open = await project('open-im', 'Open Garden', evan, { view: 'public' });
    assert.equal((await mention(open, evan, 7, '@outsider can you look?')).length, 1);
  });

  await t.test('an unknown name, the bot and a name in code are nobody', async () => {
    const rows = await mention(homeroom, evan, 3956,
      '@nobody_here and @homeroom_bot, see `@snait` and\n```\n@snait\n```');
    assert.deepEqual(rows, []);
    assert.equal((await rowsFor(snait)).filter((r) => r.detail === '3956').length, 0);
  });

  await t.test('somebody who blocked the author is not told', async () => {
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [blocker.id, evan.id]);
    assert.deepEqual(await mention(homeroom, evan, 3957, '@blocker ping'), []);
  });

  await t.test('text as GitHub stores it reads the same as what was typed', async () => {
    const rows = await mention(homeroom, evan, 3958, github.safeMention('@snait lmk wyt'));
    assert.equal(rows.length, 1);
  });

  await t.test('filing a request tells the people its text names', async () => {
    const httpApp = express();
    httpApp.use(express.json());
    httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
    httpApp.use(issueRoutes({}));
    server = await new Promise((resolve) => {
      const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/homeroom-im/issues`, {
      method: 'POST',
      headers: { 'x-test-user': String(evan.id), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Mentions in requests', description: 'make them work. @snait lmk wyt' }),
    });
    assert.equal(res.status, 201, await res.text());
    const number = filed.length + 3950;
    assert.ok(filed[filed.length - 1].body.includes('@​snait'), 'GitHub still pings nobody (#723)');
    // The notification is not awaited by the response: wait for it.
    let row = null;
    for (let i = 0; i < 50 && !row; i += 1) {
      row = (await rowsFor(snait)).find((r) => r.detail === String(number)) || null;
      if (!row) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(row, 'the person named was told');
    assert.equal(row.source_user_id, evan.id);
    assert.equal(row.app_id, homeroom.id);
  });
});
