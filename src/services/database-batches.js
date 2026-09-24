'use strict';
const crypto=require('node:crypto');
const {choose}=require('./database-allocation');
const {inventory:poolInventory}=require('./database-pools');
const {loadPolicy}=require('./database-control-plane');
const {getPool}=require('../db/pool');
const ID=/^sv-batch-\d{8}-[a-f0-9]{8}$/;
const ACTIVE=['Pending','Running','NeedsAttention'];
const error=(message,status=409)=>Object.assign(new Error(message),{status});
const hash=p=>crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
const newId=prefix=>prefix+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomBytes(4).toString('hex');
function distribution(policy,apps,observations,reservations,targets){
 const ids=new Set(apps.map(a=>a.appId));
 const held=reservations.filter(r=>!ids.has(Number(r.app_id)) && !apps.some(a=>a.name===r.binding));
 const allowed=observations.filter(o=>targets.includes(o.id));
 const moves=[],kept=[];
 for(const app of [...apps].sort((a,b)=>b.bytes-a.bytes || a.appId-b.appId)){
  if(app.phase!=='Ready' || !Number.isFinite(app.bytes) || app.bytes<0 || app.bytes>256*1024*1024)throw error('App is not ready or exceeds the staging copy budget');
  const prior=reservations.find(r=>Number(r.app_id)===app.appId || r.binding===app.name);
  const demand={...policy.placement.starter,...prior?.demand};demand.storage=Math.max(demand.storage,Math.ceil(app.bytes*1.5));
  const selected=choose({...policy,placement:{...policy.placement,starter:demand}},allowed,held);
  if(!selected)throw error('Selected pools do not have enough fresh, reserved capacity');
  held.push({target_id:selected.id,demand});
  (selected.id===app.current.targetId?kept:moves).push({app,target:selected.id,demand});
 }
 return{moves,kept};
}
function createBatches({execute,executeBulk,store,getPolicy=loadPolicy,pool=getPool({databaseUrl:process.env.DATABASE_URL}),observe}){
 const observations=async p=>observe?observe(p):poolInventory(p,{getCluster:store.cluster});
 const reservations=async client=>(await client.query(`SELECT app_id,NULL::text binding,target_id,demand FROM app_database_allocations WHERE target_id IS NOT NULL
 UNION ALL SELECT NULL::integer app_id,binding,target_id,demand FROM app_database_legacy_reservations`)).rows;
 const get=async id=>(await pool.query('SELECT * FROM app_database_batches WHERE id=$1',[id])).rows[0];
 async function inventory(){
  const p=getPolicy();if(!p?.bulk?.enabled)return{enabled:false,batches:[]};
  let apps=[], inventoryError=null;
  try{apps=await executeBulk('inventory');}catch{inventoryError='Live app inventory unavailable; recorded batch recovery remains available';}
  return{enabled:true,apps,inventoryError,targets:p.pools.filter(r=>r.acceptingNewApps).map(r=>({id:r.id,displayName:p.targets.find(t=>t.id===r.id)?.displayName||r.id})),
   batches:(await pool.query(`SELECT id,phase,attempt,requested_by,created_at,plan,progress FROM app_database_batches ORDER BY (phase IN ('Pending','Running','NeedsAttention')) DESC,created_at DESC LIMIT 20`)).rows};
 }
 async function plan(body,userId){
  const p=getPolicy();if(!p.bulk?.enabled)throw error('Bulk migrations disabled',503);
  if(!body || Object.keys(body).some(k=>!['apps','targets'].includes(k)) || !Array.isArray(body.apps)||!Array.isArray(body.targets)
    || !body.apps.length || body.apps.length>20 || !body.targets.length || body.targets.length>32
    || new Set(body.apps).size!==body.apps.length || new Set(body.targets).size!==body.targets.length
    || body.targets.some(id=>!p.pools.some(t=>t.id===id&&t.acceptingNewApps)))throw error('Select apps and approved shared pools',400);
  const available=await executeBulk('inventory'),apps=available.filter(a=>body.apps.includes(a.name));
  if(apps.length!==body.apps.length)throw error('App is outside the selected staging cohort',400);
  const assignment=distribution(p,apps,await observations(p),await reservations(pool),body.targets);
  if(!assignment.moves.length)throw error('Selected apps already fit the proposed distribution');
  const moves=[];
  for(const move of assignment.moves){
   const operation=newId('sv-move-');
   const detail=await execute('plan',{id:operation,binding:move.app.name,target:move.target});
   moves.push({...detail,reservedBytes:move.demand.storage,reservedDemand:move.demand});
  }
  const frozen={moves,kept:assignment.kept.map(k=>({slug:k.app.slug,target:k.target})),targets:body.targets,
    platform:{uid:moves[0].platformUid,replicas:moves[0].platformReplicas},
    downtime:'The staging platform pauses once. Apps move sequentially; verified sources are deleted. Completed moves are preserved on failure.'};
  const id=newId('sv-batch-');
  await pool.query("INSERT INTO app_database_batches(id,batch_uid,phase,requested_by,plan,policy_hash) VALUES($1,$2,'Planned',$3,$4,$5)",[id,crypto.randomUUID(),userId,frozen,hash(p)]);
  return{id,...frozen};
 }
 async function start(id,body,userId){
  if(!ID.test(id)||body?.confirmation!==id||Object.keys(body).some(k=>k!=='confirmation'))throw error('Type the batch ID to confirm downtime and source deletion',400);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(741923)');
   const b=(await client.query('SELECT * FROM app_database_batches WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!b||Number(b.requested_by)!==Number(userId))throw error('Reviewed batch not found for this administrator',404);
   if(b.phase!=='Planned'){await client.query('COMMIT');return b;}
   if((await client.query("SELECT 1 FROM app_database_batches WHERE phase=ANY($1)",[ACTIVE])).rowCount || (await store.list()).some(o=>['Pending','Running','NeedsAttention'].includes(o.status?.phase||'Pending')))throw error('Finish the active migration first');
   const p=getPolicy();if(hash(p)!==b.policy_hash)throw error('Pool policy changed; generate a new plan');
   const observed=await observations(p),held=await reservations(client),available=await executeBulk('inventory');
   for(const move of b.plan.moves){
    const app=available.find(a=>a.name===move.binding);
    if(!app || app.phase!=='Ready'||app.current.revision!==move.from.revision || app.current.targetId!==move.from.targetId)throw error('App placement changed; generate a new plan');
    const index=held.findIndex(r=>Number(r.app_id)===move.appId || r.binding===move.binding);if(index>=0)held.splice(index,1);
    const fits=choose({...p,placement:{...p.placement,starter:move.reservedDemand}},observed.filter(o=>o.id===move.to.targetId),held);
    if(!fits)throw error('Reviewed target no longer has capacity');
    held.push({target_id:move.to.targetId,demand:move.reservedDemand});
   }
   const result=(await client.query("UPDATE app_database_batches SET phase='Pending',attempt=1 WHERE id=$1 RETURNING *",[id])).rows[0];
   await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 async function action(id,body){
  if(!ID.test(id)||!body||!['resume','cancel'].includes(body.action)||!Number.isInteger(body.attempt)||Object.keys(body).some(k=>!['action','attempt'].includes(k)))throw error('Invalid batch action',400);
  const r=await pool.query("UPDATE app_database_batches SET phase='Pending',command=$2,attempt=attempt+1 WHERE id=$1 AND phase='NeedsAttention' AND attempt=$3 RETURNING *",[id,body.action,body.attempt]);
  if(!r.rowCount)throw error('Batch changed; refresh before recovery');return r.rows[0];
 }
 async function tick(){
  const b=(await pool.query("SELECT * FROM app_database_batches WHERE phase IN ('Pending','Running') ORDER BY created_at LIMIT 1")).rows[0];
  if(!b)return;
  if(b.phase==='Running'){await pool.query("UPDATE app_database_batches SET phase='NeedsAttention',progress=progress || '{\"stage\":\"Executor restarted; inspect and resume or cancel\"}'::jsonb WHERE id=$1 AND phase='Running'",[b.id]);return;}
  const claim=await pool.query("UPDATE app_database_batches SET phase='Running' WHERE id=$1 AND phase='Pending' AND attempt=$2 RETURNING id",[b.id,b.attempt]);if(!claim.rowCount)return;
  try{await executeBulk(b.command,{id:b.id});}
  catch{await pool.query("UPDATE app_database_batches SET phase='NeedsAttention',progress=progress || '{\"stage\":\"Stopped; inspect child checkpoint and resume or cancel\"}'::jsonb WHERE id=$1 AND phase='Running'",[b.id]);}
 }
 return{inventory,plan,start,action,tick,get,active:async()=>!!(await pool.query('SELECT 1 FROM app_database_batches WHERE phase=ANY($1) LIMIT 1',[ACTIVE])).rowCount};
}
module.exports={createBatches,distribution};
