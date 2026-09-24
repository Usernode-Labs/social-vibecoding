const assert=require('node:assert/strict');const {Pool,Client}=require(process.cwd()+'/node_modules/pg');
const a=require(process.cwd()+'/src/services/database-allocation');const routing=require(process.cwd()+'/src/services/database-routing');
const test=require('node:test');
const url=process.env.TEST_DATABASE_ALLOCATION_URL;
test('PostgreSQL allocation concurrency, durable retries, interrupted copies and lost data', {skip:!url}, async()=>{
assert.equal(new URL(url).hostname,'127.0.0.1');assert.equal(new URL(url).pathname,'/sv_allocation_test');
const pool=new Pool({connectionString:url,max:12});
const p={operatorManaged:true,capacity:{prometheusUrl:'http://p.monitoring.svc.cluster.local',stopRatio:.9,maxSampleAgeSeconds:180},placement:{registry:true,enabled:true,newAppsAfterId:4,admissionRatio:.8,starter:{cpu:.1,memory:100,storage:100}},targets:['a','b'].map(id=>({id,namespace:`sv-db-${id}`,clusterName:id})),runtimeTargets:['a','b'].map(id=>({id,uid:`uid-${id}`,namespace:`sv-db-${id}`,clusterName:id})),pools:['a','b'].map(id=>({id,uid:`uid-${id}`,acceptingNewApps:true}))};
const obs=()=>p.pools.map(r=>({id:r.id,phase:'Ready',acceptingNewApps:true,capacity:{state:'available',observedAt:new Date().toISOString(),ratios:{cpu:0,memory:0,storage:0},cpuBudgetCores:1,memoryBudgetBytes:1000,storageCapacityBytes:1000}}));
const api={getCluster:async(_,name)=>({metadata:{uid:`uid-${name}`},status:{conditions:[{type:'Ready',status:'True'}]}})};
const orig=routing.credentials;routing.credentials=records=>new Map(records.map(r=>[r.targetId,url]));
const options={policy:p,pool,getStore:()=>api,observe:async()=>obs(),connectAdmin:async()=>{const c=new Client({connectionString:url});await c.connect();return c;}};
try {
 await pool.query('CREATE TABLE apps(id integer PRIMARY KEY,slug text,self_hosted boolean DEFAULT false,db_password text)');
 const schema=require('fs').readFileSync('src/db/schema.sql','utf8').split('-- Durable initial placement intent.')[1];await pool.query('-- Durable initial placement intent.'+schema);
 await pool.query("INSERT INTO apps(id,slug) SELECT i,'allocation-probe-'||i FROM generate_series(5,22) i");
 const apps=Array.from({length:18},(_,i)=>({id:i+5,slug:`allocation-probe-${i+5}`}));
 const results=await Promise.allSettled(apps.map(app=>a.provision({},app,options)));
 const rows=(await pool.query('SELECT * FROM app_database_allocations ORDER BY app_id')).rows;
 assert.equal(rows.length,18);const ready=rows.filter(r=>r.phase==='Ready'),waiting=rows.filter(r=>r.phase==='Waiting');
 assert.equal(ready.length,14);assert.equal(waiting.length,4);assert.equal(results.filter(r=>r.status==='fulfilled').length,14);
 assert.equal(ready.filter(r=>r.target_id==='a').length,7);assert.equal(ready.filter(r=>r.target_id==='b').length,7);
 console.log('Concurrent reservation: 14 admitted evenly, 4 durably waiting; no oversubscription.');
 const app=apps[0];const before=(await pool.query("SELECT d.oid AS database_oid,r.oid AS role_oid FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname='app_allocation_probe_5'")).rows[0];
 const passwords=await Promise.all([a.provision({},app,options),a.provision({},app,options)]);assert.equal(passwords[0].password,passwords[1].password);
 const after=(await pool.query("SELECT d.oid AS database_oid,r.oid AS role_oid FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname='app_allocation_probe_5'")).rows[0];assert.deepEqual(after,before);
 console.log('Concurrent retries preserve database/role OIDs, assignment and credential.');
 p.placement.starter={cpu:.01,memory:10,storage:10};
 // Increase reviewed capacity, then retry a Waiting record. Existing reservation size must be retained.
 const expanded={...options,observe:async()=>obs().map(o=>({...o,capacity:{...o.capacity,cpuBudgetCores:2,memoryBudgetBytes:2000,storageCapacityBytes:2000}}))};
 await a.provision({},apps[14],expanded);assert.equal((await pool.query('SELECT phase FROM app_database_allocations WHERE app_id=19')).rows[0].phase,'Ready');
 console.log('Waiting app retries after capacity increase.');
 const source='app_allocation_probe_5';await pool.query(`CREATE TABLE public.copy_marker(n int)`);
 await pool.query("INSERT INTO apps(id,slug) VALUES(23,'allocation-probe-23')");const fork={id:23,slug:'allocation-probe-23'};let attempts=0;
 const forkOptions={...expanded,sourceDatabase:source,copy:async()=>{attempts++;if(attempts===1)throw Error('interrupted copy');}};
 await assert.rejects(a.provision({},fork,forkOptions));const interrupted=(await pool.query('SELECT * FROM app_database_allocations WHERE app_id=23')).rows[0];assert.equal(interrupted.phase,'Provisioning');
 await a.provision({},fork,forkOptions);assert.equal(attempts,2);
 const completed=(await pool.query('SELECT * FROM app_database_allocations WHERE app_id=23')).rows[0];assert.equal(completed.target_id,interrupted.target_id);assert.equal(completed.allocation_uid,interrupted.allocation_uid);assert.equal(completed.phase,'Ready');
 console.log('Interrupted unpublished fork retries on the same reservation.');
 await pool.query('DROP DATABASE app_allocation_probe_5');await assert.rejects(a.provision({},app,options),/restore required/);
 assert.equal((await pool.query("SELECT count(*) FROM pg_database WHERE datname='app_allocation_probe_5'")).rows[0].count,'0');
 console.log('Missing Ready database blocks; no empty recreation.');
} finally {routing.credentials=orig;await pool.end();}
});
