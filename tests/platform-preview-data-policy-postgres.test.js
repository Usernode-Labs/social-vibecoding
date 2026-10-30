'use strict';
// test:changed: when src/services/platform-preview-data-policy.json (reviewed data contract)
// test:changed: when src/services/platform-preview-schema.json (schema compatibility)
// test:changed: when src/services/db-manager.js (all clone paths)
// test:changed: when src/db/schema.sql (complete migrated catalog)
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
const psql = client => async (_db, sql, opts = {}) => {
  const result = await client.query(sql);
  const last = Array.isArray(result) ? result.at(-1) : result;
  return opts.tuplesOnly ? last.rows.map(row => Object.values(row).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v ?? '').join('|')).join('\n') : '';
};
const SEED = `
INSERT INTO public.users (id,username,password,email,bio,is_admin,waitlist_answers,has_platform_access)
 VALUES (21,'preview-human','private-password','private-email@example.invalid','PRIVATE_USER_BIO',true,'{"secret":"PRIVATE_ANSWERS"}',true),
 (22,'usernode-capture','private-password',NULL,NULL,false,NULL,true),
 (23,'usernode-capture-admin','private-password',NULL,NULL,true,NULL,true),
 (24,'preview-user-21','private-password',NULL,NULL,false,NULL,true);
INSERT INTO public.apps (id,name,slug,self_hosted,manifest_snapshot,last_failure,db_password)
 VALUES (10,'Homeroom','usernode-2d5619',true,'{"secret":"PRIVATE_MANIFEST"}','{"log":"PRIVATE_LOG"}','private-db-password'),
 (11,'PRIVATE_PROJECT','private-project',false,'{"secret":"PRIVATE_PROJECT_MANIFEST"}',NULL,NULL);
INSERT INTO public.chat_messages (app_id,user_id,content,metadata) VALUES (11,21,'PRIVATE_CHAT','{"secret":"PRIVATE_CHAT_JSON"}');
INSERT INTO public.issues (app_id,created_by,title,description,payload) VALUES (11,21,'PRIVATE_TITLE','PRIVATE_DESCRIPTION','{"secret":"PRIVATE_ISSUE"}');
INSERT INTO public.app_report_snapshots(app_id,html,ai_json,share_token) VALUES(10,'PRIVATE_REPORT_HTML','{"secret":"PRIVATE_REPORT_AI"}','private-live-share-token');
WITH scan AS (INSERT INTO public.compliance_scans DEFAULT VALUES RETURNING id)
 INSERT INTO public.compliance_scan_results(scan_id,check_key,state,summary,failing)
 SELECT id,'private_projects','fail','PRIVATE_SCAN','[{"privateProject":"PRIVATE_PROJECT"}]' FROM scan;
INSERT INTO public.waitlist_signups(email,answers) VALUES ('private-waitlist@example.invalid','{"secret":"PRIVATE_WAITLIST"}');
INSERT INTO public.language_translations(language,namespace,key,source,text,model)
 VALUES ('es','shell','safe-key',repeat('a',64),'Traducción pública','public-model') ON CONFLICT DO NOTHING;
INSERT INTO public.agent_model_compatibility(backend,model_id,status,note) VALUES('codex','public-model','verified','PRIVATE_OPERATOR_NOTE') ON CONFLICT DO NOTHING;
INSERT INTO public.platform_settings(key,value) VALUES('private-setting','PRIVATE_SETTING') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
CREATE FUNCTION public.private_runtime_config() RETURNS text LANGUAGE sql AS $$ SELECT 'PRIVATE_SCHEMA_VALUE'::text $$;
COMMENT ON TABLE public.users IS 'PRIVATE_SCHEMA_COMMENT';
COMMENT ON COLUMN public.users.password IS NULL;
COMMENT ON TABLE public.app_report_snapshots IS NULL;
`;
async function assertSanitized(client) {
  // Match the deployed executors' catalog namespace (format_type qualifies
  // user-defined types differently when public is in search_path).
  await client.query('SET search_path = pg_catalog');
  const users = (await client.query('SELECT id, username, password,email,bio,is_admin,admin_readonly,has_platform_access FROM public.users ORDER BY id')).rows;
  assert.deepEqual(users.map(r => [r.id,r.username]), [[21,'preview-user-21'],[22,'usernode-capture'],[23,'usernode-capture-admin'],[24,'preview-user-24']]);
  assert.ok(users.every(r => r.password === '__staging_redacted__' && r.email === null && r.bio === null && r.has_platform_access));
  assert.equal(users[0].is_admin,false);
  assert.equal(users[2].is_admin,true); assert.equal(users[2].admin_readonly,true);
  assert.deepEqual((await client.query('SELECT id,slug,manifest_snapshot,last_failure,db_password FROM public.apps')).rows,
    [{id:10,slug:policy.PLATFORM_SLUG,manifest_snapshot:null,last_failure:null,db_password:null}]);
  const { catalog } = await policy.inspect('clone',psql(client));
  for (const name of policy.exclusions(catalog)) {
    assert.equal((await client.query(`SELECT EXISTS(SELECT 1 FROM ${name}) AS present`)).rows[0].present,false,name);
  }
  assert.equal((await client.query("SELECT note FROM public.agent_model_compatibility WHERE model_id='public-model'")).rows[0].note,null);
  assert.equal((await client.query("SELECT text FROM public.language_translations WHERE key='safe-key'")).rows[0].text,'Traducción pública');
  assert.equal((await client.query("SELECT count(*)::int n FROM pg_proc WHERE proname='private_runtime_config'")).rows[0].n,0,'production routine body is never copied');
  assert.notEqual((await client.query("SELECT obj_description('public.users'::regclass,'pg_class') comment")).rows[0].comment,'PRIVATE_SCHEMA_COMMENT','production comments are never copied');
  const triggers = (await client.query('SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled=\'D\'')).rows[0].n;
  assert.equal(triggers,0,'user triggers restored');
}

test('platform exports are explicit on direct, template and prepared shots clones; schema drift is fatal', { timeout: 180000 }, async t => {
  if (!BASE) { t.skip('set TEST_DATABASE_URL to require the PostgreSQL security regression'); return; }
  const token = crypto.randomBytes(4).toString('hex');
  const source = `app_privacy${token}`;
  const admin = await connection(BASE);
  const copyAdmin = PREVIEW ? await connection(PREVIEW) : admin;
  const copyServer = PREVIEW ? 'preview' : 'primary';
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
  await src.query('SET search_path = pg_catalog');
  const inventory = await policy.inspect(source,psql(src));
  assert.ok(policy.exclusions(inventory.catalog).includes('public.app_report_snapshots'),'omission of a private comment cannot export a table');
  let bootDatabaseUrl;
  for (const [suffix, options] of [['_staging_s1_abcdef',{}],['_staging_s2_abcdef',{viaTemplate:true}]]) {
    const target=source+suffix;
    const result=await db.cloneDatabase(source,target,options);
    assert.equal(result.platformPreviewPolicy,policy.DIGEST);
    if (options.viaTemplate) bootDatabaseUrl=db.connectionUrl(target,result.password,{server:result.server});
    const clone=await connection(db.connectionUrl(target,result.password,{server:result.server}));
    await assertSanitized(clone);await clone.end();
  }
  const template=db.stagingTemplateDbName(source);
  // A fresh timestamp must not bless a template from an older policy.
  await copyAdmin.query(`COMMENT ON DATABASE ${template} IS 'staging-template source=${source} refreshed_at=${new Date().toISOString()} preview_policy=old'`);
  const refreshed=await db.ensureStagingTemplate(source,{server:copyServer});
  assert.equal(refreshed.refreshed,true);
  const prepared=await db.prepareStagingCloneSource(source,{sourceId:token});
  for (const [suffix, descriptor] of [['_staging_s3_abcdef',{...prepared,sourceDb:'forged',fingerprint:'forged',platformPreviewPolicy:'forged'}],['_staging_s4_abcdef',PREVIEW ? prepared : prepared.templateDb]]) {
    const target=source+suffix;
    const result=await db.cloneFromPreparedSource(descriptor,target);
    assert.equal(result.platformPreviewPolicy,policy.DIGEST);
    const clone=await connection(db.connectionUrl(target,result.password,{server:result.server}));await assertSanitized(clone);await clone.end();
  }
  await copyAdmin.query(`COMMENT ON DATABASE ${prepared.templateDb} IS 'forged'`);
  await assert.rejects(db.cloneFromPreparedSource(prepared,source+'_staging_s5_abcdef'),{noFallback:true});
  // Validate source every time, even with a warm cache. Each case is isolated.
  for (const [ddl, undo] of [
    ['ALTER TABLE public.users ADD COLUMN private_new_field text','ALTER TABLE public.users DROP COLUMN private_new_field'],
    ['ALTER TABLE public.language_translations ADD COLUMN private_new_field text','ALTER TABLE public.language_translations DROP COLUMN private_new_field'],
    ['CREATE TABLE public.unreviewed(id int,secret text)','DROP TABLE public.unreviewed'],
    ['CREATE SCHEMA unreviewed','DROP SCHEMA unreviewed'],
    ['CREATE SEQUENCE public.unreviewed_sequence','DROP SEQUENCE public.unreviewed_sequence'],
    ['CREATE MATERIALIZED VIEW public.leak AS SELECT email FROM public.users','DROP MATERIALIZED VIEW public.leak'],
    ['CREATE TABLE public.partition_parent(id int) PARTITION BY RANGE(id)','DROP TABLE public.partition_parent'],
    ['CREATE VIEW public.leak AS SELECT email FROM public.users','DROP VIEW public.leak'],
    ['ALTER TABLE public.users ENABLE ROW LEVEL SECURITY','ALTER TABLE public.users DISABLE ROW LEVEL SECURITY'],
    ['SELECT lo_create(990987654)','SELECT lo_unlink(990987654)'],
  ]) {
    await src.query(ddl);
    if (ddl.includes('ADD COLUMN')) {
      await assert.rejects(require('../scripts/check-sql').validatePlatformPreviewPolicy(at(BASE,source)),{noFallback:true});
      const changed=JSON.parse((await src.query(policy.CATALOG_SQL)).rows[0].inventory);
      const expected=policy.schema.fingerprint;
      try {
        // Updating a compatibility checksum cannot silently approve a new
        // field, including on a catalog whose existing columns all say keep.
        policy.schema.fingerprint=policy.schemaFingerprint(changed);
        assert.throws(()=>policy.verifyCatalog(changed),/missing column policy/);
      } finally { policy.schema.fingerprint=expected; }
    }
    if (ddl.startsWith('CREATE TABLE public.unreviewed')) {
      const changed=JSON.parse((await src.query(policy.CATALOG_SQL)).rows[0].inventory);
      const expected=policy.schema.fingerprint;
      try {
        policy.schema.fingerprint=policy.schemaFingerprint(changed);
        policy.verifyCatalog(changed);
        assert.ok(policy.exclusions(changed).includes('public.unreviewed'));
        assert.equal(policy.retainedTables().includes('public.unreviewed'),false);
      } finally { policy.schema.fingerprint=expected; }
    }
    await assert.rejects(db.cloneDatabase(source,source+'_staging_s6_abcdef',{viaTemplate:true}),{noFallback:true});
    await src.query(undo);
  }
  // Copied-schema drift is checked separately, before any code can start.
  await src.query('ALTER TABLE public.users ADD COLUMN private_after_dump text');
  await assert.rejects(policy.sanitize(source,psql(src)),{noFallback:true});
  await src.query('ALTER TABLE public.users DROP COLUMN private_after_dump');
  const raw=(await src.query('SELECT email FROM public.users WHERE id=21')).rows[0].email;
  assert.equal(raw,'private-email@example.invalid','production source remains untouched');
  // Boot the real migration/fixture library in an isolated process. Many
  // seeders catch errors, so assert resulting state, not just exit status.
  const bootstrap = `
    const assert=require('node:assert/strict');
    (async()=>{
      const config=require('./src/config').load();
      await require('./src/db/migrate').migrate(config);
      const pool=require('./src/db/pool').getPool(config);
      const scalar=async sql=>Object.values((await pool.query(sql)).rows[0])[0];
      assert.equal(await scalar("SELECT id FROM users WHERE username='usernode-capture'"),22);
      assert.equal(await scalar("SELECT id FROM users WHERE username='usernode-capture-admin'"),23);
      assert.equal(await scalar("SELECT count(*)::int FROM apps WHERE slug='usernode-2d5619'"),1);
      assert.equal(await scalar("SELECT count(*)::int FROM community_members WHERE user_id=22 AND community_id=(SELECT community_id FROM apps WHERE slug='usernode-2d5619')"),1);
      assert.ok(await scalar("SELECT count(*)::int FROM chat_sessions")>0);
      assert.ok(await scalar("SELECT count(*)::int FROM apps")>1);
      assert.equal(await scalar("SELECT count(*)::int FROM terms_versions WHERE id=900500 AND published_at IS NOT NULL"),1);
      assert.equal(await scalar("SELECT count(*)::int FROM terms_versions WHERE version='1.0-2026-10-29' AND published_at IS NOT NULL"),1);
      assert.equal(await scalar("SELECT username FROM users WHERE id=21"),'preview-user-21');
      await pool.end();console.log('PREVIEW_BOOT_VERIFIED');
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const {promisify}=require('node:util');
  const {execFile}=require('node:child_process');
  const {stdout}=await promisify(execFile)(process.execPath,['-e',bootstrap],{
    cwd:require('node:path').resolve(__dirname,'..'),timeout:90000,maxBuffer:8*1024*1024,
    env:{...process.env,DATABASE_URL:bootDatabaseUrl,DB_ADMIN_URL:'',STAGING_DB_ADMIN_URL:'',USERNODE_ENV:'staging',USERNODE_APP_ID:'10',
      ADMIN_USERNAME:'preview-bootstrap-admin',ADMIN_PASSWORD:'fixture-only-password',SESSION_SECRET:'fixture-only-session-secret',MAX_APPS:'0'},
  });
  assert.match(stdout,/PREVIEW_BOOT_VERIFIED/);

});
