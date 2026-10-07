'use strict';

// The preview machine wired into the platform (src/workflow/platform.ts),
// with WF_PREVIEWS_ENABLED on and a running runtime: a submitted revision
// is built and checked through the real work handlers (the build, the
// checks run and the cluster stubbed), the machine owns an enrolled row's
// preview columns, and with the flag off the next boot hands every session
// back to the old paths. Everything else is the full PostgreSQL schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('previews through the platform runtime', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_preview_platform_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const calls = [];
  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', { ...realWs, broadcast: () => {}, broadcastGlobal: () => {}, pushSessionUpdate: () => {} });
  const realStaging = require('../src/services/staging');
  stub('../src/services/staging', {
    ...realStaging,
    async prepareAttempt(config, row, app, head, attempt) {
      calls.push(['prepare', row.id, head, attempt.n]);
      await attempt.checkpoint({ step: 'deploy', db: attempt.dbName });
      return { stagingUrl: `https://shop--s${row.id}.apps`, hostname: `shop--s${row.id}.apps`, runtimeKind: 'kubernetes',
        runtimeName: `sv-preview-${app.id}-s${row.id}`, containerId: null, imageRef: `img@sha256:${attempt.n}`, buildRef: null };
    },
    async verifyStagingEdge() { return { ok: true }; },
  });
  const realVisuals = require('../src/services/visuals');
  stub('../src/services/visuals', {
    ...realVisuals,
    async captureForSession(config, row, app, head) {
      calls.push(['checks', row.id, head]);
      return { outcome: 'verdict', state: 'passing', results: [], console: { state: 'clean', errors: [] }, history: [],
        capture: { state: 'console_only', detail: {} }, visuals: false };
    },
    startShotsIfIdle: async () => {}, scheduleShots: () => {}, notifyChecks: () => {}, notifyChecksPending: () => {},
    noteBotChecksAfterChecks: () => {}, maybeAutoMergeAfterChecks: () => {},
  });
  stub('../src/services/db-manager', { ...require('../src/services/db-manager'), dropDatabase: async (n) => { calls.push(['drop', n]); } });
  stub('../src/services/kubernetes', { ...require('../src/services/kubernetes'), deleteSecret: async () => {}, cancelPreviewChecks: async () => {} });

  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPreviewsEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise', captureRuntime: 'kubernetes', kubernetes: {},
  };
  const platform = require('../src/workflow/platform.ts');
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await platform.startWorkflow(config, { loops: true });

  const { rows: [author] } = await pool.query(`INSERT INTO users (username, password) VALUES ('author', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ('Shop', 'shop', $1, 'https://github.com/acme/shop') RETURNING *`,
    [author.id]);
  const proposal = async () => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'feature') RETURNING *`,
    [app.id, author.id])).rows[0];
  const state = async (s) => (await platform.previewInstance(s.id))?.state;
  const until = async (check, what) => {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      if (Date.now() >= deadline) {
        const { rows } = await pool.query(
          `SELECT kind, work_key, status, last_error FROM wf_work WHERE machine = 'preview' AND status <> 'settled'`);
        assert.fail(`${what}; unsettled: ${JSON.stringify(rows)}`);
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  const quiet = () => until(async () => !(await pool.query(
    `SELECT 1 FROM wf_work WHERE machine = 'preview' AND status IN ('queued', 'running', 'reported')
     UNION ALL SELECT 1 FROM wf_events WHERE machine = 'preview' AND status = 'pending'`)).rows.length, 'quiet');

  await t.test('a submitted revision is built, published and checked by the machine', async () => {
    assert.equal(platform.previewsEnabled(), true);
    const s = await proposal();
    await platform.submitRevision({ sessionId: s.id, appId: app.id, head: SHA('a'), source: 'turn', trigger: 'commit-push' });
    await until(async () => (await state(s)) === 'settled', 'settled');
    const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id]);
    assert.equal(r.staging_url, `https://shop--s${s.id}.apps`);
    assert.equal(r.check_state, 'passing');
    assert.deepEqual(calls.filter((c) => c[1] === s.id).map((c) => c[0]), ['prepare', 'checks']);
    await assert.rejects(platform.submitRevision({ sessionId: s.id, appId: app.id, head: 'latest', source: 'fleet' }),
      /must resolve an exact head first/);
    await quiet();
  });

  await t.test('the machine owns an enrolled row\'s preview columns; other rows are untouched', async () => {
    const s = await proposal();
    await platform.submitRevision({ sessionId: s.id, appId: app.id, head: SHA('b'), source: 'turn' });
    await until(async () => (await state(s)) === 'settled', 'settled');
    await assert.rejects(pool.query(`UPDATE chat_sessions SET staging_url = NULL WHERE id = $1`, [s.id]), /WF_OWNERSHIP_VIOLATION/);
    await pool.query(`UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`, [s.id]);
    const other = await proposal();
    await pool.query(`UPDATE chat_sessions SET staging_url = 'https://legacy' WHERE id = $1`, [other.id]);
    assert.equal(await platform.retirePreview(other.id, app.id, 'archived', true), false, 'not held: the caller retires it the old way');
    await quiet();
  });

  await t.test('a CLI upload to a held session clears its verdict through the machine, with no ownership violation (review finding 1)', async () => {
    const s = await proposal();
    await platform.submitRevision({ sessionId: s.id, appId: app.id, head: SHA('d'), source: 'cli' });
    await until(async () => (await state(s)) === 'settled', 'settled');
    // The upload route's statement for a held session ($7 = true): its own
    // columns move, the verdict's stay, in 'raise' mode.
    await pool.query(
      `UPDATE chat_sessions SET handoff_uploaded_sha = $2,
              check_state = CASE WHEN $3::boolean THEN check_state END,
              test_results = CASE WHEN $3::boolean THEN test_results ELSE '[]'::jsonb END
        WHERE id = $1`, [s.id, SHA('e'), true]);
    assert.equal(await require('../src/services/preview-workflow').clear({ session: s, reason: 'upload' }), true);
    await until(async () => (await pool.query('SELECT check_state FROM chat_sessions WHERE id = $1', [s.id])).rows[0].check_state === null,
      'cleared by the machine');
    await quiet();
  });

  await t.test('with the flag off, the next boot detaches every held session and the old paths own it again', async () => {
    const s = await proposal();
    await platform.submitRevision({ sessionId: s.id, appId: app.id, head: SHA('c'), source: 'turn' });
    await until(async () => (await state(s)) === 'settled', 'settled');
    await quiet();
    await platform.stopWorkflow();
    await platform.startWorkflow({ ...config, wfPreviewsEnabled: false }, { loops: true });
    assert.equal(platform.previewsEnabled(), false);
    await until(async () => (await state(s)) === 'detached', 'detached');
    const { rows } = await pool.query(`SELECT key FROM wf_settings WHERE key = 'enabled:preview'`);
    assert.equal(rows.length, 0);
    await pool.query(`UPDATE chat_sessions SET staging_url = NULL WHERE id = $1`, [s.id]);
    await quiet();
    await platform.stopWorkflow();
    await platform.startWorkflow({ ...config, wfPreviewsEnabled: false }, { loops: true });
    assert.equal(platform.workflowRunning(), false, 'nothing left to detach: no runtime');
  });
});
