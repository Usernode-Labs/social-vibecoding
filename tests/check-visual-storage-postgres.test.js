'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const visuals = require('../src/services/visuals');
const media = require('../src/services/media-store');
const backfill = require('../src/services/media-check-visuals-backfill');
const { metadata } = require('../src/services/check-visual-media');
const { useMemoryMedia } = require('./lib/media-store');
const { waitFor } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const id = () => crypto.randomBytes(16).toString('hex');

test('check visual uploads, atomic publication and workflow backfill against PostgreSQL', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'visual_store_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const store = useMemoryMedia(t, { now: () => 0 });
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('visual-test', 'x') RETURNING id");
  const { rows: [app] } = await pool.query("INSERT INTO apps (name, slug, created_by) VALUES ('Visual', 'visual', $1) RETURNING id", [user.id]);
  const head = 'a'.repeat(40);
  const { rows: [session] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, checks_commit_sha)
    VALUES ($1, $2, 'active', $3) RETURNING id`, [app.id, user.id, head]);
  const { rows: [merged] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, merged_at)
    VALUES ($1, $2, 'merged', NOW() - INTERVAL '365 days') RETURNING id`, [app.id, user.id]);
  const targets = [{ index: 0, path: '/' }];
  const shot = (buf) => ({ kind: 'after', media: 'png', index: 0, status: 200, buf });
  const data = Buffer.from('new capture');
  const legacy = Buffer.from('old capture from a merged PR');

  await t.test('new direct and held captures commit keys without bytes and deduplicate the shared content', async () => {
    const direct = await visuals.storeArtifacts(pool, session.id, head, targets, [shot(data)]);
    const held = await visuals.storeArtifacts(pool, session.id, head, targets, [shot(data)], null, { runId: 'checks:new' });
    for (const [sql, artifactId] of [
      ['SELECT * FROM session_visuals WHERE id = $1', direct.captures[0].after.png],
      ['SELECT * FROM check_run_media WHERE id = $1', held.captures[0].after.png],
    ]) {
      const { rows: [row] } = await pool.query(sql, [artifactId]);
      assert.equal(row.data, null); assert.equal(row.object_key, media.objectKey(data));
      assert.equal(row.sha256, metadata(data).sha256); assert.equal(row.bytes, data.length);
      assert.equal(row.legacy_etag, metadata(data).legacyEtag);
      assert.deepEqual(await media.bytes(store, row), data);
    }
    assert.equal(store.calls.filter((c) => c.op === 'put').length, 1);
    const before = store.calls.length;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await require('../src/workflow/preview/machine.ts').preview({}).writes.get('deferred')(tx,
        { sessionId: session.id, head, runId: 'checks:new', media: true });
      await tx.query('COMMIT');
    } catch (err) { await tx.query('ROLLBACK'); throw err; } finally { tx.release(); }
    assert.equal(store.calls.length, before, 'publication only copies keys and metadata');
    assert.equal((await visuals.getForSession(pool, session.id)).captures[0].after.png, held.captures[0].after.png);
  });

  await t.test('failed uploads or row writes restore the previous published set and leave only collectable orphans', async () => {
    const before = (await pool.query('SELECT id FROM session_visuals WHERE session_id = $1 ORDER BY id', [session.id])).rows;
    await assert.rejects(visuals.storeArtifacts(pool, session.id, head, targets, [shot(Buffer.from('unconfigured'))], null, null, { store: null }),
      { code: 'media_storage_unavailable' });
    const failing = { connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, params) => {
          if (String(sql).trim().startsWith('INSERT INTO session_visuals')) throw new Error('metadata refused');
          return client.query(sql, params);
        }, release: () => client.release(),
      };
    } };
    const orphan = Buffer.from('uploaded but never committed');
    await assert.rejects(visuals.storeArtifacts(failing, session.id, head, targets, [shot(orphan)]), /metadata refused/);
    assert.deepEqual((await pool.query('SELECT id FROM session_visuals WHERE session_id = $1 ORDER BY id', [session.id])).rows, before);
    assert.ok(store.files.has(media.objectKey(orphan)));
    assert.equal((await media.sweep(pool, store)).removed, 1);
    assert.ok(store.files.has(media.objectKey(data)));
  });

  const legacyId = id();
  await t.test('backfill covers both tables, preserves old ids and validators, and leaves failed rows intact', async () => {
    await pool.query(`INSERT INTO session_visuals (id, session_id, kind, media, content_type, data, created_at)
      VALUES ($1, $2, 'after', 'png', 'image/png', $3, NOW() - INTERVAL '365 days')`, [legacyId, merged.id, legacy]);
    await pool.query(`INSERT INTO check_run_media (id, run_id, session_id, kind, media, content_type, data)
      VALUES ($1, 'checks:old', $2, 'after', 'png', 'image/png', $3)`, [id(), session.id, legacy]);
    const broken = { ...store, putObject: async () => { throw new Error('provider unavailable'); } };
    await assert.rejects(backfill.run(pool, broken), /provider unavailable/);
    assert.deepEqual((await pool.query('SELECT data FROM session_visuals WHERE id = $1', [legacyId])).rows[0].data, legacy);
    assert.equal((await backfill.run(pool, store, { shouldStop: () => true })).migrated, 0);
    const first = await backfill.run(pool, store, { limit: 1 });
    assert.equal(first.migrated, 1); assert.equal(first.done, false);
    const rest = await backfill.run(pool, store);
    assert.equal(rest.migrated, 1); assert.equal(rest.done, true);
    assert.deepEqual(rest.remaining, { check_run_media: 0, session_visuals: 0 });
    const { rows: [row] } = await pool.query('SELECT * FROM session_visuals WHERE id = $1', [legacyId]);
    assert.equal(row.data, null); assert.equal(row.object_key, media.objectKey(legacy));
    assert.equal(row.legacy_etag, metadata(legacy).legacyEtag);
    assert.deepEqual(await media.bytes(store, row), legacy);
    assert.equal(store.calls.filter((c) => c.op === 'put' && c.key === row.object_key).length, 1);
    assert.equal((await media.sweep(pool, store)).removed, 0, 'merged and held references retain the old object');
    assert.equal((await backfill.run(pool, store)).migrated, 0, 'a completed batch is safe to retry');
  });

  await t.test('a locked legacy row is counted as remaining, never mistaken for completion', async () => {
    const rowId = id();
    await pool.query(`INSERT INTO session_visuals (id, session_id, kind, media, content_type, data)
      VALUES ($1, $2, 'after', 'png', 'image/png', $3)`, [rowId, merged.id, legacy]);
    const tx = await pool.connect();
    await tx.query('BEGIN');
    await tx.query('SELECT id FROM session_visuals WHERE id = $1 FOR UPDATE', [rowId]);
    try {
      const result = await backfill.run(pool, store);
      assert.equal(result.migrated, 0); assert.equal(result.done, false);
      assert.equal(result.remaining.session_visuals, 1);
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    assert.equal((await backfill.run(pool, store)).done, true);
  });

  await t.test('the actual backfill clock resumes committed batches in a second process', async (t) => {
    for (let i = 0; i < 24; i++) await pool.query(`INSERT INTO session_visuals (id, session_id, kind, media, content_type, data)
      VALUES ($1, $2, 'after', 'png', 'image/png', $3)`, [id(), merged.id, legacy]);
    t.mock.method(media, 'createMediaStore', () => store);
    const { createRuntime } = require('../src/workflow/kernel/index.ts');
    const { clock, MACHINE, clockKey } = require('../src/workflow/clock/machine.ts');
    const { JOBS, clockServices } = require('../src/workflow/clock/services.ts');
    const job = JOBS.find((job) => job.name === 'media-check-visuals-backfill');
    const make = () => createRuntime({ pool, machines: [clock()], services: clockServices([job], { pool, config: {} }), pollMs: 10 });
    const status = async () => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2',
      [MACHINE, clockKey(job.name)])).rows[0];
    const ask = (runtime, n) => runtime.appendAndWait(MACHINE, clockKey(job.name), { type: 'RunNow', payload: {} },
      { requestKey: 'visual-test:' + n, source: { kind: 'admin', name: 'test' } });
    let active = make();
    t.after(() => active.stop());
    await active.start({ loops: true });
    await active.appendAndWait(MACHINE, clockKey(job.name), { type: 'Arm', payload: { job: job.name, everyMs: job.everyMs, onDemand: true } },
      { requestKey: 'visual-test:arm', source: { kind: 'system', name: 'test' } });
    await ask(active, 1);
    const first = await waitFor(async () => {
      const row = await status(); return row?.state === 'waiting' && row.data.last?.n === 1 ? row : null;
    }, { label: 'the first check-visual batch to settle', timeoutMs: 10000 });
    assert.equal(first.data.last.ok, true);
    assert.equal(first.data.last.result.migrated, 20);
    assert.equal(first.data.last.result.remaining.session_visuals, 4);
    await active.stop(); active = make();
    await active.start({ loops: true }); await ask(active, 2);
    const second = await waitFor(async () => {
      const row = await status(); return row?.state === 'waiting' && row.data.last?.n === 2 ? row : null;
    }, { label: 'the restarted check-visual backfill to finish', timeoutMs: 10000 });
    assert.equal(second.data.last.ok, true);
    assert.equal(second.data.last.result.migrated, 4); assert.equal(second.data.last.result.done, true);
  });

  await t.test('a supplied checksum mismatch never clears legacy bytes', async () => {
    const rowId = id();
    await pool.query(`INSERT INTO session_visuals (id, session_id, kind, media, content_type, data, sha256)
      VALUES ($1, $2, 'after', 'png', 'image/png', $3, $4)`, [rowId, merged.id, legacy, 'f'.repeat(64)]);
    await assert.rejects(backfill.run(pool, store), /checksum mismatch/);
    const { rows: [row] } = await pool.query('SELECT data, object_key FROM session_visuals WHERE id = $1', [rowId]);
    assert.deepEqual(row.data, legacy); assert.equal(row.object_key, null);
  });
});
