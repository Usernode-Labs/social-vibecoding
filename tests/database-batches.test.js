'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {distribution,createBatches}=require('../src/services/database-batches');
const policy={bulk:{enabled:true},capacity:{maxSampleAgeSeconds:180},placement:{admissionRatio:.8,starter:{cpu:.025,memory:64,storage:512}},targets:[{id:'a'},{id:'b'}],pools:[{id:'a',acceptingNewApps:true},{id:'b',acceptingNewApps:true}]};
const observations=()=>['a','b'].map(id=>({id,phase:'Ready',acceptingNewApps:true,capacity:{state:'available',observedAt:new Date().toISOString(),ratios:{cpu:.1,memory:.1,storage:.1},cpuBudgetCores:.5,memoryBudgetBytes:1024,storageCapacityBytes:10240}}));
const apps=[1,2].map(appId=>({appId,name:`allocation-${appId}`,slug:`app-${appId}`,phase:'Ready',bytes:100,current:{targetId:'a',revision:0}}));
test('distribution accounts for the whole selected cohort, balances reservations and preserves existing fits',()=>{
 const result=distribution(policy,apps,observations(),apps.map(a=>({app_id:a.appId,target_id:'a',demand:policy.placement.starter})),['a','b']);
 assert.equal(result.kept.length,1);assert.equal(result.moves.length,1);assert.equal(result.moves[0].target,'b');
 assert.equal(result.moves[0].app.appId,2);
 assert.deepEqual(distribution(policy,apps,observations(),[],['b']).moves.map(m=>m.target),['b','b']);
});
test('unknown capacity, unready apps and oversized copies reject planning',()=>{
 for(const patch of [{phase:'Moving'},{bytes:256*1024*1024+1}])assert.throws(()=>distribution(policy,[{...apps[0],...patch}],observations(),[],['b']));
 assert.throws(()=>distribution(policy,apps,[],[],['a']),/capacity/);
});
function fixture(phase='Pending'){
 const row={id:'sv-batch-20260924-abcd1234',phase,attempt:1,command:'resume',plan:{moves:[]},progress:{}};const calls=[];
 const pool={query:async(sql,args=[])=>{
 calls.push(sql);
 if(sql.startsWith('SELECT'))return{rows:[row],rowCount:1};
 if(sql.includes("phase='NeedsAttention'")){row.phase='NeedsAttention';return{rows:[],rowCount:1};}
 if(sql.includes("phase='Running'")){if(row.phase!=='Pending'||args[1]!==row.attempt)return{rows:[],rowCount:0};row.phase='Running';return{rows:[row],rowCount:1};}
 throw Error('Unexpected SQL');
 }};
 const executed=[];const executeBulk=async(command,args)=>{executed.push({command,args});if(command==='inventory')throw Error('sensitive diagnostic');};
 return{row,calls,executed,service:createBatches({getPolicy:()=>policy,pool,executeBulk,store:{},execute:()=>{}})};
}
test('executor restart needs explicit recovery and never replays a running batch',async()=>{
 const f=fixture('Running');await f.service.tick();assert.equal(f.row.phase,'NeedsAttention');assert.equal(f.executed.length,0);
});
test('durable pending work is claimed before invoking the frozen batch',async()=>{
 const f=fixture();await f.service.tick();assert.equal(f.row.phase,'Running');assert.deepEqual(f.executed,[{command:'resume',args:{id:f.row.id}}]);
});
test('failed inventory preserves recorded recovery and redacts diagnostics',async()=>{
 const f=fixture('NeedsAttention');const result=await f.service.inventory();assert.equal(result.batches[0].id,f.row.id);assert.equal(result.apps.length,0);assert.match(result.inventoryError,/recovery remains/);assert.doesNotMatch(JSON.stringify(result),/sensitive/);
});
test('invalid confirmations and stale recovery attempts cannot queue work',async()=>{
 const f=fixture();await assert.rejects(f.service.start(f.row.id,{confirmation:'no'},1),/confirm/);assert.equal(f.calls.length,0);
 await assert.rejects(f.service.action(f.row.id,{action:'resume',attempt:1,force:true}),/Invalid/);assert.equal(f.calls.length,0);
});
test('bulk mutation routes retain exact-origin and full-admin enforcement',async t=>{
 const express=require('express');const {adminMiddleware}=require('../src/middleware/admin');const {registerMigrationRoutes}=require('../src/routes/admin-database-migrations');let writes=0;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:1,isAdmin:true,canAdminWrite:req.get('x-write')==='yes'};next();});app.use(adminMiddleware);
 registerMigrationRoutes(app,{}, {origin:'https://staging.example',batches:{plan:async()=>{writes++;return{};},inventory:async()=>({enabled:true})}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/api/admin/database-migrations/batches/plan`;
 for(const headers of [{'x-write':'yes',origin:'https://other.example'},{origin:'https://staging.example'}])assert.equal((await fetch(url,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal(writes,0);
 assert.equal((await fetch(url,{method:'POST',headers:{'x-write':'yes',origin:'https://staging.example','content-type':'application/json'},body:'{}'})).status,200);assert.equal(writes,1);
});
