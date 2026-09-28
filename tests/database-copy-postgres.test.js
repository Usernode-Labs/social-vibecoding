'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Client}=require('pg');
const {copyDatabase}=require('../src/services/database-copy');
// Opt in with two disposable PostgreSQL 17 servers using TLS. Never uses DATABASE_URL.
const fixture=process.env.SV_COPY_TEST_FIXTURE;
test('real TLS dump/restore preserves ordinary schema/data and analyzes partitions before verification',{skip:!fixture},async t=>{
 const options=JSON.parse(fs.readFileSync(fixture,'utf8'));
 const ca=fs.readFileSync(options.ca,'utf8');
 const configs=[options.source,options.destination].map(host=>({host,port:5432,database:'app_correctness_fixture',user:'app_correctness_fixture_owner',password:'disposable-fixture',ca}));
 const admins=[],owners=[];
 t.after(async()=>{
  for(const c of owners)await c.end();
  for(const c of admins){await c.query('DROP DATABASE IF EXISTS app_correctness_fixture WITH (FORCE)');await c.query('DROP ROLE IF EXISTS app_correctness_fixture_owner');await c.end();}
 });
 for(const config of configs){
  const c=new Client({host:config.host,user:'postgres',database:'postgres',ssl:{ca,rejectUnauthorized:true}});await c.connect();admins.push(c);
  await c.query('CREATE ROLE app_correctness_fixture_owner LOGIN');
  await c.query('CREATE DATABASE app_correctness_fixture OWNER app_correctness_fixture_owner');
  await c.query('REVOKE CONNECT ON DATABASE app_correctness_fixture FROM PUBLIC');
  const owner=new Client({...config,ssl:{ca,rejectUnauthorized:true}});await owner.connect();owners.push(owner);
 }
 await owners[0].query('CREATE SCHEMA private; CREATE TABLE private.items(id serial PRIMARY KEY, value text); INSERT INTO private.items(value) VALUES (\'fixture\'); CREATE TABLE public.parent(id integer) PARTITION BY RANGE(id); CREATE TABLE public.child PARTITION OF public.parent FOR VALUES FROM (0) TO (10); INSERT INTO public.parent VALUES(1),(2)');
 const result=await copyDatabase({source:configs[0],destination:configs[1],maxBytes:256*1024*1024,timeoutMs:60000});
 assert.equal(result.rowCount,'3');assert.equal(result.sequenceCount,1);
 assert.deepEqual((await owners[1].query('SELECT value FROM private.items')).rows,[{value:'fixture'}]);
 const stats=(await owners[1].query("SELECT schemaname,tablename,attname,inherited FROM pg_stats WHERE schemaname IN ('public','private')")).rows;
 assert(stats.some(s=>s.tablename==='items'&&s.attname==='value'));
 assert(stats.some(s=>s.tablename==='parent'&&s.inherited));
 assert(stats.some(s=>s.tablename==='child'));
});
