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
      assert.deepEqual(got.body.channel, { last_message: null, last_at: null, last_by: null, unread_count: 0 },
        'a collab-public app: the channel row is offered');

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
});
