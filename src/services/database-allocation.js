'use strict';
// Platform SQL is the authority for initial shared-pool assignments. Reservations
// survive failures and are never automatically released or reassigned.
const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const { loadPolicy, createStore } = require('./database-control-plane');
const pools = require('./database-pools');
const LOCK = 741923;
const context = new (require('node:async_hooks').AsyncLocalStorage)();
function blocked(message = 'Database capacity unavailable; retry after an operator reviews the pools') {
  return Object.assign(new Error(message), { code: 'DATABASE_CAPACITY_BLOCKED' });
}
function platformPool() { return getPool({ databaseUrl: process.env.DATABASE_URL }); }
function validate(policy) {
  const p = policy?.placement;
  if (!p?.registry) return;
  if (typeof p.enabled !== 'boolean' || !policy.operatorManaged || !policy.capacity?.prometheusUrl
    || !Number.isSafeInteger(p.newAppsAfterId) || p.newAppsAfterId < 0
    || !['cpu', 'memory', 'storage'].every(k => Number.isFinite(p.starter?.[k]) && p.starter[k] > 0)
    || !(p.admissionRatio > 0 && p.admissionRatio <= policy.capacity.stopRatio)) throw blocked('Invalid placement policy');
  for (const r of policy.pools.filter(p => p.acceptingNewApps)) {
    const t = policy.targets.find(t => t.id === r.id);
    if (!policy.runtimeTargets?.some(x => x.id === r.id && x.uid === r.uid && x.namespace === t.namespace && x.clusterName === t.clusterName)) throw blocked('Pool runtime registration missing');
  }
}
function choose(policy, observations, reservations, now = Date.now()) {
  validate(policy);
  const candidates = observations.flatMap(o => {
    const c = o.capacity, age = now - Date.parse(c.observedAt);
    if (!o.acceptingNewApps || o.phase !== 'Ready' || !['available', 'warning'].includes(c.state)
      || !Number.isFinite(age) || age > policy.capacity.maxSampleAgeSeconds * 1000 || age < -10000) return [];
    const budget = { cpu: c.cpuBudgetCores, memory: c.memoryBudgetBytes, storage: c.storageCapacityBytes };
    const reserved = reservations.filter(r => r.target_id === o.id).reduce((sum,r) => {
      for (const k of Object.keys(sum)) sum[k] += Number(r.demand[k]); return sum;
    }, {cpu:0,memory:0,storage:0});
    const projected = Object.fromEntries(Object.keys(budget).map(k => [k,
      c.ratios[k] + (reserved[k] + policy.placement.starter[k]) / budget[k]]));
    if (!Object.values(projected).every(v => Number.isFinite(v) && v >= 0 && v < policy.placement.admissionRatio)) return [];
    return [{ id:o.id, projected, score:Math.max(...Object.values(projected)) }];
  });
  return candidates.sort((a,b) => a.score-b.score || a.id.localeCompare(b.id))[0] || null;
}
function record(row, policy) {
  const t = policy.runtimeTargets?.find(t => t.id === row.target_id);
  if (!t || t.uid !== row.cluster_uid || t.namespace !== row.cluster_namespace || t.clusterName !== row.cluster_name) throw blocked('Database pool identity changed; operator recovery required');
  return { name:`allocation-${row.app_id}`, appId:Number(row.app_id), slug:row.slug, database:row.database_name,
    owner:`${row.database_name}_owner`, placement:'external', targetId:row.target_id, revision:0,
    clusterRef:{namespace:t.namespace,name:t.clusterName,uid:t.uid},
    endpoint:{host:`${t.clusterName}-rw.${t.namespace}.svc.cluster.local`,port:5432} };
}
async function records(policy, names, all, pool = context.getStore() || platformPool()) {
  if (!policy?.placement?.registry) return [];
  // Include pending records: routing MUST block instead of falling back to central.
  const rows = (await pool.query('SELECT * FROM app_database_allocations')).rows;
  const owns = require('./database-placement').ownsDatabase;
  return rows.filter(r => (all ? r.phase === 'Ready' : names.some(n => owns({slug:r.slug,database:r.database_name},n)))).map(r => {
    if (r.phase !== 'Ready') throw blocked('App database provisioning is incomplete; retry creation');
    return record(r,policy);
  });
}
function store() {
  const k8s = require('@kubernetes/client-node'); const kc = new k8s.KubeConfig(); kc.loadFromCluster();
  return createStore(kc.makeApiClient(k8s.CustomObjectsApi));
}
async function reserve(client, app, policy, observe, sourceDatabase = null) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);
    const current = (await client.query('SELECT * FROM apps WHERE id=$1 FOR UPDATE',[app.id])).rows[0];
    if (!current || current.self_hosted || current.slug !== app.slug) throw blocked('App identity changed');
    let row = (await client.query('SELECT * FROM app_database_allocations WHERE app_id=$1',[app.id])).rows[0];
    if (row && row.source_database !== sourceDatabase) throw blocked('App database creation intent changed');
    if (row?.target_id) { record(row,policy); await client.query('COMMIT'); return row; }
    // Existing applications are registered/migrated separately, never adopted here.
    if (current.db_password || app.id <= policy.placement.newAppsAfterId) {
      await client.query('COMMIT'); return null;
    }
    if (!row) row = (await client.query(`INSERT INTO app_database_allocations
      (app_id,slug,database_name,allocation_uid,phase,demand,source_database) VALUES ($1,$2,$3,$4,'Waiting',$5,$6) RETURNING *`,
      [app.id,app.slug,`app_${app.slug.replace(/-/g,'_')}`,crypto.randomUUID(),policy.placement.starter,sourceDatabase])).rows[0];
    if (!policy.placement.enabled) { await client.query('COMMIT'); throw blocked('New-app database placement is paused'); }
    const reservations = (await client.query('SELECT target_id,demand FROM app_database_allocations WHERE target_id IS NOT NULL')).rows;
    const selected = choose({ ...policy, placement: { ...policy.placement, starter: row.demand } },await observe(),reservations);
    if (!selected) { await client.query('COMMIT'); throw blocked(); }
    const t = policy.runtimeTargets.find(t => t.id === selected.id);
    row = (await client.query(`UPDATE app_database_allocations SET target_id=$2,cluster_uid=$3,
      cluster_namespace=$4,cluster_name=$5,phase='Reserved',decision=$6 WHERE app_id=$1 RETURNING *`,
      [app.id,t.id,t.uid,t.namespace,t.clusterName,selected])).rows[0];
    // Credential must be durable before any remote SQL side effect.
    await client.query('UPDATE apps SET db_password=$2 WHERE id=$1',[app.id,crypto.randomBytes(24).toString('hex')]);
    await client.query('COMMIT'); return row;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
async function provision(config, app, { sourceDatabase, policy = loadPolicy(), pool = getPool(config),
  getStore = store, observe, connectAdmin, copy } = {}) {
  if (!policy?.placement?.registry) return null;
  validate(policy);
  if (!Number.isSafeInteger(app.id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app.slug) || app.slug.length > 53) throw blocked('Invalid app database identity');
  const client = await pool.connect();
  return context.run(client, async () => {
  let locked = false;
  try {
    // Serialize retries for the same app across web processes, including remote SQL.
    await client.query('SELECT pg_advisory_lock($1,$2)',[LOCK,app.id]); locked = true;
    const api = getStore();
    const row = await reserve(client,app,policy,observe || (() => pools.inventory(policy,api)),sourceDatabase || null);
    if (!row) return null;
    const binding = record(row,policy);
    const cluster = await api.getCluster(binding.clusterRef.namespace,binding.clusterRef.name);
    if (cluster?.metadata?.uid !== row.cluster_uid || cluster.metadata.deletionTimestamp
      || !cluster.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) throw blocked('Assigned database pool is unavailable');
    const password = (await client.query('SELECT db_password FROM apps WHERE id=$1',[app.id])).rows[0]?.db_password;
    if (!/^[a-f0-9]{48}$/.test(password || '')) throw blocked('Assigned database credential is missing');
    const routing = require('./database-routing');
    const urls = routing.credentials([binding]);
    const admin = connectAdmin ? await connectAdmin(urls.get(binding.targetId)) : new (require('pg').Client)({connectionString:urls.get(binding.targetId)});
    if (!connectAdmin) await admin.connect();
    try {
      await ensureDatabase(admin,row,password,sourceDatabase,client);
      if (row.phase !== 'Ready' && sourceDatabase) {
        const sourceRecords = await require('./database-placement').resolvePlacements([sourceDatabase]);
        const combined = [...sourceRecords,binding];
        await routing.runResolved(combined,routing.credentials(combined),[sourceDatabase,binding.database],
          () => (copy || require('./db-manager').copyAllocatedDatabase)(sourceDatabase,binding.database));
      }
      await client.query("UPDATE app_database_allocations SET phase='Ready' WHERE app_id=$1",[app.id]);
    } finally { await admin.end(); }
    return { password };
  } catch (e) {
    if (e.code === 'DATABASE_CAPACITY_BLOCKED') throw e;
    throw blocked('Database provisioning paused; retry creation or ask an operator to inspect the assignment');
  } finally {
    // Discard the session if unlock fails; never leak a session lock to the pool.
    let broken=false;
    if (locked) try { await client.query('SELECT pg_advisory_unlock($1,$2)',[LOCK,app.id]); } catch { broken=true; }
    client.release(broken);
  }
  });
}
async function ensureDatabase(admin,row,password,source,client) {
  const db=row.database_name, role=`${db}_owner`, marker=`sv-allocation:${row.allocation_uid}`;
  if (!/^[a-z_][a-z0-9_]{0,56}$/.test(db) || !/^[a-f0-9-]{36}$/.test(row.allocation_uid)) throw blocked('Invalid database identity');
  let r=(await admin.query("SELECT oid,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",[role])).rows[0];
  let d=(await admin.query('SELECT oid,datdba FROM pg_database WHERE datname=$1',[db])).rows[0];
  if ((!r && d) || (r && r.marker!==marker) || (d && Number(d.datdba)!==Number(r?.oid))) throw blocked('Conflicting existing database or role; operator recovery required');
  if (row.phase==='Ready') {
    if (!r || !d) throw blocked('Assigned database is missing; restore required');
    return;
  }
  if (!r) {
    await admin.query('BEGIN');
    try {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await admin.query(`COMMENT ON ROLE "${role}" IS '${marker}'`);
      await admin.query('COMMIT');
    } catch(e) { await admin.query('ROLLBACK');throw e; }
  }
  if (source && d) {
    // Only unpublished, operation-owned fork copies may be reset. No FORCE and
    // no public routing until the full copy and privacy scrub have succeeded.
    await admin.query(`DROP DATABASE "${db}"`); d=null;
  }
  if (!d) await admin.query(`CREATE DATABASE "${db}" TEMPLATE template0 OWNER "${role}"`);
  await admin.query(`REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC`);
  await client.query("UPDATE app_database_allocations SET phase='Provisioning' WHERE app_id=$1",[row.app_id]);
}
async function summary(policy, observations, pool = platformPool()) {
  if (!policy?.placement?.registry) return { enabled:false, allocations:[] };
  const rows=(await pool.query('SELECT app_id,slug,phase,target_id,demand FROM app_database_allocations ORDER BY app_id')).rows;
  return { enabled:policy.placement.enabled, allocations:rows,
    canPlace:!!choose(policy,observations,rows), starter:policy.placement.starter };
}
module.exports={summary,validate,choose,record,records,reserve,provision,ensureDatabase};
