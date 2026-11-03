'use strict';
// test:changed: when src/services/db-manager.js (all clone paths)
// test:changed: when src/db/schema.sql (a fresh preview's own boot)
//
// SEC-06: a platform preview's database starts EMPTY on every path that
// makes one (direct, template, and both sides of a shots pair), stamped
// with the current policy digest, and nothing copies the platform's own
// database. The preview's own boot then builds it: the platform's row at
// production's app id, the screenshot personas at their fixed ids with
// their roles, and none of the source's rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');
const policy = require('../src/services/platform-preview-data-policy');
const BASE = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const PREVIEW = process.env.TEST_PREVIEW_DATABASE_URL;
const at = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return String(u); };
async function connection(url) { const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 }); await c.connect(); return c; }
const SEED = `
INSERT INTO public.users (id,username,password,email,bio,is_admin,has_platform_access)
 VALUES (21,'preview-human','private-password','private-email@example.invalid','PRIVATE_USER_BIO',true,true),
 (22,'usernode-capture','private-password',NULL,NULL,false,true),
 (23,'usernode-capture-admin','private-password',NULL,NULL,true,true);
INSERT INTO public.apps (id,name,slug,self_hosted,manifest_snapshot,db_password)
 VALUES (10,'Homeroom','usernode-2d5619',true,'{"secret":"PRIVATE_MANIFEST"}','private-db-password'),
 (11,'PRIVATE_PROJECT','private-project',false,NULL,NULL);
INSERT INTO public.chat_messages (app_id,user_id,content) VALUES (11,21,'PRIVATE_CHAT');
INSERT INTO public.language_translations(language,namespace,key,source,text,model)
 VALUES ('es','shell','safe-key',repeat('a',64),'Traducción pública','public-model') ON CONFLICT DO NOTHING;
`;

async function assertEmpty(client, what) {
  const { rows: [r] } = await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r','p','v','m','S','f')`);
  assert.equal(r.n, 0, `${what}: no relation at all, so no row of the source`);
}

test('platform previews start from an empty database on every path; nothing copies the platform\'s', { timeout: 180000 }, async t => {
  if (!BASE) { t.skip('set TEST_DATABASE_URL to require the PostgreSQL security regression'); return; }
  const token = crypto.randomBytes(4).toString('hex');
  const source = `app_privacy${token}`;
  const admin = await connection(BASE);
  const copyAdmin = PREVIEW ? await connection(PREVIEW) : admin;
  const createdMaintenance = !(await admin.query("SELECT 1 FROM pg_database WHERE datname='usernode'")).rowCount;
  if (createdMaintenance) {
    try { await admin.query('CREATE DATABASE usernode'); }
    catch (error) { if (!['42P04','23505'].includes(error.code)) throw error; }
  }
  const saved = Object.fromEntries(['DATABASE_URL','DB_ADMIN_URL','STAGING_DB_ADMIN_URL','STAGING_DB_SERVER_DRAIN','STAGING_DB_TEMPLATE_MAX_AGE_MS'].map(k=>[k,process.env[k]]));
  process.env.DATABASE_URL = at(BASE,source);
  process.env.DB_ADMIN_URL = at(BASE,'usernode');
  if (PREVIEW) process.env.STAGING_DB_ADMIN_URL=PREVIEW; else delete process.env.STAGING_DB_ADMIN_URL;
  delete process.env.STAGING_DB_SERVER_DRAIN; delete process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS;
  delete require.cache[require.resolve('../src/services/db-manager')];
  const db = require('../src/services/db-manager');
  let src;
  t.after(async () => {
    await src?.end();
    await db._templateIdleForTest(source).catch(()=>{});
    for (const control of new Set([admin,copyAdmin])) {
      for (const {datname} of (await control.query('SELECT datname FROM pg_database WHERE starts_with(datname,$1)',[source])).rows) {
        await control.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
      }
      for (const {rolname} of (await control.query('SELECT rolname FROM pg_roles WHERE starts_with(rolname,$1)',[source])).rows) await control.query(`DROP ROLE IF EXISTS ${rolname}`);
    }
    if (copyAdmin !== admin) await copyAdmin.end();
    await admin.end();
    for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k]=v; }
  });
  await admin.query(`CREATE DATABASE ${source}`);
  src = await connection(at(BASE,source));
  await src.query(fs.readFileSync(require.resolve('../src/db/schema.sql'),'utf8'));
  await src.query(SEED);
  const template = db.stagingTemplateDbName(source);
  const templateExists = async () => (await copyAdmin.query('SELECT 1 FROM pg_database WHERE datname=$1',[template])).rowCount > 0;

  // Direct and template requests alike: an empty database, stamped, and no
  // template is made from the source.
  const bootDatabaseUrls = [];
  for (const [suffix, options] of [['_staging_s1_abcdef',{}],['_staging_s2_abcdef',{viaTemplate:true}]]) {
    const target = source+suffix;
    const result = await db.cloneDatabase(source,target,options);
    assert.equal(result.platformPreviewPolicy,policy.DIGEST);
    assert.equal(result.via,'empty');
    assert.deepEqual(policy.runtimeLabels(result), { [policy.LABEL]: policy.DIGEST });
    const url = db.connectionUrl(target,result.password,{server:result.server});
    bootDatabaseUrls.push(url);
    const clone = await connection(url); await assertEmpty(clone, suffix); await clone.end();
  }
  assert.equal(await templateExists(), false, 'no template of the platform database');

  // A shots pair: an empty, connectionless source, and an empty database on
  // each side, whatever the descriptor claims.
  const prepared = await db.prepareStagingCloneSource(source,{sourceId:token});
  const { rows: [frozen] } = await copyAdmin.query('SELECT datallowconn FROM pg_database WHERE datname=$1',[prepared.templateDb]);
  assert.equal(frozen.datallowconn,false);
  for (const [suffix, descriptor] of [['_staging_s3_abcdef',{...prepared,platformPreviewPolicy:'forged'}],['_staging_s4_abcdef',PREVIEW ? prepared : prepared.templateDb]]) {
    const target = source+suffix;
    const result = await db.cloneFromPreparedSource(descriptor,target);
    assert.equal(result.platformPreviewPolicy,policy.DIGEST);
    const clone = await connection(db.connectionUrl(target,result.password,{server:result.server})); await assertEmpty(clone, suffix); await clone.end();
  }
  await db.releasePreparedCloneSource(prepared);
  assert.equal(await templateExists(), false);

  // Every way of copying the platform's database refuses it.
  await assert.rejects(db.ensureStagingTemplate(source), { noFallback: true });
  await assert.rejects(db.refreshStagingTemplate(source), { noFallback: true });
  await assert.rejects(db.cloneFromTemplate(template, source+'_staging_s5_abcdef'), { noFallback: true });
  assert.equal(await templateExists(), false);
  assert.equal((await src.query('SELECT email FROM public.users WHERE id=21')).rows[0].email,'private-email@example.invalid','the source is untouched');

  // The preview's own boot builds it. Many seeders catch errors, so assert
  // the resulting state, not just the exit status.
  const bootstrap = `
    const assert=require('node:assert/strict');
    (async()=>{
      const config=require('./src/config').load();
      await require('./src/db/migrate').migrate(config);
      const pool=require('./src/db/pool').getPool(config);
      const scalar=async (sql,params)=>Object.values((await pool.query(sql,params)).rows[0])[0];
      assert.equal(await scalar("SELECT id FROM apps WHERE slug='usernode-2d5619' AND self_hosted"),10,'production app id');
      const persona=async name=>(await pool.query('SELECT id,is_admin,admin_readonly,has_platform_access FROM users WHERE username=$1',[name])).rows[0];
      assert.deepEqual(await persona('usernode-capture'),{id:2147482996,is_admin:false,admin_readonly:false,has_platform_access:true});
      assert.deepEqual(await persona('usernode-capture-admin'),{id:2147482997,is_admin:true,admin_readonly:true,has_platform_access:true});
      for (const id of [2147482996,2147482997]) {
        assert.equal(await scalar("SELECT count(*)::int FROM community_members WHERE user_id=$1 AND community_id=(SELECT community_id FROM apps WHERE slug='usernode-2d5619')",[id]),1,String(id));
      }
      // No seeded row sits on a production id a reviewer may sign in with.
      assert.equal(await scalar("SELECT count(*)::int FROM users WHERE id < 900000"),0,'every seeded user above production ids');
      const {rows:[next]}=await pool.query("INSERT INTO apps (name,slug,status) VALUES ('After','after-the-platform','running') RETURNING id");
      assert.ok(next.id>10,'the apps sequence moved past the platform');
      assert.equal(await scalar("SELECT count(*)::int FROM users WHERE username='preview-human' OR email LIKE 'private-%' OR bio LIKE 'PRIVATE%' OR password='private-password'"),0,'no production account');
      assert.equal(await scalar("SELECT count(*)::int FROM apps WHERE slug='private-project'"),0,'no production project');
      assert.equal(await scalar("SELECT count(*)::int FROM chat_messages WHERE content LIKE 'PRIVATE%'"),0);
      assert.equal(await scalar("SELECT count(*)::int FROM language_translations"),0,'no translation without the public export');
      assert.ok(await scalar("SELECT count(*)::int FROM chat_sessions")>0,'the staging fixtures were seeded');
      await pool.end();console.log('PREVIEW_BOOT_VERIFIED');
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const {promisify}=require('node:util');
  const {execFile}=require('node:child_process');
  for (const bootDatabaseUrl of bootDatabaseUrls) {
    const {stdout}=await promisify(execFile)(process.execPath,['-e',bootstrap],{
      cwd:require('node:path').resolve(__dirname,'..'),timeout:90000,maxBuffer:8*1024*1024,
      env:{...process.env,DATABASE_URL:bootDatabaseUrl,DB_ADMIN_URL:'',STAGING_DB_ADMIN_URL:'',USERNODE_ENV:'staging',USERNODE_APP_ID:'10',
        USERNODE_PLATFORM_ORIGIN:'',ADMIN_USERNAME:'preview-bootstrap-admin',ADMIN_PASSWORD:'fixture-only-password',SESSION_SECRET:'fixture-only-session-secret',MAX_APPS:'0'},
    });
    assert.match(stdout,/PREVIEW_BOOT_VERIFIED/);
  }
});
