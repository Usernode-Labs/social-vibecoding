'use strict';

// #4271: one request, one notification. Since #3952 a request's text tells
// the people it names with @ ('issue_mention'), and somebody who also
// follows the project's new requests ('issue_opened') heard about the same
// request twice, with two buzzes. Against the FULL PostgreSQL schema in a
// throwaway database, through the real code: services/notifications.js
// notifyIssueFiled and the filing route (POST /api/apps/:slug/issues), with
// only GitHub stood in for. The push outbox is the schema's own trigger.
//
// Pinned here:
//   * a follower named in the request gets the mention and not the
//     new-request row, and their phone rings once;
//   * a follower not named gets the new-request row as before;
//   * Direct interactions off and App alerts on: the mention is a quiet row
//     and the new-request row still rings, so the buzz they asked for stays;
//   * both off, or new requests off for the project: the mention alone;
//   * somebody the mention does not reach (they blocked the author) still
//     gets the new-request row, and so does everyone when the push read
//     fails;
//   * the route files both through the one call.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/issue-filed-notify-once-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a request names a follower: one notification, one buzz', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `issue_filed_once_${crypto.randomBytes(6).toString('hex')}`;
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

  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  const github = require('../src/services/github');
  let nextNumber = 4270;
  github.isEnabled = () => true;
  github.createIssue = async (owner, repo, { title }) => {
    nextNumber += 1;
    return { number: nextNumber, title, html_url: `https://github.com/${owner}/${repo}/issues/${nextNumber}` };
  };
  github.noteIssueCreated = () => {};
  const notifications = require('../src/services/notifications');
  const { issueRoutes } = require('../src/routes/issues');

  // A phone for everyone, as tests/issue-mention-notifications-postgres.test.js does.
  await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
  await pool.query(
    `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ('production', 'test-project', TRUE, NOW() - INTERVAL '1 hour')
     ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = NOW() - INTERVAL '1 hour'`
  );

  const users = {};
  const evan = await user('evan');
  const homeroom = await project('homeroom-once', 'Homeroom', evan);
  async function user(username) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [username]
    );
    const who = { id: rows[0].id, username, isAdmin: false };
    users[who.id] = who;
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '1 day')`,
      [who.id, `nsc_${String(who.id).padStart(43, '0')}`, crypto.randomUUID(),
        crypto.randomBytes(32).toString('hex')]
    );
    return who;
  }
  async function project(slug, appName, owner) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ($1, $2, 'running', $3, 'private', 'private', $4) RETURNING id, slug, name`,
      [appName, slug, owner.id, `https://github.com/usernode-bot/${slug}`]
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [rows[0].id, owner.id]
    );
    return rows[0];
  }
  // A member who follows the project (a favourite), with its new requests
  // on or off, and their phone's switches.
  async function follower(username, { newIssues = true, push = {} } = {}) {
    const who = await user(username);
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [homeroom.id, who.id]
    );
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)', [homeroom.id, who.id]);
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled) VALUES ($1, $2, 'new_issues', $3)`,
      [who.id, homeroom.id, newIssues]
    );
    for (const [category, enabled] of Object.entries(push)) {
      await pool.query(
        'INSERT INTO mobile_push_preferences (user_id, category, enabled) VALUES ($1, $2, $3)',
        [who.id, category, enabled]
      );
    }
    return who;
  }

  // What one person got about one request: each row's kind, and its buzzes.
  async function heard(who, issueNumber) {
    const { rows } = await pool.query(
      `SELECT n.kind, COUNT(d.id)::int AS buzzes
         FROM notifications n
         LEFT JOIN mobile_push_deliveries d ON d.notification_id = n.id
        WHERE n.user_id = $1 AND n.app_id = $2 AND n.detail = $3
        GROUP BY n.id, n.kind ORDER BY n.kind`,
      [who.id, homeroom.id, String(issueNumber)]
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.buzzes]));
  }
  const file = (issueNumber, text) => notifications.notifyIssueFiled(pool, {
    appId: homeroom.id, issueNumber, authorId: evan.id, text,
  });

  const snait = await follower('snait');
  const mo = await follower('mo');
  const quiet = await follower('quiet', { push: { direct_interactions: false } });
  const hush = await follower('hush', { push: { direct_interactions: false, app_alerts: false } });
  const casual = await follower('casual', { newIssues: false });
  const blocker = await follower('blocker');
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [blocker.id, evan.id]);

  await t.test('a follower named in the request hears once, as a mention', async () => {
    const { mentions, opened } = await file(101, 'Dark mode\n\n@snait can you look?');
    assert.deepEqual(mentions.map((r) => r.user_id), [snait.id]);
    assert.ok(!opened.some((r) => r.user_id === snait.id), 'not told again that it was filed');
    assert.deepEqual(await heard(snait, 101), { issue_mention: 1 }, 'one row, one buzz');
  });

  await t.test('a follower not named hears about it as before', async () => {
    assert.deepEqual(await heard(mo, 101), { issue_opened: 1 });
    await file(102, 'Dark mode\n\nNobody named here.');
    assert.deepEqual(await heard(snait, 102), { issue_opened: 1 });
    assert.deepEqual(await heard(mo, 102), { issue_opened: 1 });
  });

  await t.test('mention pushes off, new-request pushes on: the buzz they asked for stays', async () => {
    await file(103, '@quiet what do you think?');
    assert.deepEqual(await heard(quiet, 103), { issue_mention: 0, issue_opened: 1 }, 'one buzz, from the new-request row');
  });

  await t.test('both pushes off, or new requests off: the mention alone', async () => {
    await file(104, '@hush and @casual, a look?');
    assert.deepEqual(await heard(hush, 104), { issue_mention: 0 });
    assert.deepEqual(await heard(casual, 104), { issue_mention: 1 }, 'as before #4271');
  });

  await t.test('somebody the mention does not reach still hears it was filed', async () => {
    await file(105, '@blocker ping');
    assert.deepEqual(await heard(blocker, 105), { issue_opened: 1 }, 'they blocked the author, so no mention');
  });

  await t.test('a push read that fails leaves nobody out', async () => {
    const broken = {
      query: (sql, params) => (/CROSS JOIN mobile_push_kind_categories/.test(sql)
        ? Promise.reject(new Error('read failed'))
        : pool.query(sql, params)),
    };
    const rows = await notifications.createIssueOpenedNotifications(broken, {
      appId: homeroom.id, issueNumber: 106, authorId: evan.id, mentioned: [snait.id],
    });
    assert.ok(rows.some((r) => r.user_id === snait.id), 'the duplicate, not a silence');
  });

  await t.test('filing a request through the route tells each person once', async () => {
    const httpApp = express();
    httpApp.use(express.json());
    httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
    httpApp.use(issueRoutes({}));
    server = await new Promise((resolve) => {
      const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/homeroom-once/issues`, {
      method: 'POST',
      headers: { 'x-test-user': String(evan.id), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Mentions in requests', description: 'make them work. @snait lmk wyt' }),
    });
    assert.equal(res.status, 201, await res.text());
    const number = nextNumber;
    // The notifications are not awaited by the response: wait for them.
    let got = {};
    for (let i = 0; i < 50 && !(got.mo && got.snait); i += 1) {
      got = { snait: (await heard(snait, number)).issue_mention, mo: (await heard(mo, number)).issue_opened };
      if (!(got.mo && got.snait)) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await heard(snait, number), { issue_mention: 1 });
    assert.deepEqual(await heard(mo, number), { issue_opened: 1 });
  });
});
