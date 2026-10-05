'use strict';

// Invite links against a real PostgreSQL (services/community-invites.js and
// the "Communities, stage 6: invite links" block of src/db/schema.sql).
//
// The block is lifted out of schema.sql and run as written, in a scratch
// schema beside the few tables it reads, so what is tested is the SQL that
// ships: apply_community_invite() and the trigger that applies a queued
// invite when an account is let in, however that happens.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `invites_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

/** The invite-links block of schema.sql, as it ships. */
function stageSixBlock() {
  const start = SCHEMA_SQL.indexOf('-- ── Communities, stage 6: invite links');
  assert.ok(start > 0, 'the invite-links block must be findable in schema.sql');
  const end = SCHEMA_SQL.indexOf('\n-- ── ', start + 10);
  assert.ok(end > start, 'and it must end at the next block');
  return SCHEMA_SQL.slice(start, end);
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL, display_name TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      has_platform_access BOOLEAN NOT NULL DEFAULT FALSE,
      platform_access_granted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE,
      getting_started_seen JSONB);
    CREATE TABLE communities (id SERIAL PRIMARY KEY);
    CREATE TABLE apps (
      id SERIAL PRIMARY KEY, slug TEXT NOT NULL, name TEXT,
      created_by INTEGER, self_hosted BOOLEAN NOT NULL DEFAULT FALSE,
      collab_visibility TEXT NOT NULL DEFAULT 'public',
      view_visibility TEXT NOT NULL DEFAULT 'public',
      icon_emoji TEXT, icon_image_id TEXT,
      manifest_snapshot JSONB, featured_illustration JSONB,
      approver_policy TEXT NOT NULL DEFAULT 'anyone', approvals_required INTEGER,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      community_id INTEGER REFERENCES communities(id));
    -- WP-D: the sketch a project still being built shows (pictureFor).
    CREATE TABLE app_sketches (
      app_id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      design JSONB, html TEXT, model TEXT, error TEXT, committed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ready_at TIMESTAMPTZ);
    -- What the page's picture reads (community-invites.js pictureFor).
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY, app_id INTEGER, merged_at TIMESTAMPTZ,
      shots_state TEXT, shots_run_id TEXT);
    CREATE TABLE shot_runs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE shot_artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, story_id TEXT NOT NULL,
      side TEXT NOT NULL, variant TEXT NOT NULL, media TEXT NOT NULL,
      content_type TEXT NOT NULL, data BYTEA NOT NULL, sha256 TEXT NOT NULL,
      width INTEGER, height INTEGER);
    CREATE TABLE app_illustrations (app_id INTEGER PRIMARY KEY, id TEXT NOT NULL, dark_id TEXT);
    CREATE TABLE community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source VARCHAR(16) NOT NULL DEFAULT 'joined',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (community_id, user_id));
    CREATE TABLE app_collaborators (
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'member',
      invited_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ,
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_favorites (
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_admins (app_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE events (
      id SERIAL PRIMARY KEY, user_id INTEGER, app_id INTEGER, session_id INTEGER,
      event_type TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
  `);
  await pool.query(stageSixBlock());
  // The fixture: ada (who had access before the invite tree), an open
  // community and a group.
  await pool.query(`
    INSERT INTO users (id, username, has_platform_access, is_admin) VALUES
      (1, 'ada', TRUE, FALSE), (2, 'bo', TRUE, FALSE), (3, 'cy', FALSE, FALSE),
      (4, 'dee', TRUE, FALSE), (5, 'eve', FALSE, FALSE), (6, 'fay', FALSE, FALSE),
      (7, 'gus', FALSE, FALSE), (9, 'root', TRUE, TRUE);
    UPDATE users SET display_name = 'Ada' WHERE id = 1;
    SELECT setval(pg_get_serial_sequence('users', 'id'), 20);
    INSERT INTO communities (id) VALUES (1), (2);
    INSERT INTO apps (id, slug, name, created_by, collab_visibility, view_visibility, community_id) VALUES
      (1, 'arena', 'Arena', 1, 'public', 'public', 1),
      (2, 'book-club', 'Book Club', 1, 'private', 'private', 2);
    INSERT INTO community_members (community_id, user_id, source) VALUES (1, 1, 'creator'), (2, 1, 'creator');
    INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 1, 'member');
  `);
  return { pool };
}

async function dropSchema(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

const ADA = { id: 1, username: 'ada', isAdmin: false, hasPlatformAccess: true };
const as = (id, username, hasPlatformAccess) => ({ id, username, isAdmin: false, hasPlatformAccess });
const APP_COLUMNS = 'id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id';

test('invite links against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool } = setup;
  const invites = require('../src/services/community-invites');
  const waitlist = require('../src/services/waitlist');
  const app = async (slug) => (await pool.query(`SELECT ${APP_COLUMNS} FROM apps WHERE slug = $1`, [slug])).rows[0];
  const member = async (communityId, userId) => (await pool.query(
    'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, userId])).rows.length === 1;
  const saved = { budgets: process.env.INVITE_TREE_BUDGETS };
  try {
    let token;
    await t.test('a member makes a link; somebody outside the project cannot', async () => {
      const arena = await app('arena');
      const refused = await invites.createInvite(pool, { app: arena, user: as(2, 'bo', true) });
      assert.equal(refused.status, 403);
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 2, maxUses: 2 });
      assert.ok(made.ok);
      assert.match(made.link.token, invites.TOKEN_RE);
      assert.equal(made.link.path, `/invite/${made.link.token}`);
      assert.equal((await invites.createInvite(pool, { app: arena, user: ADA, days: 31 })).status, 400, 'days past the limit');
      assert.equal((await invites.createInvite(pool, { app: arena, user: ADA, maxUses: -1 })).status, 400, 'uses below it');
      token = made.link.token;
      const preview = await invites.preview(pool, token);
      assert.deepEqual(
        { live: preview.live, name: preview.project.name, inviter: preview.inviter, memberCount: preview.memberCount },
        { live: true, name: 'Arena', inviter: 'ada', memberCount: 1 },
      );
      assert.equal(preview.project.slug, undefined, 'the address comes after joining');
    });

    await t.test('somebody with access joins on the spot, pinned like Join; following again spends nothing', async () => {
      const bo = as(2, 'bo', true);
      // A new account, still to answer the join screen: the link answers it.
      await pool.query('UPDATE users SET needs_communities_choice = TRUE WHERE id = 2');
      const joined = await invites.redeem(pool, { token, user: bo });
      const answered = await pool.query(
        "SELECT needs_communities_choice, getting_started_seen->>'join_answer' AS answer FROM users WHERE id = 2");
      assert.deepEqual(answered.rows, [{ needs_communities_choice: false, answer: 'invite' }]);
      // The standing says when, and that the account is about as old as that.
      const standing = await invites.standing(pool, token, bo);
      assert.equal(standing.mine, 'joined');
      assert.ok(Date.now() - Date.parse(standing.joinedAt) < 60 * 1000);
      assert.equal(standing.newAccount, true);
      assert.deepEqual([joined.status, joined.slug, joined.name], ['joined', 'arena', 'Arena']);
      assert.equal(await member(1, 2), true);
      const pin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = 1 AND user_id = 2');
      assert.deepEqual(pin.rows, [{ hidden: false }]);
      assert.equal((await invites.redeem(pool, { token, user: bo })).status, 'member');
      const { rows } = await pool.query('SELECT uses FROM community_invites WHERE token = $1', [token]);
      assert.equal(rows[0].uses, 1);
    });

    await t.test('somebody still waiting is queued, and letting them in joins them (the trigger)', async () => {
      const cy = as(3, 'cy', false);
      const queued = await invites.redeem(pool, { token, user: cy });
      assert.deepEqual([queued.status, queued.slug, queued.skippedWaitlist], ['queued', null, false]);
      assert.equal(await member(1, 3), false, 'not before they are let in');
      assert.deepEqual(await invites.queuedFor(pool, 3), [{ name: 'Arena', inviter: 'ada' }]);
      assert.equal((await invites.redeem(pool, { token, user: cy })).status, 'queued', 'a second follow is the same row');
      await waitlist.grantPlatformAccess(pool, 3, { manualRelease: true });
      assert.equal(await member(1, 3), true, 'joined the moment access was granted');
      const { rows } = await pool.query('SELECT status, applied_at IS NOT NULL AS applied FROM community_invite_redemptions WHERE user_id = 3');
      assert.deepEqual(rows, [{ status: 'joined', applied: true }]);
      const gen = await pool.query('SELECT invite_generation FROM users WHERE id = 3');
      assert.equal(gen.rows[0].invite_generation, 0, 'let off the waitlist by hand is generation 0');
    });

    await t.test('a link used as often as it allows is dead, and says only why', async () => {
      const refused = await invites.redeem(pool, { token, user: as(4, 'dee', true) });
      assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 410, 'used_up']);
      assert.deepEqual(await invites.preview(pool, token), { live: false, reason: 'used_up' });
    });

    await t.test('a group\'s link makes a collaborator; turning it off cancels who it queued', async () => {
      const group = await app('book-club');
      const made = await invites.createInvite(pool, { app: group, user: ADA });
      const joined = await invites.redeem(pool, { token: made.link.token, user: as(4, 'dee', true) });
      assert.equal(joined.status, 'joined');
      const collab = await pool.query('SELECT status, invited_by FROM app_collaborators WHERE app_id = 2 AND user_id = 4');
      assert.deepEqual(collab.rows, [{ status: 'member', invited_by: 1 }]);
      assert.equal(await member(2, 4), true);
      assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(5, 'eve', false) })).status, 'queued');
      assert.equal((await invites.revokeInvite(pool, { inviteId: made.link.id, user: as(2, 'bo', true) })).status, 404,
        'a stranger cannot, and is not told it exists');
      assert.deepEqual(await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA }), { ok: true, cancelled: 1 });
      await waitlist.grantPlatformAccess(pool, 5);
      const none = await pool.query('SELECT 1 FROM app_collaborators WHERE app_id = 2 AND user_id = 5');
      assert.equal(none.rows.length, 0, 'a cancelled invite is not applied on release');
      assert.equal((await invites.preview(pool, made.link.token)).reason, 'revoked');
    });

    await t.test('a link dies with its maker\'s standing, and so does a queued invite from it', async () => {
      const group = await app('book-club');
      await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 2, 'member')");
      await pool.query("INSERT INTO community_members (community_id, user_id) VALUES (2, 2) ON CONFLICT DO NOTHING");
      const made = await invites.createInvite(pool, { app: group, user: as(2, 'bo', true) });
      assert.ok(made.ok);
      assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(7, 'gus', false) })).status, 'queued');
      // bo is removed from the group.
      await pool.query('DELETE FROM app_collaborators WHERE app_id = 2 AND user_id = 2');
      assert.deepEqual(await invites.preview(pool, made.link.token), { live: false, reason: 'revoked' });
      const refused = await invites.redeem(pool, { token: made.link.token, user: as(4, 'dee', true) });
      assert.equal(refused.status, 'member', 'dee is already in it from ada\'s link, so nothing to refuse');
      const stranger = await pool.query("INSERT INTO users (username, has_platform_access) VALUES ('hal', TRUE) RETURNING id");
      const hal = await invites.redeem(pool, { token: made.link.token, user: as(stranger.rows[0].id, 'hal', true) });
      assert.deepEqual([hal.ok, hal.reason], [false, 'revoked']);
      await waitlist.grantPlatformAccess(pool, 7);
      const none = await pool.query('SELECT 1 FROM app_collaborators WHERE app_id = 2 AND user_id = 7');
      assert.equal(none.rows.length, 0, 'gus, queued on it, is not added on release');
      // Put gus back on the waitlist for the tree case below.
      await pool.query('UPDATE users SET has_platform_access = FALSE, invite_generation = NULL WHERE id = 7');
      await pool.query('DELETE FROM community_invite_redemptions WHERE user_id = 7');
    });

    await t.test('a link carries its maker\'s note, and its page shows the project: an after-shot, else the card image', async () => {
      const group = await app('book-club');
      const refused = await invites.createInvite(pool, { app: group, user: ADA, note: 'x'.repeat(281) });
      assert.equal(refused.status, 400);
      const made = await invites.createInvite(pool, { app: group, user: ADA, note: '  Come  read with us! ' });
      assert.equal(made.link.note, 'Come read with us!');
      await pool.query(`UPDATE apps SET manifest_snapshot = '{"description":"Our monthly pick"}' WHERE id = 2`);
      let preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(
        [preview.inviterName, preview.inviterMadeIt, preview.note, preview.project.description, preview.project.picture],
        ['Ada', true, 'Come read with us!', 'Our monthly pick', null],
      );
      assert.equal(await invites.pictureBytes(pool, made.link.token), null, 'nothing to show yet');
      // The card image its group chose, served by its own id.
      await pool.query(`UPDATE apps SET featured_illustration = '{"zoom":1,"x":0,"y":0}' WHERE id = 2`);
      await pool.query(`INSERT INTO app_illustrations (app_id, id, dark_id) VALUES (2, 'light1', 'dark1')`);
      preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(preview.project.picture, { kind: 'illustration', url: '/app-illustrations/light1', darkUrl: '/app-illustrations/dark1' });
      // A merged change's phone-shaped after-shot wins; an unmerged one, a
      // before-shot or a landscape one never shows.
      await pool.query(`
        INSERT INTO shot_runs (id, state) VALUES ('r1', 'verified'), ('r2', 'verified');
        INSERT INTO chat_sessions (id, app_id, merged_at, shots_state, shots_run_id) VALUES
          (1, 2, NOW() - INTERVAL '1 day', 'verified', 'r1'),
          (2, 2, NULL, 'verified', 'r2');
        INSERT INTO shot_artifacts (id, run_id, story_id, side, variant, media, content_type, data, sha256, width, height) VALUES
          ('wide', 'r1', 's1', 'head', 'context', 'png', 'image/png', '\\x01', 'aa', 1280, 800),
          ('before', 'r1', 's1', 'base', 'context', 'png', 'image/png', '\\x02', 'bb', 390, 844),
          ('phone', 'r1', 's1', 'head', 'context', 'png', 'image/png', '\\x89504e47', 'cc', 390, 844),
          ('unmerged', 'r2', 's1', 'head', 'context', 'png', 'image/png', '\\x03', 'dd', 390, 844);
      `);
      preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(preview.project.picture, { kind: 'shot', url: `/api/public/invites/${made.link.token}/picture`, darkUrl: null });
      const bytes = await invites.pictureBytes(pool, made.link.token);
      assert.deepEqual([bytes.contentType, bytes.sha256, bytes.data.toString('hex')], ['image/png', 'cc', '89504e47']);
      // Turning the link off turns its picture off too.
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      assert.equal(await invites.pictureBytes(pool, made.link.token), null);
    });

    await t.test('WP-D: a link that works until it is turned off, for anyone it reaches', async () => {
      const arena = await app('arena');
      await pool.query(`INSERT INTO users (id, username, has_platform_access) VALUES (11, 'hal', TRUE), (12, 'ivy', TRUE)`);
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 0, maxUses: 0, note: 'Come try it' });
      assert.ok(made.ok);
      assert.deepEqual([made.link.expiresAt, made.link.maxUses], [null, null]);
      const { rows: [row] } = await pool.query('SELECT expires_at, max_uses FROM community_invites WHERE id = $1', [made.link.id]);
      assert.deepEqual(row, { expires_at: null, max_uses: null });
      // The event is written without waiting (events.record), so this link's
      // own row is waited for, not whichever was newest a moment ago.
      let created = null;
      for (let i = 0; i < 40 && !created; i += 1) {
        ({ rows: [created] } = await pool.query(
          `SELECT metadata FROM events
            WHERE event_type = 'invite_link_created' AND (metadata->>'inviteId')::int = $1`, [made.link.id]));
        if (!created) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(created, 'the link\'s own event');
      assert.deepEqual([created.metadata.days, created.metadata.maxUses], [null, null]);
      assert.equal((await invites.preview(pool, made.link.token)).expiresAt, null);
      assert.ok((await invites.listInvites(pool, { app: arena, user: ADA })).links.some((l) => l.id === made.link.id), 'listed as live');
      for (const [id, name] of [[11, 'hal'], [12, 'ivy']]) {
        assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(id, name, true) })).status, 'joined');
      }
      assert.equal((await invites.preview(pool, made.link.token)).live, true, 'still live after it is used');
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      assert.equal((await invites.preview(pool, made.link.token)).reason, 'revoked', 'until it is turned off');
    });

    await t.test('WP-D: a project with no shot yet shows its sketch through a live link, and only then', async () => {
      const arena = await app('arena');
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 0, maxUses: 0 });
      assert.equal((await invites.preview(pool, made.link.token)).project.picture, null);
      assert.equal(await invites.sketchPage(pool, made.link.token), null, 'no sketch yet');
      await pool.query(`INSERT INTO app_sketches (app_id, status, created_at) VALUES (1, 'pending', NOW())`);
      assert.equal((await invites.preview(pool, made.link.token)).project.picture, null, 'one being drawn is not shown');
      await pool.query(`UPDATE app_sketches SET status = 'ready', design = $1, html = $2 WHERE app_id = 1`,
        [JSON.stringify({ job: 'Run the arena', accent: { light: '#c2410c', dark: '#fb923c' } }), '<h1 class="text-title">Arena</h1>']);
      const preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(preview.project.picture, { kind: 'sketch', url: `/api/public/invites/${made.link.token}/sketch.html`, darkUrl: null });
      const page = await invites.sketchPage(pool, made.link.token, { theme: 'dark' });
      assert.match(page, /<title>Arena: a sketch<\/title>/);
      assert.match(page, /<main class="sketch-screen">\n<h1 class="text-title">Arena<\/h1>/);
      assert.match(page, /:root\{--ground:12 10 9;/, 'in the look it was asked for');
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      assert.equal(await invites.sketchPage(pool, made.link.token), null, 'a dead link shows nothing');
    });

    await t.test('WP-D: what joining means, said from the project\'s real rule', async () => {
      const governance = require('../src/services/governance');
      // The default rule is said for the vote's own headcount
      // (active-users.js getActiveUserStats), which reads tables this scratch
      // schema does not carry: it is stood in for here, and read for real in
      // tests/username-invite-join-postgres.test.js. The invites still
      // waiting are counted from app_collaborators, which is here.
      const votes = require('../src/services/active-users');
      const realStats = votes.getActiveUserStats;
      let active = 1;
      votes.getActiveUserStats = async () => ({ active, majority: Math.floor(active / 2) + 1 });
      const rule = async (patch = {}) => {
        await pool.query(`UPDATE apps SET approver_policy = $1, approvals_required = $2, locked = $3 WHERE id = 1`,
          [patch.policy || 'anyone', patch.n ?? null, !!patch.locked]);
        governance.invalidateGovernance(1);
        return invites.joiningRule(pool, { ...(await app('arena')), locked: !!patch.locked });
      };
      try {
        assert.equal(await rule(), 'With one other person using it, a change goes live when you both say yes, '
          + 'or 3 days after one of you says yes if the other doesn\'t answer.');
        assert.equal(await rule({ locked: true }), 'With one other person using it, a change goes live when you both say yes, '
          + 'or 3 days after one of you says yes if the other doesn\'t answer. An admin has to say yes too.');
        assert.equal(await rule({ n: 2 }), 'A change goes live once it has 2 yes votes.');
        assert.equal(await rule({ n: 1, policy: 'invited' }), 'A change goes live once it has a yes from its approvers.');
        assert.equal(await rule({ policy: 'invited' }), 'A change goes live once its approvers back it.');
        // First-session run-through, 5 October 2026: the people in it, and
        // the invites by username still waiting, are counted.
        active = 2;
        assert.equal(await rule(), 'With one other person using it, a change goes live when you both say yes, '
          + 'or 3 days after one of you says yes if the other doesn\'t answer.', 'two: the one other person is in it');
        await pool.query("INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES (1, 4, 'invited', 1)");
        assert.equal(await rule(), 'With 3 people in it, counting 1 invited, a change goes live when 2 of you say yes, '
          + 'or 3 days after the first yes if nobody says no.');
        await pool.query('DELETE FROM app_collaborators WHERE app_id = 1 AND user_id = 4');
        active = 6;
        assert.equal(await rule(), 'With 6 people using it, a change goes live when 3 of you say yes, '
          + 'or 5 days after the first yes if nobody says no.');
        assert.equal(await rule({ locked: true }), 'With 6 people using it, a change goes live when 3 of you say yes, '
          + 'or 5 days after the first yes if nobody says no. An admin has to say yes too.');
      } finally {
        votes.getActiveUserStats = realStats;
        await rule();
      }
    });

    await t.test('THE TREE, on by default: only a release by hand has skips, and invites do not chain', async () => {
      process.env.INVITE_TREE_BUDGETS = '1';
      assert.equal(await invites.treeEnabled(pool), true, 'no setting stored: on');
      const arena = await app('arena');
      const generation = async (id) => (await pool.query('SELECT invite_generation FROM users WHERE id = $1', [id])).rows[0].invite_generation;

      // ada had access before the tree: no generation, so no skips, and her
      // link queues somebody new like it would with the tree off.
      assert.equal(await invites.skipsLeft(pool, ADA), 0);
      const adas = await invites.createInvite(pool, { app: arena, user: ADA });
      const queued = await invites.redeem(pool, { token: adas.link.token, user: as(6, 'fay', false) });
      assert.deepEqual([queued.status, queued.skippedWaitlist], ['queued', false]);
      // Admitting her again by hand gives her none: it is not what let her in.
      await waitlist.grantPlatformAccess(pool, 1, { manualRelease: true });
      assert.equal(await generation(1), null);
      // Neither does a grant that is not a release by hand (eve, above).
      assert.equal(await generation(5), null);
      assert.equal(await invites.skipsLeft(pool, as(5, 'eve', true)), 0);

      // cy was let off the waitlist by hand: generation 0, with a skip.
      const CY = as(3, 'cy', true);
      assert.equal(await invites.skipsLeft(pool, CY), 1);
      const cys = await invites.createInvite(pool, { app: arena, user: CY });

      // Switched off in Admin → Waitlist, a skip is not spent: ivy waits.
      await invites.setTreeEnabled(pool, { enabled: false, actorId: 9 });
      assert.equal(await invites.skipsLeft(pool, CY), null, 'off: nothing to show');
      const ivyId = (await pool.query("INSERT INTO users (username) VALUES ('ivy') RETURNING id")).rows[0].id;
      const ivy = await invites.redeem(pool, { token: cys.link.token, user: as(ivyId, 'ivy', false) });
      assert.deepEqual([ivy.status, ivy.skippedWaitlist], ['queued', false]);
      await invites.setTreeEnabled(pool, { enabled: true, actorId: 9 });
      assert.equal(await invites.skipsLeft(pool, CY), 1, 'nothing was spent while it was off');

      const fay = await invites.redeem(pool, { token: cys.link.token, user: as(6, 'fay', false) });
      assert.deepEqual([fay.status, fay.skippedWaitlist, fay.slug], ['joined', true, 'arena']);
      const row = await pool.query('SELECT has_platform_access, admitted_by, invite_generation FROM users WHERE id = 6');
      assert.deepEqual(row.rows[0], { has_platform_access: true, admitted_by: 3, invite_generation: 1 });
      assert.equal(await invites.skipsLeft(pool, CY), 0);
      const gus = await invites.redeem(pool, { token: cys.link.token, user: as(7, 'gus', false) });
      assert.deepEqual([gus.status, gus.skippedWaitlist], ['queued', false], 'cy\'s one skip is spent');

      // No chaining: fay, whom a link let in, has none of her own.
      const FAY = as(6, 'fay', true);
      assert.equal(await invites.skipsLeft(pool, FAY), 0);
      const fays = await invites.createInvite(pool, { app: arena, user: FAY });
      const viaFay = await invites.redeem(pool, { token: fays.link.token, user: as(7, 'gus', false) });
      assert.deepEqual([viaFay.status, viaFay.skippedWaitlist], ['queued', false]);
      // Admitting her by hand later leaves her where the link put her.
      await waitlist.grantPlatformAccess(pool, 6, { manualRelease: true });
      assert.equal(await generation(6), 1);

      // An admin's link has no limit, but it is not a release by hand: the
      // person it lets in is generation 1, with nothing to give.
      const ROOT = { id: 9, username: 'root', isAdmin: true, hasPlatformAccess: true };
      assert.equal(await invites.skipsLeft(pool, ROOT), null, 'unlimited: nothing to count down');
      const roots = await invites.createInvite(pool, { app: arena, user: ROOT });
      const viaRoot = await invites.redeem(pool, { token: roots.link.token, user: as(7, 'gus', false) });
      assert.deepEqual([viaRoot.status, viaRoot.skippedWaitlist], ['joined', true]);
      const gusRow = await pool.query('SELECT admitted_by, invite_generation FROM users WHERE id = 7');
      assert.deepEqual(gusRow.rows[0], { admitted_by: 9, invite_generation: 1 });
      assert.equal(await invites.skipsLeft(pool, as(7, 'gus', true)), 0);

      // What the Waitlist screen shows.
      const shown = await invites.adminPayload(pool);
      assert.deepEqual(
        { enabled: shown.enabled, rootSkips: shown.rootSkips, roots: shown.roots, throughLinks: shown.throughLinks, updatedBy: shown.updatedBy },
        { enabled: true, rootSkips: 1, roots: 1, throughLinks: 2, updatedBy: 'root' },
        'cy can invite; fay and gus got in through links; root switched it last',
      );
    });
  } finally {
    process.env.INVITE_TREE_BUDGETS = saved.budgets || '';
    await dropSchema(pool);
  }
});
