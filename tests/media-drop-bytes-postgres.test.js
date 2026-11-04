'use strict';
// test:changed: when src/db/migrations/ (media contract migration and its history)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { applySchemaWithLockRetry: apply, loadPlan } = require('../src/db/schema-migrations');
const { CATALOG_SQL } = require('./lib/schema-catalog');
const media = require('../src/services/media-store');
const { memoryMediaStore } = require('./lib/media-store');

const DSN = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const TABLES = ['shot_run_files', 'shot_artifacts', 'shots_eval_artifacts',
  'shot_diagnostic_artifacts', 'check_run_media', 'session_visuals'];
const plan = loadPlan();
const cut = plan.findIndex(m => m.id === 'media-drop-bytes');
const noObserver = () => async () => {};
const options = { observe: noObserver, retries: 1, lockTimeoutMs: 100 };
const runId = 'a'.repeat(32);
const normal = Buffer.from('normal fixture bytes');
const dense = Buffer.from('dense original fixture bytes');
const key = media.objectKey(normal), denseKey = media.objectKey(dense);
const sha = key.slice(media.PREFIX.length), denseSha = denseKey.slice(media.PREFIX.length);

async function database(t) {
  const admin = new Pool({ connectionString: DSN });
  const name = 'media_contract_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  return pool;
}

const byteColumns = async pool => (await pool.query(`SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name=ANY($1) AND column_name IN ('data','dense_data') ORDER BY 1,2`, [TABLES])).rows;
const receipts = async pool => (await pool.query('SELECT id,checksum,schema_sha256 FROM schema_migrations ORDER BY id')).rows;
const catalog = async pool => {
  const tx = await pool.connect();
  try { await tx.query('BEGIN; SET LOCAL search_path=pg_catalog');
    return JSON.parse((await tx.query(CATALOG_SQL)).rows[0].inventory);
  } finally { await tx.query('ROLLBACK'); tx.release(); }
};
const references = async pool => (await pool.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
  WHERE c.relname=ANY($1) AND k.contype='f' ORDER BY 1,2`, [TABLES])).rows;
const indexes = async pool => (await pool.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=\'public\' AND tablename=ANY($1) ORDER BY 1,2', [TABLES])).rows;

async function seed(pool, store) {
  await store.putObject(key, normal, 'image/png');
  await store.putObject(denseKey, dense, 'image/png');
  await pool.query('INSERT INTO media_objects VALUES ($1),($2)', [key, denseKey]);
  const { rows: [user] } = await pool.query("INSERT INTO users(username,password) VALUES ('media-owner','x') RETURNING id");
  const { rows: [app] } = await pool.query("INSERT INTO apps(name,slug,created_by) VALUES ('Media','media-contract',$1) RETURNING id", [user.id]);
  const { rows: [session] } = await pool.query('INSERT INTO chat_sessions(app_id,user_id) VALUES ($1,$2) RETURNING id', [app.id, user.id]);
  await pool.query(`INSERT INTO shot_runs(id,session_id,base_sha,head_sha,intent,state)
    VALUES ($1,$2,$3,$4,'{}','exploring')`, [runId, session.id, 'b'.repeat(40), 'c'.repeat(40)]);
  await pool.query(`INSERT INTO shot_run_control(run_id,session_id,intent,context,expires_at)
    VALUES ($1,$2,'{}','{}',now()+interval '1 hour')`, [runId, session.id]);
  await pool.query(`INSERT INTO shot_run_files(run_id,slot,story_id,viewport,side,variant,media,content_type,
    object_key,bytes,sha256,density,dense_object_key,dense_width,dense_height,dense_bytes,dense_sha256)
    VALUES ($1,'one','one','desktop','base','context','png','image/png',$2,$3,$4,2,$5,8,6,$6,$7)`,
  [runId,key,normal.length,sha,denseKey,dense.length,denseSha]);
  await pool.query(`INSERT INTO shot_artifacts(id,run_id,story_id,viewport,side,variant,media,content_type,
    object_key,bytes,sha256,density,dense_object_key,dense_width,dense_height,dense_bytes,dense_sha256)
    VALUES ($1,$2,'one','desktop','base','context','png','image/png',$3,$4,$5,2,$6,8,6,$7,$8)`,
  ['1'.repeat(32),runId,key,normal.length,sha,denseKey,dense.length,denseSha]);
  await pool.query(`INSERT INTO shot_diagnostic_artifacts(id,run_id,attempt,pass,story_id,viewport,side,variant,width,height,object_key,bytes,sha256)
    VALUES ($1,$2,1,1,'one','desktop','base','context',4,3,$3,$4,$5)`, ['2'.repeat(32),runId,key,normal.length,sha]);
  const { rows: [evaluation] } = await pool.query("INSERT INTO shots_eval_runs(label,cap_cents) VALUES ('Local media fixture',100) RETURNING id");
  const { rows: [trial] } = await pool.query(`INSERT INTO shots_eval_trials(eval_run_id,session_id,position,attempt_id,base_sha,head_sha,intent,state)
    VALUES ($1,$2,0,$3,$4,$5,'{}','reviewing') RETURNING id`, [evaluation.id,session.id,runId,'b'.repeat(40),'c'.repeat(40)]);
  await pool.query(`INSERT INTO shots_eval_artifacts(id,trial_id,story_id,viewport,side,variant,media,content_type,object_key,bytes,sha256)
    VALUES ($1,$2,'one','desktop','base','context','png','image/png',$3,$4,$5)`, ['3'.repeat(32),trial.id,key,normal.length,sha]);
  for (const table of ['check_run_media','session_visuals']) {
    const held = table === 'check_run_media';
    await pool.query(`INSERT INTO ${table}(id,session_id,kind,media,content_type,object_key,bytes,sha256,legacy_etag${held?',run_id':''})
      VALUES ($1,$2,'after','png','image/png',$3,$4,$5,'W/"fixture"'${held?',\'checks:one\'':''})`,
    [held?'4'.repeat(32):'5'.repeat(32),session.id,key,normal.length,sha]);
  }
}

test('media column removal refuses incomplete migrations, preserves references, and upgrades atomically', { timeout: 90000 }, async t => {
  if (!DSN) { t.skip('set TEST_DATABASE_URL for the real migration regression'); return; }
  assert.ok(cut > 0);
  // History up to the media migration (`prefixDir`) and through it
  // (`throughDir`): the catalog comparison below reads the media migration's
  // own effect, whatever later migrations (#5974's sessions columns, for one)
  // add after it; the rest of history is applied afterwards.
  const history = (count) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'media-history-'));
    t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
    for (const m of plan.slice(0,count)) fs.copyFileSync(path.join(__dirname,'../src/db/migrations',m.id+'.sql'),path.join(dir,m.id+'.sql'));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,'../src/db/migrations/manifest.json')));
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));
    return dir;
  };
  const prefixDir = history(cut), throughDir = history(cut+1);
  const pool = await database(t);
  await apply(pool,{...options,dir:prefixDir});
  const store = memoryMediaStore({now:()=>0});
  await seed(pool,store);
  const beforeReceipts = await receipts(pool), beforeColumns = await byteColumns(pool);
  const beforeRefs = await references(pool), beforeIndexes = await indexes(pool);
  const beforeCatalog = await catalog(pool);
  const beforeRows = {};
  for (const table of TABLES) beforeRows[table] = (await pool.query(`SELECT * FROM ${table}`)).rows;
  assert.equal(beforeColumns.length,8);
  const unchanged = async () => {
    assert.deepEqual(await byteColumns(pool),beforeColumns,'every byte column survives refusal');
    assert.deepEqual(await receipts(pool),beforeReceipts,'no success receipt after refusal');
  };

  for (const table of TABLES) await t.test(`refuse ordinary bytes in ${table}`,async()=>{
    await pool.query(`UPDATE ${table} SET data=$1,object_key=NULL`,[normal]);
    try {
      await assert.rejects(apply(pool,options),{code:'23514',message:new RegExp(table+'.*still contains bytes')});
      await unchanged();
      assert.deepEqual((await pool.query(`SELECT data FROM ${table}`)).rows[0].data,normal);
    } finally { await pool.query(`UPDATE ${table} SET data=NULL,object_key=$1`,[key]); }
  });
  for (const table of ['shot_run_files','shot_artifacts']) await t.test(`refuse dense originals in ${table}`,async()=>{
    await pool.query(`UPDATE ${table} SET dense_data=$1,dense_object_key=NULL`,[dense]);
    try {
      await assert.rejects(apply(pool,options),{code:'23514',message:new RegExp(table+'.*still contains bytes')});
      await unchanged();
      assert.deepEqual((await pool.query(`SELECT dense_data FROM ${table}`)).rows[0].dense_data,dense);
    } finally { await pool.query(`UPDATE ${table} SET dense_data=NULL,dense_object_key=$1`,[denseKey]); }
  });
  await t.test('refuse inconsistent keys and missing dense metadata',async()=>{
    await pool.query('UPDATE session_visuals SET object_key=$1',[denseKey]);
    try { await assert.rejects(apply(pool,options),/session_visuals has missing or inconsistent object metadata/); await unchanged(); }
    finally { await pool.query('UPDATE session_visuals SET object_key=$1',[key]); }
    await pool.query('UPDATE shot_artifacts SET dense_width=NULL');
    try { await assert.rejects(apply(pool,options),/shot_artifacts has missing or inconsistent dense metadata/); await unchanged(); }
    finally { await pool.query('UPDATE shot_artifacts SET dense_width=8'); }
  });
  await t.test('refuse a missing key even when an old storage constraint is absent',async()=>{
    const {rows:[constraint]}=await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='shots_eval_artifacts'::regclass AND conname='shots_eval_artifacts_storage_check'");
    await pool.query('ALTER TABLE shots_eval_artifacts DROP CONSTRAINT shots_eval_artifacts_storage_check; UPDATE shots_eval_artifacts SET object_key=NULL');
    try { await assert.rejects(apply(pool,options),/shots_eval_artifacts has missing or inconsistent object metadata/); await unchanged(); }
    finally {
      await pool.query('UPDATE shots_eval_artifacts SET object_key=$1',[key]);
      await pool.query('ALTER TABLE shots_eval_artifacts ADD CONSTRAINT shots_eval_artifacts_storage_check '+constraint.definition);
    }
  });
  await t.test('lock conflicts refuse without partial DDL; no reader is cancelled',async()=>{
    const reader=await pool.connect();await reader.query('BEGIN; LOCK TABLE session_visuals IN ACCESS SHARE MODE');
    try { await assert.rejects(apply(pool,options),{code:'55P03'});await unchanged();assert.equal((await reader.query('SELECT 1')).rowCount,1); }
    finally { await reader.query('ROLLBACK');reader.release(); }
  });
  await t.test('a late DDL dependency rolls back earlier column drops and constraint changes',async()=>{
    await pool.query('CREATE VIEW local_media_dependency AS SELECT data FROM session_visuals');
    try { await assert.rejects(apply(pool,options),{code:'2BP01'});await unchanged();assert.deepEqual(await references(pool),beforeRefs); }
    finally { await pool.query('DROP VIEW local_media_dependency'); }
  });

  await apply(pool,{...options,dir:throughDir});
  assert.deepEqual(await byteColumns(pool),[]);
  assert.deepEqual(await references(pool),beforeRefs,'all foreign keys survive');
  assert.deepEqual(await indexes(pool),beforeIndexes,'all key and unrelated indexes survive');
  for (const table of TABLES) {
    const expected=beforeRows[table].map(({data,dense_data,...row})=>row);
    assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows,expected,table+' preserves every metadata field');
    assert.deepEqual(await media.bytes(store,expected[0]),normal);
  }
  assert.deepEqual(await media.bytes(store,{object_key:denseKey}),dense);
  assert.equal((await media.sweep(pool,store)).removed,0,'referenced ordinary and dense objects stay protected');
  assert.equal((await receipts(pool)).length,cut+1);
  const mediaCatalog=await catalog(pool);
  const expectedTables=TABLES.map(t=>'public.'+t).sort();
  assert.deepEqual(mediaCatalog.relations.filter(r=>JSON.stringify(r)!==JSON.stringify(beforeCatalog.relations.find(p=>p.name===r.name))).map(r=>r.name).sort(),expectedTables);
  assert.deepEqual(mediaCatalog.sequences,beforeCatalog.sequences);
  // The rest of history, whatever it holds by now.
  await apply(pool,options);
  const afterReceipts=await receipts(pool);
  assert.equal(afterReceipts.length,cut+1);
  const afterCatalog=await catalog(pool);

  await t.test('new constraints reject missing keys, wrong hashes and inconsistent originals',async()=>{
    for (const table of TABLES) {
      await assert.rejects(pool.query(`UPDATE ${table} SET object_key=NULL`),{code:'23502'});
      await assert.rejects(pool.query(`UPDATE ${table} SET object_key=$1`,[denseKey]),{code:'23514'});
    }
    for (const table of ['check_run_media','session_visuals']) {
      for (const column of ['sha256','bytes','legacy_etag']) await assert.rejects(pool.query(`UPDATE ${table} SET ${column}=NULL`),{code:'23502'});
      await assert.rejects(pool.query(`UPDATE ${table} SET bytes=-1`),{code:'23514'});
    }
    for (const table of ['shot_run_files','shot_artifacts']) {
      for (const assignment of ['density=1','dense_object_key=NULL','dense_width=NULL',"dense_sha256='invalid'"])
        await assert.rejects(pool.query(`UPDATE ${table} SET ${assignment}`),{code:'23514'});
    }
    await assert.rejects(pool.query("UPDATE shot_artifacts SET media='pdf'"),{code:'23514'});
  });
  await t.test('a fresh database matches the upgrade; repeat startup performs no media DDL',async()=>{
    const fresh=await database(t);await apply(fresh,{...options,dir:throughDir});
    assert.deepEqual(await catalog(fresh),afterCatalog);
    const reader=await pool.connect();await reader.query('BEGIN; LOCK TABLE shot_artifacts IN ACCESS SHARE MODE');
    try { await apply(pool,{...options,dir:throughDir});assert.deepEqual(await receipts(pool),afterReceipts); }
    finally { await reader.query('ROLLBACK');reader.release(); }
    await assert.rejects(apply(pool,{...options,dir:prefixDir}),/newer than this build/);
  });
});
