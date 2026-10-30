'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const media = require('../src/services/media-store');
const { memoryMediaStore } = require('./lib/media-store');
const { waitFor, deferred } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('media cleanup and uploads are fenced by real PostgreSQL references and transactions', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'media_store_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // Two independent owners, as publication and dense copies will be. An
  // immediate FK on every key is the storage contract, across all tables.
  await pool.query(`CREATE TABLE media_test_refs (id text PRIMARY KEY, object_key text REFERENCES media_objects(object_key));
    CREATE TABLE media_test_copies (id text PRIMARY KEY, object_key text REFERENCES media_objects(object_key))`);
  const store = memoryMediaStore({ now: () => 0 });
  const upload = async (label, data) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const key = await media.put(tx, store, Buffer.from(data));
      await tx.query('INSERT INTO media_test_refs VALUES ($1, $2)', [label, key]);
      await tx.query('COMMIT');
      return key;
    } catch (err) { await tx.query('ROLLBACK'); throw err; } finally { tx.release(); }
  };
  const blocked = () => waitFor(async () => {
    const { rows: [r] } = await pool.query(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`);
    return r.blocked;
  }, { label: 'the competing transaction to wait on the key lock', timeoutMs: 3000 });

  await t.test('a referenced object survives, including when only the second table owns it', async () => {
    const key = await upload('first', 'shared');
    await pool.query('INSERT INTO media_test_copies VALUES ($1, $2)', ['copy', key]);
    await pool.query("DELETE FROM media_test_refs WHERE id = 'first'");
    assert.equal((await media.sweep(pool, store)).removed, 0);
    assert.ok(store.files.has(key));
    await pool.query("DELETE FROM media_test_copies WHERE id = 'copy'");
    assert.equal((await media.sweep(pool, store)).removed, 1);
    assert.equal(store.files.has(key), false);
    assert.equal((await pool.query('SELECT * FROM media_objects WHERE object_key = $1', [key])).rowCount, 0);
  });

  await t.test('rollback leaves no row, and its orphan is removed only when more than a day old', async () => {
    const tx = await pool.connect();
    await tx.query('BEGIN');
    const key = await media.put(tx, store, Buffer.from('rollback'));
    await tx.query('ROLLBACK'); tx.release();
    assert.equal((await pool.query('SELECT * FROM media_objects WHERE object_key = $1', [key])).rowCount, 0);
    assert.equal((await media.sweep(pool, store, { now: media.ORPHAN_AGE_MS })).removed, 0);
    assert.equal((await media.sweep(pool, store, { now: media.ORPHAN_AGE_MS + 1 })).removed, 1);
  });

  await t.test('cleanup waits for an upload to commit its reference', async () => {
    const tx = await pool.connect();
    await tx.query('BEGIN');
    const key = await media.put(tx, store, Buffer.from('in-flight'));
    const sweep = media.sweep(pool, store);
    try {
      await blocked();
      await tx.query('INSERT INTO media_test_refs VALUES ($1, $2)', ['in-flight', key]);
      await tx.query('COMMIT');
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    assert.equal((await sweep).removed, 0);
    assert.equal((await media.bytes(store, { object_key: key })).toString(), 'in-flight');
    await pool.query("DELETE FROM media_test_refs WHERE id = 'in-flight'");
    await media.sweep(pool, store);
  });

  await t.test('an upload behind cleanup recreates the object before committing its reference', async () => {
    const data = Buffer.from('recreated');
    const key = media.objectKey(data);
    await store.putObject(key, data);
    const entered = deferred(); const release = deferred();
    const removing = { ...store, async removeObject(k) { entered.resolve(); await release.promise; await store.removeObject(k); } };
    const sweep = media.sweep(pool, removing);
    await entered.promise;
    const written = upload('recreated', 'recreated');
    try { await blocked(); } finally { release.resolve(); }
    assert.equal((await sweep).removed, 1);
    assert.equal(await written, key);
    assert.equal((await media.bytes(store, { object_key: key })).toString(), 'recreated');
    await pool.query("DELETE FROM media_test_refs WHERE id = 'recreated'");
    await media.sweep(pool, store);
  });

  await t.test('a failed object deletion rolls its registry deletion back and retries safely', async () => {
    const key = await upload('delete-failure', 'retry delete');
    await pool.query("DELETE FROM media_test_refs WHERE id = 'delete-failure'");
    await assert.rejects(media.sweep(pool, { ...store, removeObject: async () => { throw new Error('provider unavailable'); } }), /provider unavailable/);
    assert.equal((await pool.query('SELECT * FROM media_objects WHERE object_key = $1', [key])).rowCount, 1);
    assert.ok(store.files.has(key));
    assert.equal((await media.sweep(pool, store)).removed, 1);
  });

  await t.test('a fresh upload discovered through an old listing is retained after the locked stat', async () => {
    const key = media.objectKey(Buffer.from('fresh'));
    await store.putObject(key, Buffer.from('fresh'));
    const staleListing = { ...store, statObject: async (k) => ({ ...await store.statObject(k), lastModified: new Date() }) };
    assert.equal((await media.sweep(pool, staleListing)).removed, 0);
    assert.ok(store.files.has(key));
    await media.sweep(pool, store);
  });
});
