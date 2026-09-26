'use strict';

// Communities (src/services/communities.js and the "Communities" block at the
// end of src/db/schema.sql) against the REAL schema in a throwaway PostgreSQL
// database: schema.sql applied twice (the boot migration is idempotent), then
// the triggers, the one-time backfill and the service's join/leave/gate.
// Skipped when no server is reachable, and required when TEST_DATABASE_URL is
// set — the same contract as tests/user-merge-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const communities = require('../src/services/communities');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('communities against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'communities_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  let seq = 0;
  async function user({ platform = true, isAdmin = false } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_admin)
       VALUES ($1, 'x', $2, $3) RETURNING id, username, is_admin`,
      [`member_${n}`, platform, isAdmin]
    );
    return rows[0];
  }
  async function app({ createdBy = null, selfHosted = false, view = 'public', collab = 'public' } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [`App ${n}`, `app-${n}`, createdBy, selfHosted, view, collab]
    );
    const { rows: full } = await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id]);
    return full[0];
  }
  const members = async (appId) => (await pool.query(
    `SELECT m.user_id, m.source FROM community_members m JOIN apps a ON a.community_id = m.community_id
      WHERE a.id = $1 ORDER BY m.user_id`, [appId])).rows;
  const collaborate = (appId, userId, status = 'member') => pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (app_id, user_id) DO UPDATE SET status = EXCLUDED.status`, [appId, userId, status]);

  await t.test('every app gets its own community on insert', async () => {
    const a = await app();
    const b = await app();
    assert.ok(a.community_id, 'the insert trigger set community_id');
    assert.notEqual(a.community_id, b.community_id, 'one community per app');
  });

  await t.test('an upsert that updates does not mint an orphan community', async () => {
    const before = Number((await pool.query('SELECT COUNT(*) AS n FROM communities')).rows[0].n);
    await pool.query(
      `INSERT INTO apps (name, slug) VALUES ('Again', 'app-1')
       ON CONFLICT (slug) DO UPDATE SET name = apps.name`
    );
    const after = Number((await pool.query('SELECT COUNT(*) AS n FROM communities')).rows[0].n);
    assert.equal(after, before, 'AFTER INSERT fires only for a row really inserted');
  });

  await t.test('collaborators join, and leave with their collaborator row', async () => {
    const owner = await user();
    const guest = await user();
    const a = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    await collaborate(a.id, owner.id);
    await collaborate(a.id, guest.id, 'invited');
    assert.deepEqual(await members(a.id), [{ user_id: owner.id, source: 'creator' }],
      'a pending invite is not membership');
    await pool.query(`UPDATE app_collaborators SET status = 'member' WHERE app_id = $1 AND user_id = $2`, [a.id, guest.id]);
    assert.deepEqual((await members(a.id)).map((m) => m.source), ['creator', 'collaborator']);
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [a.id, guest.id]);
    assert.deepEqual((await members(a.id)).map((m) => m.user_id), [owner.id]);
  });

  await t.test('a pin joins; taking it off Home does not leave', async () => {
    const fan = await user();
    const a = await app();
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)', [a.id, fan.id]);
    assert.deepEqual(await members(a.id), [{ user_id: fan.id, source: 'favorite' }]);
    await pool.query('DELETE FROM app_favorites WHERE app_id = $1 AND user_id = $2', [a.id, fan.id]);
    assert.equal((await members(a.id)).length, 1, 'unpinning is not leaving');
    const hider = await user();
    await pool.query('INSERT INTO app_favorites (app_id, user_id, hidden) VALUES ($1, $2, TRUE)', [a.id, hider.id]);
    assert.ok(!(await members(a.id)).some((m) => m.user_id === hider.id), 'a hidden row is an opt-out, not a pin');
  });

  await t.test('the platform project takes in everyone with platform access', async () => {
    const early = await user();
    const self = await app({ selfHosted: true });
    assert.ok((await members(self.id)).some((m) => m.user_id === early.id && m.source === 'auto'),
      'accounts that existed when the platform row was seeded');
    const late = await user({ platform: false });
    assert.ok(!(await members(self.id)).some((m) => m.user_id === late.id));
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [late.id]);
    assert.ok((await members(self.id)).some((m) => m.user_id === late.id), 'joined on the false → true edge');
    await communities.leave(pool, self, late.id);
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [late.id]);
    assert.ok(!(await members(self.id)).some((m) => m.user_id === late.id),
      'a redundant re-grant does not put back someone who left');
  });

  await t.test('join, leave and audience through the service', async () => {
    const owner = await user();
    const joiner = await user();
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    let m = await communities.getMembership(pool, a, joiner.id);
    assert.equal(m.is_member, false);
    assert.equal(m.audience, 'open');
    assert.equal(m.audience_label, 'Community');
    await communities.join(pool, a, joiner.id);
    m = await communities.getMembership(pool, a, joiner.id);
    assert.equal(m.is_member, true);
    assert.equal(m.member_count, 2);
    const pin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = $1 AND user_id = $2', [a.id, joiner.id]);
    assert.equal(pin.rows[0]?.hidden, false, 'joining pins the app to Home, as Add did');
    assert.deepEqual(await communities.leave(pool, a, owner.id), {
      ok: false, status: 409, error: 'You started this project, so you can’t leave it.',
    });
    assert.deepEqual(await communities.leave(pool, a, joiner.id), { ok: true });
    assert.equal(await communities.isMember(pool, a.id, joiner.id), false);
    assert.equal((await pool.query('SELECT 1 FROM app_favorites WHERE app_id = $1 AND user_id = $2', [a.id, joiner.id])).rows.length, 0);

    const solo = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    await collaborate(solo.id, owner.id);
    assert.equal((await communities.getMembership(pool, solo, owner.id)).audience, 'solo');
    await collaborate(solo.id, joiner.id, 'invited');
    assert.equal((await communities.getMembership(pool, solo, owner.id)).audience, 'invited',
      'an invite makes it a group before it is accepted');
  });

  await t.test('the gate refuses a non-member with join_required, and only them', async () => {
    const owner = await user();
    const outsider = await user();
    const adminUser = await user({ isAdmin: true });
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [a.id, owner.id]
    );
    const guard = communities.requireSessionMembership(pool);
    const run = (u) => new Promise((resolve) => {
      const res = {
        status(code) { this.code = code; return this; },
        json(body) { resolve({ code: this.code, body }); },
      };
      guard({ params: { id: String(rows[0].id) }, user: u && { id: u.id, isAdmin: !!u.is_admin } }, res,
        () => resolve({ next: true }));
    });
    assert.deepEqual(await run(owner), { next: true });
    assert.deepEqual(await run(adminUser), { next: true }, 'admins pass, as they pass every access check');
    const refused = await run(outsider);
    assert.equal(refused.code, 403);
    assert.equal(refused.body.code, 'join_required');
    assert.equal(refused.body.app.slug, a.slug);
    await communities.join(pool, a, outsider.id);
    assert.deepEqual(await run(outsider), { next: true });

    const hidden = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    const { rows: priv } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [hidden.id, owner.id]
    );
    const outcome = await new Promise((resolve) => {
      guard({ params: { id: String(priv[0].id) }, user: { id: outsider.id } },
        { status() { return this; }, json(body) { resolve(body); } }, () => resolve('next'));
    });
    assert.equal(outcome, 'next', 'a private app is the collab guard\'s to refuse, without naming it');
  });

  await t.test('the routes: community card, Join and Leave, and the /api/apps fields', async () => {
    const express = require('express');
    const { getPool } = require('../src/db/pool');
    const { appRoutes } = require('../src/routes/apps');
    const owner = await user();
    const viewer = await user();
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    const config = { databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true };
    const server = express();
    server.use(express.json());
    let as = viewer;
    server.use((req, _res, next) => { req.user = { id: as.id, username: as.username, isAdmin: false }; next(); });
    server.use(appRoutes(config));
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, '127.0.0.1', () => resolve(l));
    });
    // Closed at the end of THIS subtest, not in an after hook: the outer
    // test's hook drops the database, and it would run first and find the
    // router's pool still connected.
    const done = async () => {
      listener.close();
      await getPool(config).end().catch(() => {});
    };
    try {
      const base = `http://127.0.0.1:${listener.address().port}`;
      const call = async (method, p, body) => {
        const res = await fetch(base + p, {
          method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
      };

      let got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.status, 200);
      assert.equal(got.body.is_member, false);
      assert.equal(got.body.audience_label, 'Community');
      assert.deepEqual(got.body.members.map((m) => m.username), [owner.username]);
      assert.deepEqual(got.body.approval, { policy: 'anyone', approvals_required: null, electorate: 1, required: 1 });
      assert.deepEqual(got.body.channel, {
        last_message: null, last_at: null, last_by: null, unread_count: 0,
        recent: [], href: `#messages/app/${a.slug}`, handle: null,
        post_url: `/api/apps/${a.slug}/messages`,
      }, 'a collab-public app: its channel is offered, with its last few messages, its address and where the hub posts');
      const { daily, ...counts } = got.body.activity;
      assert.deepEqual(counts, { active_week: 0, shipped_month: 0 },
        'and Members & activity\'s two numbers');
      assert.equal(daily.length, 14, 'and its fourteen days');
      assert.ok(daily.every((d) => d.n === 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
      assert.equal(got.body.can_manage, false, 'a viewer cannot propose who it is for');
      assert.equal(got.body.audience_change, null);

      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: 'yes' });
      assert.equal(got.status, 400, 'joined must be a boolean');
      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: true });
      assert.equal(got.status, 200);
      assert.equal(got.body.is_member, true);
      assert.equal(got.body.member_count, 2);

      const listed = (await call('GET', '/api/apps')).body.apps.find((x) => x.slug === a.slug);
      assert.equal(listed.is_member, true);
      assert.equal(listed.member_count, 2);
      assert.equal(listed.audience, 'open');
      assert.ok(listed.last_active_at, 'joining is activity, so the Workshop can order by it');
      assert.equal(listed.is_favorited, true, 'and Join pinned it, as Add did');

      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: false });
      assert.equal(got.body.is_member, false);
      as = owner;
      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: false });
      assert.equal(got.status, 409, 'the creator cannot leave');

      // WHO IT IS FOR, AS SOMETHING TO CHANGE: offered to whoever the
      // visibility PR route lets open one, on an app with a repository.
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.body.can_manage, false, 'no repository, no proposal to open');
      await pool.query(`UPDATE apps SET repo_url = 'https://github.com/o/r' WHERE id = $1`, [a.id]);
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.body.can_manage, true, 'the creator may propose it');
      assert.equal(got.body.audience_change, null);
      const { rows: pending } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title)
         VALUES ($1, $2, 'promoted', 'visibility/x', 7, 'Make this app private (collaborators only)') RETURNING id`,
        [a.id, owner.id]);
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.deepEqual(got.body.audience_change,
        { session_id: pending[0].id, pr_number: 7, title: 'Make this app private (collaborators only)' },
        'one up for a vote is pointed at, not offered again');

      const hidden = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
      as = viewer;
      assert.equal((await call('GET', `/api/apps/${hidden.slug}/community`)).status, 404,
        'a private app\'s community is as invisible as the app');
      assert.equal((await call('POST', `/api/apps/${hidden.slug}/membership`, { joined: true })).status, 404,
        'and cannot be joined from outside');
    } finally {
      await done();
    }
  });

  await t.test('the vote threshold counts active MEMBERS, and the gates cover taking part', async () => {
    const activeUsers = require('../src/services/active-users');
    const owner = await user();
    const joined = await user();
    const visitor = await user();
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    await communities.join(pool, a, joined.id);
    for (const u of [owner, joined, visitor]) {
      await pool.query(
        `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)`,
        [a.id, u.id]
      );
    }
    assert.equal((await activeUsers.getActiveUserStats(pool, a.id)).active, 2,
      'the visitor used the app but never joined, so a proposal needs no vote of theirs');
    assert.deepEqual((await activeUsers.listActiveUserIds(pool, a.id)).sort((x, y) => x - y),
      [owner.id, joined.id].sort((x, y) => x - y), 'and is not asked for one');
    assert.equal(await activeUsers.isUserActive(pool, a.id, visitor.id), false);
    assert.equal(await activeUsers.isUserActive(pool, a.id, joined.id), true);

    const run = (mw, params, u) => new Promise((resolve) => {
      const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
      mw({ params, user: u && { id: u.id, isAdmin: !!u.is_admin } }, res, () => resolve({ next: true }));
    });
    const bySlug = communities.requireAppMembership(pool);
    assert.equal((await run(bySlug, { slug: a.slug }, visitor)).body.code, 'join_required',
      'starting a change, filing a request and posting are refused to a non-member');
    assert.deepEqual(await run(bySlug, { slug: a.slug }, joined), { next: true });
    assert.deepEqual(await run(bySlug, { slug: 'no-such-app' }, visitor), { next: true },
      'an unknown slug is the route\'s own 404');
    const { rows: iss } = await pool.query(
      `INSERT INTO issues (app_id, title, created_by) VALUES ($1, 'A request', $2) RETURNING id`, [a.id, owner.id]
    );
    const byIssue = communities.requireIssueMembership(pool);
    assert.equal((await run(byIssue, { id: String(iss[0].id) }, visitor)).body.code, 'join_required',
      'voting on a request is voting');
    assert.deepEqual(await run(byIssue, { id: String(iss[0].id) }, joined), { next: true });
    const frame = await communities.chatNeedsJoin(pool, a.id, visitor);
    assert.equal(frame.code, 'join_required', 'the WebSocket chat write is answered, not dropped');
    assert.equal(await communities.chatNeedsJoin(pool, a.id, joined), null);
  });

  await t.test('deleting an app drops its community', async () => {
    const a = await app();
    await pool.query('DELETE FROM apps WHERE id = $1', [a.id]);
    const { rows } = await pool.query('SELECT 1 FROM communities WHERE id = $1', [a.community_id]);
    assert.equal(rows.length, 0);
  });

  await t.test('the backfill runs once and takes in today\'s participants', async () => {
    // A second database state: rows written with the marker absent, as on
    // the first boot after this ships.
    const owner = await user();
    const regular = await user();
    const voter = await user();
    const a = await app({ createdBy: owner.id });
    await pool.query('DELETE FROM community_members');
    await pool.query(`DELETE FROM platform_settings WHERE key = 'community_members_backfilled'`);
    await collaborate(a.id, owner.id);
    await pool.query('DELETE FROM community_members');
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES
         ($1, $2, CURRENT_DATE - 30, 120), ($1, $2, CURRENT_DATE - 2, 5)`,
      [a.id, regular.id]
    );
    const { rows: s } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [a.id, owner.id]
    );
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s[0].id, voter.id]);
    await pool.query(schema);
    const got = await members(a.id);
    assert.deepEqual(got.map((m) => [m.user_id, m.source]), [
      [owner.id, 'creator'], [regular.id, 'active'], [voter.id, 'voter'],
    ]);
    await communities.leave(pool, a, regular.id);
    await pool.query(schema);
    assert.ok(!(await members(a.id)).some((m) => m.user_id === regular.id), 'the marker keeps a leaver out');
  });
  await t.test('#general is the Homeroom community\'s channel: members post, everyone reads; its old channel is archived', async () => {
    const owner = await user();
    const member = await user();
    const boss = await user({ isAdmin: true });
    const self = await app({ createdBy: owner.id, selfHosted: true });
    // Everyone let onto the platform joins Homeroom's community on the way
    // in (join_platform_community), so the outsider is one who left it.
    const outsider = await user();
    await communities.leave(pool, self, outsider.id);
    const other = await app({ createdBy: owner.id });
    await communities.join(pool, self, member.id);
    const { rows: room } = await pool.query(`SELECT id FROM conversations WHERE channel_key = 'general'`);
    const general = room[0].id;
    const asUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin });

    // POSTING needs the Homeroom community; an admin passes, as everywhere.
    const refused = await communities.generalNeedsJoin(pool, general, asUser(outsider), self.slug);
    assert.equal(refused && refused.code, 'join_required');
    assert.equal(refused.app.slug, self.slug, 'the Join it offers is Homeroom\'s');
    assert.equal(await communities.generalNeedsJoin(pool, general, asUser(member), self.slug), null);
    assert.equal(await communities.generalNeedsJoin(pool, general, asUser(boss), self.slug), null);
    // Only #general: a group conversation is nobody's community channel.
    const { rows: group } = await pool.query(
      `INSERT INTO conversations (kind, title) VALUES ('group', 'Friends') RETURNING id`);
    assert.equal(await communities.generalNeedsJoin(pool, group[0].id, asUser(outsider), self.slug), null);

    // THE OLD CHANNEL is the platform row's, and only its.
    assert.equal(await communities.channelArchived(pool, self.id), true);
    assert.equal(await communities.channelArchived(pool, other.id), false);

    // The hub's preview: the newest three, oldest first, and unread behind
    // the reader's cursor (none for someone who never opened the room).
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status, last_read_message_id)
       VALUES ($1, $2, 'member', 'member', NULL)`, [general, member.id]);
    for (const text of ['one', 'two', 'three', 'four']) {
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)`,
        [general, owner.id, text]);
    }
    const summary = await communities.generalChannelSummary(pool, member.id);
    assert.equal(summary.conversation_id, general);
    assert.deepEqual(summary.recent.map((m) => m.content), ['two', 'three', 'four']);
    assert.equal(summary.recent[2].by, owner.username);
    assert.equal(summary.last_message, 'four');
    assert.equal(summary.unread_count, 4);
    assert.equal((await communities.generalChannelSummary(pool, outsider.id)).unread_count, 0);

    // An app's own channel carries the same preview.
    for (const text of ['hello', 'there']) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3)`, [other.id, member.id, text]);
    }
    const chan = await communities.channelSummary(pool, other.id, owner.id);
    assert.deepEqual(chan.recent.map((m) => [m.content, m.by]), [['hello', member.username], ['there', member.username]]);

    // Members & activity: who did something this week, what shipped this month.
    const { rows: s } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, merged_at) VALUES ($1, $2, 'merged', NOW()) RETURNING id`,
      [other.id, owner.id]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s[0].id, boss.id]);
    const { daily, ...counts } = await communities.activitySummary(pool, other.id);
    assert.deepEqual(counts, { active_week: 3, shipped_month: 1 });
    // The trend: fourteen days, oldest first, today last, each the number of
    // different people who said something, started a change or voted.
    assert.equal(daily.length, 14);
    assert.deepEqual(daily.slice(0, 13).map((d) => d.n), Array(13).fill(0));
    assert.equal(daily[13].n, 3, 'today: the member who talked, the owner who started, the admin who voted');
    const { rows: [{ today }] } = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    assert.equal(daily[13].day, today);

    // THE PLATFORM'S EVENTS GO TO #general. A vote announcement or a merge
    // line for Homeroom's own app is Homeroom's line in #general, with the
    // proposal's card, and not a row in the read-only old channel.
    const conversations = require('../src/services/conversations');
    const ws = require('../src/services/ws');
    const { rows: prop } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, 'promoted', 41, 'Dark mode') RETURNING id`,
      [self.id, owner.id]);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [self.id])).rows[0].n;
    await ws.sendSystemMessage(pool, self.id, `${owner.username} promoted PR #41: Dark mode for voting`, 'vote',
      { vote: { sessionId: prop[0].id, prNumber: 41 } });
    await ws.sendSystemMessage(pool, self.id, 'Dark mode merged (PR #41) and will be live in a few minutes.', 'system',
      { merged: { sessionId: prop[0].id, prNumber: 41, title: 'Dark mode' } });
    // Its own thread keeps its copy, and a row the channel never drew stays put.
    await ws.sendSystemMessage(pool, self.id, 'thread copy', 'vote',
      { vote: { sessionId: prop[0].id, prNumber: 41 } }, { type: 'session', ref: prop[0].id });
    await ws.sendSystemMessage(pool, self.id, 'an undrawn row', 'system', null);
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [self.id])).rows[0].n;
    assert.equal(after - before, 2, 'only the thread copy and the undrawn row reach the old room');
    const { rows: events } = await pool.query(
      `SELECT m.id, m.sender_id, m.msg_type, m.content, o.object_type, o.object_ref, o.app_id
         FROM conversation_messages m
         LEFT JOIN conversation_message_objects o ON o.message_id = m.id
        WHERE m.conversation_id = $1 AND m.msg_type = 'system' ORDER BY m.id`, [general]);
    assert.deepEqual(events.map((e) => [e.sender_id, e.object_type, e.object_ref, e.app_id]), [
      [null, 'code_proposal', prop[0].id, self.id],
      [null, 'code_proposal', prop[0].id, self.id],
    ]);
    assert.match(events[0].content, /promoted PR #41: Dark mode for voting/);
    // Not a person's message: it rings nobody and counts as nobody's unread.
    assert.equal((await communities.generalChannelSummary(pool, member.id)).unread_count, 4,
      'the four messages from before, not the two events');
    assert.deepEqual((await communities.generalChannelSummary(pool, member.id)).recent.map((m) => m.content),
      ['two', 'three', 'four'], 'and the hub\'s preview is people talking');
    const { rows: rung } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE conversation_message_id = ANY($1::int[])`,
      [events.map((e) => e.id)]);
    assert.equal(rung[0].n, 0);
    // Drawn as Homeroom's, with the proposal's card for someone who may see it.
    const shown = await conversations.getMessage(pool, asUser(boss), general, events[0].id);
    assert.equal(shown.system, true);
    assert.equal(shown.sender.username, 'Homeroom');
    assert.equal(shown.objects.length, 1);
    // Another app's events stay in its own room.
    const otherBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [other.id])).rows[0].n;
    await ws.sendSystemMessage(pool, other.id, 'promoted PR #2', 'vote', { vote: { sessionId: s[0].id, prNumber: 2 } });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [other.id])).rows[0].n,
      otherBefore + 1);
  });
});
