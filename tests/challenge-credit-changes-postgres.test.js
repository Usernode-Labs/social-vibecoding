'use strict';

// #3247: which change a challenge credit links to, against the real schema:
// both stored key shapes, only the viewer's own, only on a project they may
// see now. The route's use of it is in tests/topochain-mobile-data2.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { resolveCreditChanges } = require('../src/routes/topochain/mobile');
const { seedStagingCountedCredit } = require('../src/db/migrate');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('credits resolve through records the viewer may see, and the staging seed resolves (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = `credit_changes_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    const env = process.env.USERNODE_ENV;
    t.after(async () => {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const person = async (username) => (await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'unused') RETURNING id`, [username]
    )).rows[0].id;
    const viewer = await person('credit_viewer');
    const other = await person('credit_other');
    const project = async (slug, visibility = 'public') => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, $1, $2, $3, $3) RETURNING id`, [slug, other, visibility]
    )).rows[0].id;
    const session = async (appId, userId, branch, pr, title) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_number, pr_title, status)
       VALUES ($1, $2, $3, $4, $5, 'merged') RETURNING id`, [appId, userId, branch, pr, title]
    )).rows[0].id;
    const merge = async (sessionId, userId, appId, type = 'pr_merged') => (await pool.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`, [userId, appId, sessionId, type]
    )).rows[0].id;

    const open = await project('open-app');
    const closed = await project('closed-app', 'private');
    const member = await project('member-app', 'private');
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [member, viewer]
    );
    const suspended = await project('suspended-app');
    await pool.query('UPDATE apps SET moderation_suspended_at = NOW() WHERE id = $1', [suspended]);

    const accepted = await session(open, viewer, 'a', 7, 'Accepted one');
    const sent = await session(open, viewer, 'b', null, null);
    const keys = {
      accepted: `merged:${await merge(accepted, viewer, open)}`,
      sent: `session:${sent}`,
      memberApp: `merged:${await merge(await session(member, viewer, 'c', 8, 'Members only'), viewer, member)}`,
      privateMerged: `merged:${await merge(await session(closed, viewer, 'd', 9, 'Secret'), viewer, closed)}`,
      privateSent: `session:${await session(closed, viewer, 'e', 10, 'Secret too')}`,
      suspended: `session:${await session(suspended, viewer, 'f', 11, 'Suspended')}`,
      foreignMerge: `merged:${await merge(await session(open, other, 'g', 12, 'Theirs'), other, open)}`,
      foreignSession: `session:${await session(open, other, 'h', 13, 'Theirs too')}`,
      notAMerge: `merged:${await merge(accepted, viewer, open, 'pr_opened')}`,
      gone: 'merged:999999999',
      historical: 'feedback:12',
      overflow: 'session:99999999999999999999999',
    };
    const rows = [...Object.values(keys), null, 7].map((source_key) => ({ metadata: { source_key } }));
    rows.push({ metadata: null });
    const changes = await resolveCreditChanges(pool, { id: viewer, isAdmin: false }, rows);
    assert.deepEqual(Object.fromEntries(changes), {
      [keys.accepted]: { app_slug: 'open-app', session_id: accepted, pr_number: 7, title: 'Accepted one' },
      [keys.sent]: { app_slug: 'open-app', session_id: sent, pr_number: null, title: null },
      [keys.memberApp]: changes.get(keys.memberApp),
    });
    assert.equal(changes.get(keys.memberApp).title, 'Members only', 'a private project the viewer is in');

    // A blocked project is one they do not see, as everywhere else.
    await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [viewer, member]);
    const blocked = await resolveCreditChanges(pool, { id: viewer, isAdmin: false }, rows);
    assert.equal(blocked.has(keys.memberApp), false);

    // Nothing to resolve runs no query.
    const silent = { query() { throw new Error('no query expected'); } };
    assert.equal((await resolveCreditChanges(silent, { id: viewer }, [{ metadata: { source_key: 'feedback:1' } }])).size, 0);

    // The shots' fixture: one linked credit, this week, however often it boots.
    process.env.USERNODE_ENV = 'staging';
    const capture = await person('usernode-capture');
    await project('homeroom-self');
    const seasonRow = (await pool.query(
      `INSERT INTO seasons (id, name, starts_at, ends_at, is_active)
       VALUES (900500, 'Fixture', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE) RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO season_events (id, name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES (900501, 'Fixture', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE, '{}'::jsonb, $1, 'season')`,
      [seasonRow.id]
    );
    await seedStagingCountedCredit(pool, { selfAppSlug: 'homeroom-self' });
    await pool.query(`UPDATE user_activities SET activity_at = NOW() - INTERVAL '30 days' WHERE challenge_id = 900724`);
    await seedStagingCountedCredit(pool, { selfAppSlug: 'homeroom-self' });
    const credits = (await pool.query(
      `SELECT metadata, activity_at FROM user_activities WHERE challenge_id = 900724 AND user_id = $1`, [capture]
    )).rows;
    assert.equal(credits.length, 1, 'idempotent');
    assert.ok(Date.now() - credits[0].activity_at.getTime() < 60000, 'dated this boot');
    const seeded = await resolveCreditChanges(pool, { id: capture, isAdmin: false }, credits);
    assert.equal(seeded.get(credits[0].metadata.source_key).pr_number, 9043);
    assert.equal(seeded.get(credits[0].metadata.source_key).app_slug, 'homeroom-self');
  });
