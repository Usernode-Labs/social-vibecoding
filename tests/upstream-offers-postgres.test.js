'use strict';

// The statements services/upstream-offers.js runs, against the real schema
// (src/db/schema.sql, block "Versions"): the clock's mark and its reads, the
// offer's upsert and its join, one open update per version, the update
// merges `keeps` leaves out, the members told, the fit request found by its
// marker, and the change page's block. tests/upstream-offers.test.js covers
// the flows over an in-memory stand-in keyed by these same statements.
//
// Skips when no local PostgreSQL answers (TEST_DATABASE_URL).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const offers = require('../src/services/upstream-offers');
const lineage = require('../src/services/upstream-lineage');

const { SQL } = offers;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const T = 'd'.repeat(40);

test('upstream offers: mark, the clock\'s reads, one open update, keeps, members, fit, the change page (PostgreSQL)', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `upstream_offers_test_${process.pid}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));

    const addUser = async (username, synthetic = false) => (await pool.query(
      "INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'unused', $2) RETURNING id", [username, synthetic])).rows[0].id;
    const platform = await addUser('usernode-platform');
    const ada = await addUser('ada');
    const bo = await addUser('bo');
    const bot = await addUser('some_bot', true);
    const addApp = async (slug, { mainSha = null, upstream = null } = {}) => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, repo_url, main_sha, upstream, icon_emoji)
       VALUES ($1, $1, $2, $3, $4, $5::jsonb, '🏆') RETURNING *`,
      [slug, ada, `https://git.example.test/apps/${slug}`, mainSha, upstream ? JSON.stringify(upstream) : null])).rows[0];
    const original = await addApp('tier', { mainSha: C });
    const follows = await addApp('ours', { upstream: { appId: original.id, slug: 'tier', following: true, syncedSha: A, baseSha: B } });
    const notFollowing = await addApp('theirs', { upstream: { appId: original.id, following: false, syncedSha: A, baseSha: B } });
    const current = await addApp('current', { upstream: { appId: original.id, following: true, syncedSha: C, baseSha: B } });
    const legacy = await addApp('legacy', { upstream: { appId: original.id, following: true, legacy: true } });

    // ── Mark ──
    let marked = await pool.query(SQL.mark);
    assert.equal(marked.rowCount, 2, 'the following versions behind it, the legacy copy among them');
    const states = async () => Object.fromEntries((await pool.query('SELECT app_id, state, from_sha FROM upstream_offers ORDER BY app_id'))
      .rows.map((r) => [r.app_id, `${r.state}@${r.from_sha.slice(0, 1)}`]));
    assert.deepEqual(await states(), { [follows.id]: 'available@c', [legacy.id]: 'available@c' });
    void notFollowing; void current;
    marked = await pool.query(SQL.mark);
    assert.equal(marked.rowCount, 0, 'an available row stands');

    // An open one, a failed one for this commit, a skipped one: only the skipped is marked again.
    const save = (appId, state, extra = {}) => pool.query(SQL.saveOffer, [
      appId, original.id, extra.fromSha || C, state, extra.theirs || null, extra.sessionId || null,
      JSON.stringify(offers.EMPTY_FACTS), JSON.stringify([{ title: 'Add a shuffle button' }]),
      JSON.stringify({ count: 1, titles: ['Our colours'] }), JSON.stringify(extra.conflicts || []), extra.error || null,
    ]);
    await save(legacy.id, 'failed', { error: 'cannot_plan' });
    assert.equal((await pool.query(SQL.mark)).rowCount, 0, 'failed for this very commit: not again');
    await save(legacy.id, 'failed', { fromSha: B });
    assert.equal((await pool.query(SQL.mark)).rowCount, 1, 'failed for an earlier commit: owed again');
    await save(legacy.id, 'skipped', { fromSha: B });
    assert.equal((await pool.query(SQL.mark)).rowCount, 1);

    // ── One open update per version ──
    const insert = (appId, branch, n) => pool.query(SQL.insertSession,
      [appId, platform, branch, n, null, 'Update from tier', 'body', original.id]);
    const { rows: [s1] } = await insert(follows.id, 'homeroom/update-cccccccccccc', 7);
    await assert.rejects(insert(follows.id, 'homeroom/update-other', 8), (err) => err.code === '23505');
    const { rows: [open] } = await pool.query(SQL.openSession, [follows.id]);
    assert.equal(open.id, s1.id);
    const { rows: [sess] } = await pool.query(SQL.session, [s1.id]);
    assert.deepEqual([sess.source, sess.user_id, sess.upstream_from_app_id, sess.app_slug, !!sess.shared_at],
      ['maintenance', platform, original.id, 'ours', true]);
    await pool.query(SQL.sessionBody, [s1.id, 'new body']);
    assert.equal(Number((await pool.query(SQL.epoch, [s1.id])).rows[0].approval_epoch) >= 0, true);

    await save(follows.id, 'open', { sessionId: s1.id, theirs: T });
    const { rows: [row] } = await pool.query(SQL.offer, [follows.id]);
    assert.deepEqual([row.state, row.session_status, row.pr_number, row.branch_name, row.theirs_sha],
      ['open', 'active', 7, 'homeroom/update-cccccccccccc', T]);
    assert.deepEqual(row.brings, [{ title: 'Add a shuffle button' }]);

    // ── The clock's reads ──
    assert.equal((await pool.query(SQL.dueRefresh, [50])).rows.length, 0, 'its original has not moved past it');
    await pool.query('UPDATE apps SET main_sha = $2 WHERE id = $1', [original.id, 'e'.repeat(40)]);
    assert.deepEqual((await pool.query(SQL.dueRefresh, [50])).rows.map((r) => [r.app_id, r.main_sha]), [[follows.id, 'e'.repeat(40)]]);
    assert.deepEqual((await pool.query(SQL.dueSettle, [50])).rows, []);
    await pool.query("UPDATE chat_sessions SET status = 'merged' WHERE id = $1", [s1.id]);
    assert.deepEqual((await pool.query(SQL.dueSettle, [50])).rows.map((r) => [r.app_id, r.status]), [[follows.id, 'merged']]);
    assert.deepEqual((await pool.query(SQL.dueOpen, [50])).rows.map((r) => r.app_id), [legacy.id]);
    await save(legacy.id, 'needs_fit', { conflicts: ['app.js'] });
    assert.deepEqual((await pool.query(SQL.dueFit, [50])).rows.map((r) => r.app_id), [legacy.id]);
    await pool.query(SQL.setState, [legacy.id, 'skipped', null]);
    await pool.query(SQL.setError, [legacy.id, 'later']);
    await save(legacy.id, 'available');
    await pool.query(SQL.clearAvailable, [legacy.id]);
    assert.equal((await pool.query(SQL.offer, [legacy.id])).rows.length, 0);

    // ── keeps leaves this version's update merges out ──
    await pool.query(
      `INSERT INTO native_pulls (app_id, number, title, head_branch, state, merged, merge_commit_sha)
       VALUES ($1, 7, 'Update from tier', 'homeroom/update-cccccccccccc', 'closed', TRUE, $2)`, [follows.id, 'f'.repeat(40)]);
    assert.deepEqual(await offers.updateMergeShas(pool, follows.id), ['f'.repeat(40)]);

    // ── The members told: people, not the platform's own accounts ──
    for (const id of [ada, bo, bot]) {
      await pool.query(
        `INSERT INTO community_members (community_id, user_id) SELECT community_id, $2 FROM apps WHERE id = $1
         ON CONFLICT DO NOTHING`, [follows.id, id]);
    }
    const members = (await pool.query(SQL.members, [follows.id])).rows.map((r) => Number(r.user_id)).sort();
    assert.ok(members.includes(ada) && members.includes(bo));
    assert.ok(!members.includes(bot), 'not a synthetic account');

    // ── The fit request, by its marker ──
    const marker = offers.fitMarker(follows.id, C);
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, state, state_reason)
       VALUES ($1, 40, 'Fit the update from tier', $2, 'closed', 'completed')`, [follows.id, `Body\n\n${marker}`]);
    const { rows: [fit] } = await pool.query(SQL.fitRequest, [follows.id, marker]);
    assert.deepEqual([fit.number, fit.state, fit.state_reason], [40, 'closed', 'completed']);
    assert.equal((await pool.query(SQL.fitRequest, [follows.id, offers.fitMarker(follows.id, B)])).rows.length, 0);
    const { rows: [issue] } = await pool.query(SQL.insertIssue, [follows.id, 40, 'Fit the update from tier', 'Body', ada]);
    assert.ok(issue.id);

    // ── The change page's block ──
    assert.deepEqual(await offers.changeView(pool, s1.id), {
      from: { slug: 'tier', name: 'tier', emoji: '🏆' },
      brings: [{ title: 'Add a shuffle button' }], facts: { ...offers.EMPTY_FACTS },
      keeps: { count: 1, titles: ['Our colours'] }, state: 'open', conflicts: [],
    });

    // ── The lineage write the settle makes ──
    const link = await lineage.writeUpstream(pool, follows.id, { syncedSha: C, baseSha: T });
    assert.deepEqual([link.syncedSha, link.baseSha, link.following, link.appId], [C, T, true, original.id]);
    const { rows: [v] } = await pool.query(SQL.version, [follows.id]);
    assert.equal(lineage.readUpstream(v).syncedSha, C);
    const { rows: [o] } = await pool.query(SQL.original, [original.id]);
    assert.equal(o.view_visibility, 'public');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await root.end().catch(() => {});
  }
});
