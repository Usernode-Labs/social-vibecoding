'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {choose,validate,records,record,ensureDatabase}=require('../src/services/database-allocation');
const now=Date.now();
const policy={operatorManaged:true,capacity:{prometheusUrl:'http://p.monitoring.svc.cluster.local',stopRatio:.9,maxSampleAgeSeconds:180},
 placement:{registry:true,enabled:true,newAppsAfterId:4,admissionRatio:.8,starter:{cpu:.025,memory:64,storage:512}},
 targets:['a','b'].map(id=>({id,namespace:`sv-db-${id}`,clusterName:id})),
 runtimeTargets:['a','b'].map(id=>({id,uid:`uid-${id}`,namespace:`sv-db-${id}`,clusterName:id})),
 pools:['a','b'].map(id=>({id,uid:`uid-${id}`,acceptingNewApps:true}))};
const observation=(id,multiplier=1)=>({id,phase:'Ready',acceptingNewApps:true,capacity:{state:'available',observedAt:new Date(now).toISOString(),ratios:{cpu:.1,memory:.1,storage:.1},cpuBudgetCores:.5*multiplier,memoryBudgetBytes:1024*multiplier,storageCapacityBytes:10240*multiplier}});
test('allocator normalizes unequal budgets, counts durable reservations and breaks ties deterministically',()=>{
 assert.equal(choose(policy,[observation('a'),observation('b',2)],[],now).id,'b');
 assert.equal(choose(policy,[observation('b'),observation('a')],[],now).id,'a');
 assert.equal(choose(policy,[observation('a'),observation('b')],[{target_id:'a',demand:policy.placement.starter}],now).id,'b');
});
test('stale, unknown, full, closed and over-reserved pools cannot admit apps',()=>{
 for(const patch of [{phase:'Unavailable'},{acceptingNewApps:false},{capacity:{...observation('a').capacity,state:'unknown'}},{capacity:{...observation('a').capacity,observedAt:new Date(now-181000).toISOString()}},{capacity:{...observation('a').capacity,ratios:{cpu:.79,memory:.1,storage:.1}}}])
 assert.equal(choose(policy,[{...observation('a'),...patch}],[],now),null);
 assert.equal(choose(policy,[observation('a')],[{target_id:'a',demand:{cpu:1,memory:1,storage:1}}],now),null);
 assert.throws(()=>validate({...policy,runtimeTargets:[]}));
});
const row={app_id:5,slug:'probe',database_name:'app_probe',phase:'Ready',target_id:'a',cluster_uid:'uid-a',cluster_namespace:'sv-db-a',cluster_name:'a',allocation_uid:'12345678-1234-1234-1234-123456789abc'};
test('durable assignments route the whole database family; pending and replaced identities block',async()=>{
 const pool=r=>({query:async()=>({rows:[r]})});
 assert.equal((await records(policy,['app_probe_staging_7'],false,pool(row)))[0].targetId,'a');
 await assert.rejects(records(policy,['app_probe'],false,pool({...row,phase:'Waiting'})),/incomplete/);
 assert.deepEqual(await records(policy,['app_unrelated'],false,pool(row)),[]);
 assert.throws(()=>record({...row,cluster_uid:'replacement'},policy),/identity changed/);
});
test('provisioning refuses unrelated role/database and missing Ready data without SQL mutation',async()=>{
 for(const rows of [[{oid:1,marker:'someone-else'}],[{oid:1,marker:`sv-allocation:${row.allocation_uid}`}],[]]){
 const writes=[];const admin={query:async(sql)=>{
 if(sql.startsWith('SELECT oid,shobj'))return{rows};
 if(sql.startsWith('SELECT oid,datdba'))return{rows:[]};
 writes.push(sql);return{rows:[]};}};
 await assert.rejects(ensureDatabase(admin,row,'a'.repeat(48),null,{}));assert.deepEqual(writes,[]);
 }
});
test('operator projection copies only verified public CA and credentials, rejecting replaced owners',async()=>{
 const {projectRuntime}=require('../tools/database-pools');let saved;
 const enc=s=>Buffer.from(s).toString('base64');
 const core={readNamespacedSecret:async({name})=>{
 if(name==='social-database-runtime-targets')throw{code:404};
 return {metadata:{ownerReferences:[{kind:'Cluster',uid:'uid-a'}]},data:name.endsWith('-ca')?{'ca.crt':enc('certificate'),'ca.key':enc('private-key')}:{username:enc('postgres'),password:enc('fixture')}};
 },createNamespacedSecret:async({body})=>{saved=body}};
 const store={getCluster:async()=>({metadata:{uid:'uid-a'}})};
 await projectRuntime(core,store,{namespace:'social-platform',runtimeTargets:[policy.runtimeTargets[0]]});
 assert.deepEqual(Object.keys(saved.data).sort(),['a.crt','targets.json']);
 assert.doesNotMatch(JSON.stringify(saved),/private-key/);
 await assert.rejects(projectRuntime(core,{getCluster:async()=>({metadata:{uid:'replacement'}})},{namespace:'social-platform',runtimeTargets:[policy.runtimeTargets[0]]}));
});

test('overlapping app database families block ambiguous routing before any SQL',()=>{
 const routing=require('../src/services/database-routing');let called=false;
 const a={slug:'one',database:'app_one'},b={slug:'one-staging-copy',database:'app_one_staging_copy'};
 assert.throws(()=>routing.runResolved([a,b],new Map(),['app_one_staging_copy'],()=>{called=true}),/blocked/);
 assert.equal(called,false);
});
