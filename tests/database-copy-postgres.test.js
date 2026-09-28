'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Client}=require('pg');
const {copyDatabase}=require('../src/services/database-copy');
// Opt in with two disposable PostgreSQL 17 servers using TLS. Never uses DATABASE_URL.
const fixture=process.env.SV_COPY_TEST_FIXTURE;
for (const layout of ['plain','statistics','legacy-public','app-owned-statistics']) test(layout+': real TLS dump/restore preserves ordinary schema/data and analyzes partitions before verification',{skip:!fixture},async t=>{
 const options=JSON.parse(fs.readFileSync(fixture,'utf8'));
 const ca=fs.readFileSync(options.ca,'utf8');
 const configs=[options.source,options.destination].map(host=>({host,port:5432,database:'app_correctness_fixture',user:'app_correctness_fixture_owner',password:'disposable-fixture',ca}));
 const admins=[],owners=[],operators=[];
 t.after(async()=>{
  for(const c of owners)await c.end();
  for(const c of operators)await c.end();
  for(const c of admins){await c.query('DROP DATABASE IF EXISTS app_correctness_fixture WITH (FORCE)');await c.query('DROP ROLE IF EXISTS app_correctness_fixture_owner');await c.end();}
 });
 for(const config of configs){
  const c=new Client({host:config.host,user:'postgres',database:'postgres',ssl:{ca,rejectUnauthorized:true}});await c.connect();admins.push(c);
  await c.query('CREATE ROLE app_correctness_fixture_owner LOGIN');
  await c.query('CREATE DATABASE app_correctness_fixture OWNER app_correctness_fixture_owner');
  await c.query('REVOKE CONNECT ON DATABASE app_correctness_fixture FROM PUBLIC');
  const operator=new Client({host:config.host,user:'postgres',database:config.database,ssl:{ca,rejectUnauthorized:true}});await operator.connect();operators.push(operator);
  const owner=new Client({...config,ssl:{ca,rejectUnauthorized:true}});await owner.connect();owners.push(owner);
 }
 if(layout!=='plain') {
  for(const operator of operators)await operator.query("CREATE EXTENSION pg_stat_statements VERSION '1.11'");
  if(layout==='legacy-public') {
   await admins[0].query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='usernode') THEN CREATE ROLE usernode; END IF; END $$");
   await operators[0].query('ALTER SCHEMA public OWNER TO usernode; SET ROLE usernode; GRANT USAGE,CREATE ON SCHEMA public TO PUBLIC,app_correctness_fixture_owner; RESET ROLE');
  }
  if(layout==='app-owned-statistics') {
   await operators[0].query('ALTER VIEW public.pg_stat_statements OWNER TO app_correctness_fixture_owner; ALTER VIEW public.pg_stat_statements_info OWNER TO app_correctness_fixture_owner; ALTER FUNCTION public.pg_stat_statements(boolean) OWNER TO app_correctness_fixture_owner; ALTER FUNCTION public.pg_stat_statements_info() OWNER TO app_correctness_fixture_owner; ALTER FUNCTION public.pg_stat_statements_reset(oid,oid,bigint,boolean) OWNER TO app_correctness_fixture_owner');
   await operators[1].query('GRANT EXECUTE ON FUNCTION public.pg_stat_statements_reset(oid,oid,bigint,boolean) TO app_correctness_fixture_owner');
  }
  await owners[0].query('CREATE VIEW public.app_statistics AS SELECT userid,calls FROM public.pg_stat_statements');
 }
 await owners[0].query('CREATE SCHEMA private; CREATE TABLE private.items(id serial PRIMARY KEY, value text); INSERT INTO private.items(value) VALUES (\'fixture\'); CREATE TABLE public.parent(id integer) PARTITION BY RANGE(id); CREATE TABLE public.child PARTITION OF public.parent FOR VALUES FROM (0) TO (10); INSERT INTO public.parent VALUES(1),(2)');
 const result=await copyDatabase({source:configs[0],destination:configs[1],maxBytes:256*1024*1024,timeoutMs:60000});
 assert.equal(result.rowCount,'3');assert.equal(result.sequenceCount,1);
 assert.deepEqual((await owners[1].query('SELECT value FROM private.items')).rows,[{value:'fixture'}]);
 const stats=(await owners[1].query("SELECT schemaname,tablename,attname,inherited FROM pg_stats WHERE schemaname IN ('public','private')")).rows;
 assert(stats.some(s=>s.tablename==='items'&&s.attname==='value'));
 assert(stats.some(s=>s.tablename==='parent'&&s.inherited));
 assert(stats.some(s=>s.tablename==='child'));
 if(layout!=='plain') {
  assert.equal((await owners[1].query("SELECT has_function_privilege(current_user,'public.pg_stat_statements_reset(oid,oid,bigint,boolean)','EXECUTE') AS reset")).rows[0].reset,layout==='app-owned-statistics');
  await owners[1].query('SELECT count(*) FROM public.app_statistics');
 }
 assert.equal((await owners[1].query("SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname='public'")).rows[0].owner,'pg_database_owner');
 if(layout==='legacy-public') {
  assert.equal((await owners[0].query("SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname='public'")).rows[0].owner,'usernode');
  // Role remains only until its source schema is dropped by the test cleanup.
  t.after(async()=>{const c=new Client({host:configs[0].host,user:'postgres',database:'postgres',ssl:{ca,rejectUnauthorized:true}});await c.connect();await c.query('DROP ROLE usernode');await c.end();});
 }
});
