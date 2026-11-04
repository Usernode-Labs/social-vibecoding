'use strict';

// #6233: a change of Homeroom's own app reads Live only once the whole
// rollout finished (the platform-rollout clock job), and a complete rollout
// that no longer carries it takes it back to Going live.
//
// The first boot of a build is recorded, but it is not Live: a release
// replaces its servers one at a time. `settleRollback` compares a complete
// build's merge order with the Live merges, and marks those a later build no
// longer carries (live_rolled_back_at), so deployment_state says
// `rolled_back` instead of `deployed`.
//
// Run with: node --test tests/platform-rollout-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const SHA = (c) => c.repeat(40).slice(0, 40);
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a Homeroom change is Live only after the whole rollout, and a rollback takes it back', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'platform_rollout_live_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'));
  const release = require('../src/services/platform-release');
  const watch = require('../src/services/release-watch');
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  const { rows: [author] } = await pool.query(`INSERT INTO users (username, password) VALUES ('rollout-author', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url)
     VALUES ('Homeroom', 'homeroom-rollout', $1, TRUE, 'https://github.com/acme/homeroom') RETURNING id`, [author.id]);
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('platform_live_tracked_since', '2026-01-01T00:00:00Z')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  // A row the MERGE MACHINE made: inserted as merging, moved into merged by
  // the transition writer, so the insert trigger does not read it as live.
  const merge = async (n, sha, at) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, merge_commit_sha, merged_at)
       VALUES ($1, $2, 'merging', $3, 'Change', $4, $5) RETURNING id`,
      [app.id, author.id, n, sha, at]);
    await pool.query('BEGIN');
    await pool.query(`SET LOCAL app.wf_writer = 'transition'`);
    await pool.query(`UPDATE chat_sessions SET status = 'merged', live_at = NULL WHERE id = $1`, [row.id]);
    await pool.query('COMMIT');
    return row;
  };
  // Two merges, in order: one the running build carries (a), a later one (b).
  const a = await merge(1, SHA('a'), '2026-11-03T10:00:00Z');
  const b = await merge(2, SHA('b'), '2026-11-03T11:00:00Z');
  const row = async (id) => (await pool.query(
    `SELECT live_at, live_rolled_back_at, platform_live_at, platform_first_served_at
       FROM chat_sessions WHERE id = $1`, [id])).rows[0];

  await t.test('the first server to boot a build is recorded, but it makes nothing Live', async () => {
    const n = await release.recordRunning(pool, { sha: SHA('b'), env: 'production', column: 'platform_first_served_at' });
    assert.equal(n, 2, 'both merges the build carries are recorded');
    const second = await row(b.id);
    assert.ok(second.platform_first_served_at, 'when production first served it is kept');
    assert.equal(second.live_at, null, 'a first boot is NOT Live');
    assert.equal(second.platform_live_at, null);
  });

  await t.test('off Kubernetes one process is the whole rollout, so its boot is Live', async () => {
    const c = await merge(3, SHA('c'), '2026-11-03T12:00:00Z');
    const n = await release.recordRunning(pool, { sha: SHA('c'), env: 'production', onKubernetes: false });
    assert.ok(n >= 1);
    assert.ok((await row(c.id)).platform_live_at, 'the local server starting is the rollout');
  });

  await t.test('a complete rollout carrying the merge makes it Live, and a rolled-back build takes it back', async () => {
    // The runtime's Deployed transition writes live_at; the clock job's own
    // writes are platform_live_at (the infra figure) and the boundary.
    await release.recordRunning(pool, { sha: SHA('b'), env: 'production', column: 'platform_live_at' });
    await pool.query(`UPDATE chat_sessions SET live_at = NOW() WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
    assert.ok((await row(b.id)).live_at);

    // Production now serves build a (an older merge): b is no longer carried.
    const out = await watch.settleRollback(pool, app.id, SHA('a'));
    assert.equal(out.rolledBack, 1);
    let second = await row(b.id);
    assert.equal(second.live_at, null, 'a rolled-back change goes back to Going live');
    assert.ok(second.live_rolled_back_at, 'and says the release rolled back');
    assert.equal(second.platform_live_at, null);
    assert.ok((await row(a.id)).live_at, 'the merge the build still carries is untouched');

    // A later release carries b again: Live again, with no second mark.
    const again = await watch.settleRollback(pool, app.id, SHA('b'));
    assert.equal(again.released, 1);
    second = await row(b.id);
    assert.ok(second.live_at, 'live again');
    assert.equal(second.live_rolled_back_at, null, 'the rollback mark is gone');
    assert.ok(second.platform_live_at);
  });

  await t.test('a build no merge made has no boundary, and settles nothing', async () => {
    const out = await watch.settleRollback(pool, app.id, SHA('e'));
    assert.equal(out.rolledBack, 0);
    assert.equal(out.released, 0);
  });
});

test('the wiring reads the rollout, not a first boot (#6233)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // The clock job exists, runs production only, and feeds the same reads.
  const clock = read('src/workflow/clock/services.ts');
  assert.match(clock, /name: 'platform-rollout'/);
  assert.match(clock, /phase !== 'complete'/);
  assert.match(clock, /productionDeployed\(Number\(app\.id\), sha\)/);
  assert.match(clock, /column: 'platform_live_at'/);
  assert.match(clock, /settleRollback\(pool, Number\(app\.id\), sha\)/);
  // A serving process records its boot; Live comes from the finished rollout.
  const platform = read('src/workflow/platform.ts');
  assert.match(platform, /if \(runtime && !onKubernetes\) await releaseBooted/);
  // The merge machine does not turn a boot record into Live on Kubernetes.
  const machine = read('src/workflow/merge-followups/machine.ts');
  assert.match(machine, /if \(!app\.onKubernetes\) \{[\s\S]{0,200}toLive/);
});
