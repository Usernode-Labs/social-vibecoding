'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {inspect}=require('../src/services/database-migration-eligibility');
// Explicit opt-in; this test creates/drops only its fixed fixture database on localhost.
const port=Number(process.env.SV_ELIGIBILITY_TEST_PORT);
test('PostgreSQL 17 contract accepts ordinary objects and rejects lossy metadata', {skip:!port}, async t=>{
 const admin=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await admin.connect();
 await admin.query('DROP DATABASE IF EXISTS app_eligibility_fixture WITH (FORCE)');
 await admin.query('DROP ROLE IF EXISTS app_eligibility_fixture_owner');
 await admin.query('DROP ROLE IF EXISTS eligibility_reader');
 await admin.query('CREATE ROLE app_eligibility_fixture_owner LOGIN');
 await admin.query('CREATE ROLE eligibility_reader');
 await admin.query('CREATE DATABASE app_eligibility_fixture OWNER app_eligibility_fixture_owner');
 await admin.query('REVOKE CONNECT ON DATABASE app_eligibility_fixture FROM PUBLIC');
 const db=new Client({host:'127.0.0.1',port,user:'app_eligibility_fixture_owner',database:'app_eligibility_fixture'});await db.connect();
 const privileged=new Client({host:'127.0.0.1',port,user:'postgres',database:'app_eligibility_fixture'});await privileged.connect();
 t.after(async()=>{await db.end();await privileged.end();await admin.query('DROP DATABASE app_eligibility_fixture WITH (FORCE)');await admin.query('DROP ROLE app_eligibility_fixture_owner');await admin.query('DROP ROLE eligibility_reader');await admin.end();});
 await db.query('CREATE SCHEMA private; CREATE TABLE private.items(id serial PRIMARY KEY, value text); INSERT INTO private.items(value) VALUES (\'fixture\'); CREATE TABLE public.parent(id integer) PARTITION BY RANGE(id); CREATE TABLE public.child PARTITION OF public.parent FOR VALUES FROM (0) TO (10)');
 assert.deepEqual((await inspect(db)).reasons,[]);
 assert((await inspect(db)).analyzeTables.some(t=>t.name==='parent'));
 const cases=[
  [admin,'ALTER DATABASE app_eligibility_fixture SET statement_timeout=\'42s\'','ALTER DATABASE app_eligibility_fixture RESET ALL','DATABASE_SETTINGS'],
  [admin,'ALTER ROLE app_eligibility_fixture_owner SET search_path=public','ALTER ROLE app_eligibility_fixture_owner RESET ALL','DATABASE_SETTINGS'],
  [admin,'ALTER ROLE app_eligibility_fixture_owner IN DATABASE app_eligibility_fixture SET work_mem=\'8MB\'','ALTER ROLE app_eligibility_fixture_owner IN DATABASE app_eligibility_fixture RESET ALL','DATABASE_SETTINGS'],
  [admin,'ALTER ROLE eligibility_reader IN DATABASE app_eligibility_fixture SET work_mem=\'8MB\'','ALTER ROLE eligibility_reader IN DATABASE app_eligibility_fixture RESET ALL','DATABASE_SETTINGS'],
  [db,'GRANT SELECT ON private.items TO eligibility_reader','REVOKE SELECT ON private.items FROM eligibility_reader','CUSTOM_PRIVILEGES'],
  [db,'GRANT SELECT(value) ON private.items TO eligibility_reader','REVOKE SELECT(value) ON private.items FROM eligibility_reader','CUSTOM_PRIVILEGES'],
  [db,'GRANT USAGE ON SEQUENCE private.items_id_seq TO eligibility_reader','REVOKE USAGE ON SEQUENCE private.items_id_seq FROM eligibility_reader','CUSTOM_PRIVILEGES'],
  [db,'GRANT CREATE ON SCHEMA public TO PUBLIC','REVOKE CREATE ON SCHEMA public FROM PUBLIC','CUSTOM_PRIVILEGES'],
  [db,'GRANT CONNECT ON DATABASE app_eligibility_fixture TO PUBLIC','REVOKE CONNECT ON DATABASE app_eligibility_fixture FROM PUBLIC','CUSTOM_PRIVILEGES'],
  [db,'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO eligibility_reader','ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM eligibility_reader','DEFAULT_PRIVILEGES'],
  [admin,'GRANT app_eligibility_fixture_owner TO eligibility_reader','REVOKE app_eligibility_fixture_owner FROM eligibility_reader','ROLE_MEMBERSHIPS'],
  [admin,'ALTER DATABASE app_eligibility_fixture CONNECTION LIMIT 12','ALTER DATABASE app_eligibility_fixture CONNECTION LIMIT -1','CONNECTION_LIMITS'],
  [admin,'ALTER ROLE app_eligibility_fixture_owner VALID UNTIL \'2030-01-01\'','ALTER ROLE app_eligibility_fixture_owner VALID UNTIL \'infinity\'','ROLE_ATTRIBUTES'],
  [db,'ALTER TABLE private.items ENABLE ROW LEVEL SECURITY','ALTER TABLE private.items DISABLE ROW LEVEL SECURITY','ROW_SECURITY'],
  [privileged,'CREATE EXTENSION pg_stat_statements','DROP EXTENSION pg_stat_statements','EXTENSIONS'],
 ];
 for(const [client,change,reset,reason] of cases){
  await client.query(change);
  try { assert((await inspect(db)).reasons.includes(reason),reason); } finally {await client.query(reset);}
  assert.deepEqual((await inspect(db)).reasons,[],reset);
 }
 // An explicit infinity expiration is equivalent to no expiration.
 assert.deepEqual((await inspect(db)).reasons,[]);
 await db.query('INSERT INTO private.items(value) SELECT \'row\' FROM generate_series(1,100000)');
 assert((await inspect(db)).reasons.includes('ROW_LIMIT'));
});
