const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const routing = require('../src/services/database-routing');
const placement = require('../src/services/database-placement');
const db = require('../src/services/db-manager');
const target = {appId:4, slug:'stockroom', database:'app_stockroom', bindingName:'app-4-production',
  clusterRef:{namespace:'central',name:'central',uid:'central-uid'}};
const policy = {namespace:'social-platform', bindingTargets:[target], runtimeTargets:[
  {id:'shared',namespace:'sv-db-shared',clusterName:'shared',uid:'shared-uid'}]};
const spec = {...target, environment:'production', placement:'central', owner:'app_stockroom_owner',
  credentialRef:{source:'platform-app',appId:4}, endpoint:{host:'central.svc',port:5432}};
const centralEnv = {DB_ADMIN_URL:'postgres://admin:central-secret@central.svc/usernode'};
function options(status) { return {policy,env:centralEnv,getReader:()=>({
  binding:async()=>({metadata:{},spec,status}),
  cluster:async(ns)=>({metadata:{uid:ns==='central'?'central-uid':'shared-uid'}}),
})}; }
const external = {...spec,name:target.bindingName,targetId:'shared',placement:'external',revision:1,
  clusterRef:{namespace:'sv-db-shared',name:'shared',uid:'shared-uid'},
  endpoint:{host:'shared-rw.sv-db-shared.svc.cluster.local',port:5432}};
const adminUrl = 'postgres://postgres:external-secret@shared-rw.sv-db-shared.svc.cluster.local/postgres?sslmode=verify-full&sslrootcert=/etc/sv-database-targets/shared.crt';

test('placement survives new readers and Moving never falls back to central',async()=>{
  for(let i=0;i<2;i++) {
    const records=await placement.resolvePlacements(['app_stockroom'],options({phase:'Ready',current:{targetId:'shared',revision:1}}));
    assert.equal(records[0].clusterRef.uid,'shared-uid'); assert.equal(records[0].targetId,'shared');
  }
  for(const status of [{phase:'Moving',current:{targetId:'central',revision:0}}, {},
    {phase:'Ready',current:{targetId:'unknown',revision:1}}, {phase:'Ready',current:{targetId:'shared',revision:-1}}]) {
    await assert.rejects(placement.resolvePlacements(['app_stockroom'],options(status)),{code:'DATABASE_PLACEMENT_BLOCKED'});
  }
  await assert.rejects(placement.assertCentralPlacement(['app_stockroom'],options({phase:'Ready',current:{targetId:'shared',revision:1}})),{code:'DATABASE_PLACEMENT_BLOCKED'});
});

test('external credentials require matching UID, endpoint and verified TLS',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sv-route-test-')),file=path.join(dir,'targets.json');
  const entry={id:'shared',clusterUid:'shared-uid',adminUrl};
  try {
    for(const patch of [{}, {clusterUid:'replacement'}, {adminUrl:adminUrl.replace('shared-rw.','other.')},
      {adminUrl:adminUrl.replace('verify-full','require')}, {adminUrl:adminUrl.replace('/shared.crt','/other.crt')}]) {
      fs.writeFileSync(file,JSON.stringify({targets:[{...entry,...patch}]}));
      if(!Object.keys(patch).length) assert.equal(routing.credentials([external],{SV_DATABASE_TARGETS_FILE:file}).get('shared'),adminUrl);
      else assert.throws(()=>routing.credentials([external],{SV_DATABASE_TARGETS_FILE:file}),{code:'DATABASE_PLACEMENT_BLOCKED'});
    }
    assert.throws(()=>routing.credentials([external],{}),{code:'DATABASE_PLACEMENT_BLOCKED'});
  } finally {fs.rmSync(dir,{recursive:true});}
});

test('parallel operations isolate external source, central destination and maintenance scope',async()=>{
  const urls=new Map([['shared',adminUrl]]);
  await Promise.all([
    routing.runResolved([external],urls,['app_stockroom','app_fork'],async()=>{
      assert.equal(routing.connection(),null);
      assert.equal(routing.connection('app_stockroom').hostname,external.endpoint.host);
      await new Promise(r=>setImmediate(r));
      assert.equal(routing.connection(),null);
      await routing.withDefault('app_stockroom',async()=>assert.equal(routing.connection().pathname,'/postgres'));
      assert.equal(routing.connection(),null);
    }),
    routing.runResolved([external],urls,['app_stockroom_staging_s1_ab1234'],async()=>{
      await new Promise(r=>setImmediate(r));
      assert.equal(routing.connection().hostname,external.endpoint.host);
      assert.equal(routing.connection('app_unrelated'),null);
    }),
  ]);
  assert.equal(routing.connection(),null);
});

test('external preview URLs keep their own role instead of using the primary owner',async()=>{
  const old=placement.resolvePlacements,env=process.env.DB_ADMIN_URL;
  placement.resolvePlacements=async()=>[external]; process.env.DB_ADMIN_URL=centralEnv.DB_ADMIN_URL;
  try {
    const url=new URL(await db.connectionUrl('app_stockroom_staging_s1_ab1234','preview-secret'));
    assert.equal(url.hostname,external.endpoint.host);
    assert.equal(url.username,'app_stockroom_staging_s1_ab1234_owner');
    assert.equal(url.password,'preview-secret');
  } finally {placement.resolvePlacements=old;if(env===undefined)delete process.env.DB_ADMIN_URL;else process.env.DB_ADMIN_URL=env;}
});
