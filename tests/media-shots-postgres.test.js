'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const media = require('../src/services/media-store');
const backfill = require('../src/services/media-shots-backfill');
const control = require('../src/services/shots-control');
const evals = require('../src/services/shots-eval');
const fixtures = require('./fixtures/shots');
const { memoryMediaStore } = require('./lib/media-store');
const { waitFor, within } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const id = () => crypto.randomBytes(16).toString('hex');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

test('shots object storage, publication, and resumable backfill against PostgreSQL', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'media_shots_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  const store = memoryMediaStore({ now: () => 0 });
  t.mock.method(media, 'getStore', () => store);
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('media-owner', 'x') RETURNING id");
  const { rows: [app] } = await pool.query("INSERT INTO apps (name, slug, created_by, view_visibility) VALUES ('Media', 'media', $1, 'public') RETURNING id", [user.id]);
  const { rows: [session] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, reviewed_head_sha)
    VALUES ($1, $2, 'promoted', $3) RETURNING id`, [app.id, user.id, 'b'.repeat(40)]);
  const runId = id();
  const intent = fixtures.intent();
  await pool.query(`INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'exploring')`, [runId, session.id, 'a'.repeat(40), 'b'.repeat(40), JSON.stringify(intent)]);
  await control.create(pool, { runId, sessionId: session.id, intent, context: {}, agent: { deviceDensity: true }, expiresAt: Date.now() + 60000 });
  await pool.query("UPDATE chat_sessions SET shots_state = 'exploring', shots_run_id = $2 WHERE id = $1", [session.id, runId]);
  const target = { change: 'invite-suggestions', screen: 'desktop', side: 'after', density: '2', showsPrivate: false };
  const original = fixtures.png({ width: 2560, height: 1600, shade: 90 });
  const save = () => control.withControl(pool, { runId, sessionId: session.id }, (c) => c.saveShot(target, original));

  await t.test('new saves contain only keys for both densities; retries reuse the same objects', async () => {
    await save();
    const { rows: [row] } = await pool.query('SELECT * FROM shot_run_files WHERE run_id = $1', [runId]);
    assert.equal(row.data, null); assert.equal(row.dense_data, null);
    assert.equal(row.object_key, media.PREFIX + row.sha256);
    assert.equal(row.dense_object_key, media.objectKey(original));
    assert.deepEqual(await media.bytes(store, row, { key: 'dense_object_key', data: 'dense_data' }), original);
    const [file] = await control.filesFor(pool, runId);
    assert.equal(sha(file.data), row.sha256);
    assert.equal(file.width, 1280);
    const writes = store.calls.filter((c) => c.op === 'put').length;
    await save();
    assert.equal(store.calls.filter((c) => c.op === 'put').length, writes);
    assert.equal((await media.sweep(pool, store)).removed, 0, 'the real shot and dense FKs retain both objects');
  });

  await t.test('an unavailable store aborts a new save, and a failed row write leaves only collectable orphans', async () => {
    const { rows: [before] } = await pool.query('SELECT object_key, dense_object_key FROM shot_run_files WHERE run_id = $1', [runId]);
    const different = fixtures.png({ width: 2560, height: 1600, shade: 37 });
    await assert.rejects(control.withControl(pool, { runId, sessionId: session.id },
      (c) => c.saveShot(target, different), { store: null }), { code: 'media_storage_unavailable' });
    const failing = { connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, params) => {
          if (String(sql).trim().startsWith('INSERT INTO shot_run_files')) throw new Error('metadata write failed');
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    } };
    await assert.rejects(control.withControl(failing, { runId, sessionId: session.id },
      (c) => c.saveShot(target, different)), /metadata write failed/);
    const { rows: [after] } = await pool.query('SELECT object_key, dense_object_key FROM shot_run_files WHERE run_id = $1', [runId]);
    assert.deepEqual(after, before);
    assert.ok(store.files.has(media.objectKey(different)), 'the uploaded original survived transaction rollback');
    assert.equal((await media.sweep(pool, store)).removed, 2, 'only the failed save’s two unreferenced objects are collected');
    assert.deepEqual(await media.bytes(store, { object_key: after.dense_object_key }), original);
  });

  let published;
  await t.test('the machine publishes keys and preserves them after the workspace is removed', async () => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const { shots } = require('../src/workflow/shots/machine.ts');
      const machine = shots({});
      await machine.writes.get('published')(tx, { runId, slots: ['invite-suggestions/desktop/head/context'],
        verdict: { passed: true, stories: [] }, planHash: 'c'.repeat(64) }, { push() {} });
      await tx.query('COMMIT');
    } catch (err) { await tx.query('ROLLBACK'); throw err; } finally { tx.release(); }
    ({ rows: [published] } = await pool.query('SELECT * FROM shot_artifacts WHERE run_id = $1', [runId]));
    assert.ok(published.object_key); assert.ok(published.dense_object_key);
    assert.equal(published.data, null); assert.equal(published.dense_data, null);
    await control.remove(pool, runId);
    assert.equal((await media.sweep(pool, store)).removed, 0, 'publication owns both objects independently');
    assert.deepEqual(await media.bytes(store, published, { key: 'dense_object_key', data: 'dense_data' }), original);
  });

  await t.test('the real artifact query chooses the dense key, byte count and ETag together', async (t) => {
    t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
    await pool.query('UPDATE users SET review_flow_enabled = TRUE WHERE id = $1', [user.id]);
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => { req.user = { id: user.id }; next(); });
    app.use(require('../src/routes/shots').shotsRoutes({ shots: { present: true } }, { store }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    const url = `http://127.0.0.1:${server.address().port}/api/apps/media/proposals/${session.id}/shots/${published.id}`;
    const response = await fetch(url + '?density=device');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), `"${published.dense_sha256}"`);
    assert.equal(response.headers.get('content-length'), String(original.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    const normal = await fetch(url);
    assert.equal(normal.headers.get('etag'), `"${published.sha256}"`);
    assert.equal(sha(Buffer.from(await normal.arrayBuffer())), published.sha256);
  });

  const legacy = fixtures.png({ shade: 130 });
  const legacyDense = fixtures.png({ width: 8, height: 6, shade: 130 });
  const legacyId = id(); const diagnosticId = id(); const evalId = id(); const attemptId = id();
  let trialId;
  await t.test('legacy rows in all four tables, including dense copies, remain readable before backfill', async () => {
    await control.create(pool, { runId: attemptId, sessionId: session.id, kind: 'trial', intent, context: {}, expiresAt: Date.now() + 60000 });
    await pool.query(`INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type,
      data, width, height, bytes, sha256, density, dense_data, dense_width, dense_height, dense_bytes, dense_sha256)
      VALUES ($1, 'invite-suggestions/desktop/base/context', 'invite-suggestions', 'desktop', 'base', 'context', 'png', 'image/png',
        $2, 4, 3, $3, $4, 2, $5, 8, 6, $6, $7)`, [attemptId, legacy, legacy.length, sha(legacy), legacyDense, legacyDense.length, sha(legacyDense)]);
    await pool.query(`INSERT INTO shot_artifacts (id, run_id, story_id, viewport, side, variant, media, content_type,
      data, width, height, bytes, sha256, density, dense_data, dense_width, dense_height, dense_bytes, dense_sha256)
      VALUES ($1, $2, 'invite-suggestions', 'desktop', 'base', 'context', 'png', 'image/png',
        $3, 4, 3, $4, $5, 2, $6, 8, 6, $7, $8)`, [legacyId, runId, legacy, legacy.length, sha(legacy), legacyDense, legacyDense.length, sha(legacyDense)]);
    await pool.query(`INSERT INTO shot_diagnostic_artifacts (id, run_id, attempt, pass, story_id, viewport, side, variant, data, width, height, bytes, sha256)
      VALUES ($1, $2, 1, 1, 'invite-suggestions', 'desktop', 'base', 'context', $3, 4, 3, $4, $5)`, [diagnosticId, runId, legacy, legacy.length, sha(legacy)]);
    const { rows: [evaluation] } = await pool.query("INSERT INTO shots_eval_runs (label, cap_cents) VALUES ('Media test', 100) RETURNING id");
    ({ rows: [{ id: trialId }] } = await pool.query(`INSERT INTO shots_eval_trials (eval_run_id, session_id, position, attempt_id, base_sha, head_sha, intent, state)
      VALUES ($1, $2, 0, $3, $4, $5, $6::jsonb, 'reviewing') RETURNING id`,
    [evaluation.id, session.id, attemptId, 'a'.repeat(40), 'b'.repeat(40), JSON.stringify(intent)]));
    await pool.query(`INSERT INTO shots_eval_artifacts (id, trial_id, story_id, viewport, side, variant, media, content_type, data, width, height, bytes, sha256)
      VALUES ($1, $2, 'invite-suggestions', 'desktop', 'base', 'context', 'png', 'image/png', $3, 4, 3, $4, $5)`,
    [evalId, trialId, legacy, legacy.length, sha(legacy)]);
    assert.deepEqual((await control.filesFor(pool, attemptId))[0].data, legacy);
  });

  await t.test('failed upload preserves bytes; bounded batches resume to zero and deduplicate across tables', async () => {
    const broken = { ...store, putObject: async () => { throw new Error('upload interrupted'); } };
    await assert.rejects(backfill.run(pool, broken), /upload interrupted/);
    assert.deepEqual((await control.filesFor(pool, attemptId))[0].data, legacy);
    const first = await backfill.run(pool, store, { limit: 1 });
    assert.equal(first.migrated, 1); assert.equal(first.done, false);
    const rest = await backfill.run(pool, store);
    assert.equal(rest.migrated, 3); assert.equal(rest.done, true);
    assert.deepEqual(rest.remaining, { shot_run_files: 0, shot_artifacts: 0, shots_eval_artifacts: 0, shot_diagnostic_artifacts: 0 });
    assert.deepEqual(await backfill.run(pool, store), { ...rest, migrated: 0, uploadedBytes: 0 });
    assert.deepEqual((await control.filesFor(pool, attemptId))[0].data, legacy);
    const { rows: [row] } = await pool.query('SELECT * FROM shot_artifacts WHERE id = $1', [legacyId]);
    assert.equal(row.data, null); assert.equal(row.dense_data, null);
    assert.deepEqual(await media.bytes(store, row), legacy);
    assert.deepEqual(await media.bytes(store, row, { key: 'dense_object_key', data: 'dense_data' }), legacyDense);
    assert.equal(store.calls.filter((c) => c.op === 'put' && c.key === media.objectKey(legacy)).length, 1);
    assert.equal((await media.sweep(pool, store)).removed, 0);
  });

  await t.test('eval publication copies a key without downloading or reuploading its source', async () => {
    const before = store.calls.length;
    await evals.storeTrialFiles(pool, trialId, attemptId, ['invite-suggestions/desktop/base/context']);
    assert.equal(store.calls.length, before, 'key-only copy has no S3 I/O');
    const { rows: [row] } = await pool.query('SELECT * FROM shots_eval_artifacts WHERE trial_id = $1', [trialId]);
    assert.equal(row.data, null); assert.equal(row.object_key, media.objectKey(legacy));
  });

  await t.test('a retake waits for the source row before taking keys, so backfill cannot deadlock with it', async () => {
    const attempt = id();
    await control.create(pool, { runId: attempt, sessionId: session.id, kind: 'trial', intent, context: {}, expiresAt: Date.now() + 60000 });
    const data = fixtures.png({ shade: 47 });
    const save = () => control.withControl(pool, { runId: attempt, sessionId: session.id },
      (c) => c.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, data));
    await save();
    const owner = await pool.connect();
    await owner.query('BEGIN');
    await owner.query('SELECT slot FROM shot_run_files WHERE run_id = $1 FOR UPDATE', [attempt]);
    const retake = save();
    try {
      await waitFor(async () => (await pool.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND query LIKE 'SELECT slot FROM shot_run_files WHERE run_id = $1 AND slot = ANY%'
          AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`)).rows[0].blocked,
      { label: 'the retake to lock its existing slot before requesting object keys' });
      await within(media.putMany(owner, store, [{ data }]), 2000, 'the source-row holder to acquire the key');
    } finally { await owner.query('ROLLBACK'); owner.release(); await retake; }
    assert.deepEqual((await control.filesFor(pool, attempt))[0].data, data);
    await control.remove(pool, attempt);
  });

  await t.test('the actual backfill clock resumes a bounded batch in another workflow process', async (t) => {
    for (let i = 0; i < 24; i++) await pool.query(`INSERT INTO shot_diagnostic_artifacts
      (id, run_id, attempt, pass, story_id, viewport, side, variant, data, width, height, bytes, sha256)
      VALUES ($1, $2, 1, 1, $3, 'desktop', 'base', 'context', $4, 4, 3, $5, $6)`,
    [id(), runId, 'restart-' + i, legacy, legacy.length, sha(legacy)]);
    t.mock.method(media, 'createMediaStore', () => store);
    const { createRuntime } = require('../src/workflow/kernel/index.ts');
    const { clock, MACHINE, clockKey } = require('../src/workflow/clock/machine.ts');
    const { JOBS, clockServices } = require('../src/workflow/clock/services.ts');
    const job = JOBS.find((job) => job.name === 'media-shots-backfill');
    const make = () => createRuntime({ pool, machines: [clock()], services: clockServices([job], { pool, config: {} }), pollMs: 10 });
    const status = async () => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2',
      [MACHINE, clockKey(job.name)])).rows[0];
    const ask = (runtime, n) => runtime.appendAndWait(MACHINE, clockKey(job.name), { type: 'RunNow', payload: {} },
      { requestKey: 'media-test:' + n, source: { kind: 'admin', name: 'test' } });
    let active = make();
    t.after(() => active.stop());
    await active.start({ loops: true });
    // Drive two runs explicitly instead of waiting the production interval.
    await active.appendAndWait(MACHINE, clockKey(job.name), { type: 'Arm', payload: { job: job.name, everyMs: job.everyMs, onDemand: true } },
      { requestKey: 'media-test:arm', source: { kind: 'system', name: 'test' } });
    await ask(active, 1);
    const first = await waitFor(async () => {
      const row = await status(); return row?.state === 'waiting' && row.data.last?.n === 1 ? row : null;
    }, { label: 'the backfill’s first batch to commit and settle', timeoutMs: 10000 });
    assert.equal(first.data.last.ok, true);
    assert.equal(first.data.last.result.migrated, 20);
    assert.equal(first.data.last.result.remaining.shot_diagnostic_artifacts, 4);
    assert.equal(first.data.last.result.done, false);
    await active.stop();
    active = make();
    await active.start({ loops: true });
    await ask(active, 2);
    const second = await waitFor(async () => {
      const row = await status(); return row?.state === 'waiting' && row.data.last?.n === 2 ? row : null;
    }, { label: 'the restarted workflow process to finish the remaining rows', timeoutMs: 10000 });
    assert.equal(second.data.last.ok, true);
    assert.equal(second.data.last.result.migrated, 4);
    assert.equal(second.data.last.result.done, true);
  });

  await t.test('checksum mismatch refuses to clear legacy bytes; the schema remains idempotent', async () => {
    await pool.query('UPDATE shot_diagnostic_artifacts SET data = $2, object_key = NULL WHERE id = $1', [diagnosticId, Buffer.from('corrupted')]);
    await assert.rejects(backfill.run(pool, store), /checksum mismatch/);
    const { rows: [row] } = await pool.query('SELECT data, object_key FROM shot_diagnostic_artifacts WHERE id = $1', [diagnosticId]);
    assert.equal(row.data.toString(), 'corrupted'); assert.equal(row.object_key, null);
    await pool.query(schema);
  });
});
