'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const io = require('../src/services/media-transaction-io');
const media = require('../src/services/media-store');
const { memoryMediaStore } = require('./lib/media-store');
const { deferred, waitFor } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('media storage waits survive the database idle guard and fail without losing legacy bytes', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'media_io_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4,
    options: '-c idle_in_transaction_session_timeout=200' });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query(`CREATE TABLE media_objects(object_key text PRIMARY KEY);
    CREATE TABLE legacy_media(id text PRIMARY KEY, data bytea, object_key text REFERENCES media_objects(object_key))`);
  const original = Buffer.from('keep this until its object and key commit');
  const run = io.run;

  await t.test('a slow upload exceeds the server idle budget while its lock and transaction stay alive', async (st) => {
    st.mock.method(io, 'run', (tx, operation) => run(tx, operation, { heartbeatMs: 20, timeoutMs: 5000 }));
    await pool.query('INSERT INTO legacy_media VALUES ($1,$2,NULL)', ['slow', original]);
    const tx = await pool.connect(), store = memoryMediaStore(), entered = deferred(), release = deferred();
    const put = store.putObject.bind(store);
    store.putObject = async (...args) => { entered.resolve(); await release.promise; await put(...args); };
    try {
      await tx.query('BEGIN');
      const { rows: [row] } = await tx.query("SELECT pg_backend_pid() AS pid, data FROM legacy_media WHERE id='slow' FOR UPDATE");
      const upload = media.put(tx, store, row.data);
      await entered.promise;
      await waitFor(async () => {
        const { rows: [r] } = await pool.query(`SELECT count(*)::int AS alive FROM pg_stat_activity
          WHERE pid=$1 AND xact_start < clock_timestamp() - interval '500 milliseconds'`, [row.pid]);
        return r.alive === 1;
      }, { label: 'the upload transaction to remain alive beyond its idle timeout' });
      release.resolve();
      const key = await upload;
      await tx.query("UPDATE legacy_media SET object_key=$1,data=NULL WHERE id='slow'", [key]);
      await tx.query('COMMIT');
      const { rows: [saved] } = await pool.query("SELECT data,object_key FROM legacy_media WHERE id='slow'");
      assert.equal(saved.data, null); assert.equal(saved.object_key, media.objectKey(original));
      assert.deepEqual(await media.bytes(store, saved), original);
    } finally { release.resolve(); await tx.query('ROLLBACK').catch(() => {}); tx.release(); }
  });

  await t.test('a stalled upload deadline rolls back and leaves the original bytes available for retry', async (st) => {
    st.mock.method(io, 'run', (tx, operation) => run(tx, operation, { heartbeatMs: 20, timeoutMs: 100 }));
    await pool.query('INSERT INTO legacy_media VALUES ($1,$2,NULL)', ['deadline', original]);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SELECT id FROM legacy_media WHERE id='deadline' FOR UPDATE");
      await assert.rejects(media.put(tx, { statObject: async () => null,
        putObject: () => new Promise(() => {}) }, original), { code: 'media_storage_timeout' });
      await tx.query('ROLLBACK');
      const { rows: [saved] } = await pool.query("SELECT data,object_key FROM legacy_media WHERE id='deadline'");
      assert.deepEqual(saved.data, original); assert.equal(saved.object_key, null);
      assert.equal((await tx.query('SELECT 1')).rowCount, 1, 'the healthy connection remains reusable');
    } finally { await tx.query('ROLLBACK').catch(() => {}); tx.release(); }
  });

  await t.test('the original idle-timeout crash becomes a rejected operation in a real child process', async () => {
    await pool.query('INSERT INTO legacy_media VALUES ($1,$2,NULL)', ['disconnect', original]);
    const script = `
      const {Pool}=require('pg'),media=require('./src/services/media-store');
      (async()=>{
        const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,
          options:'-c idle_in_transaction_session_timeout=200'});
        pool.on('error',()=>{});
        const tx=await pool.connect();let code;
        try {
          await tx.query('BEGIN');
          const {rows:[row]}=await tx.query("SELECT data FROM legacy_media WHERE id='disconnect' FOR UPDATE");
          await media.put(tx,{statObject:async()=>null,putObject:()=>new Promise(()=>{})},row.data);
        } catch(e) {code=e.code;await tx.query('ROLLBACK').catch(()=>{});}
        finally {tx.release();await pool.end();}
        console.log(JSON.stringify({code}));if(code!=='25P03')process.exitCode=2;
      })().catch(e=>{console.error(e);process.exitCode=3});`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), timeout: 10000,
        env: { ...process.env, TEST_DATABASE_URL: String(url) } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
      child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).code, '25P03');
    const { rows: [saved] } = await pool.query("SELECT data,object_key FROM legacy_media WHERE id='disconnect'");
    assert.deepEqual(saved.data, original); assert.equal(saved.object_key, null);
  });
});
