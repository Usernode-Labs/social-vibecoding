'use strict';

const { getPool } = require('../db/pool');
const kubernetes = require('./kubernetes');
const { BUILD_RETENTION_LOCK } = require('./advisory-locks');
const log = require('./logger');

const INTERVAL_MS = 60 * 60 * 1000;
const MAX_DELETIONS = 20;
const REFERENCES_SQL = `SELECT build_ref AS ref FROM apps WHERE build_ref IS NOT NULL
  UNION SELECT staging_build_ref AS ref FROM chat_sessions WHERE staging_build_ref IS NOT NULL`;

function retentionHours(config) {
  const hours = Number(config.kubernetes.successfulBuildRetentionHours ?? 48);
  if (!Number.isFinite(hours) || hours < 1) throw new Error('KPACK_SUCCESS_RETENTION_HOURS must be at least 1');
  return hours;
}

function candidate(build, namespace, cutoff) {
  const meta = build?.metadata;
  const condition = build?.status?.conditions?.find((item) => item.type === 'Succeeded');
  const finished = Date.parse(condition?.lastTransitionTime);
  // kpack has no completionTime: the Succeeded condition's transition is the
  // completion timestamp. Never substitute creation time for an unknown age.
  if (!meta?.name || !meta.uid || !meta.resourceVersion || meta.namespace !== namespace
    || meta.deletionTimestamp || meta.ownerReferences?.length
    || meta.labels?.['app.kubernetes.io/managed-by'] !== 'social-vibecoding-runtime'
    || !/^[1-9][0-9]*$/.test(meta.labels?.['social.usernode.io/app-id'] || '')
    || condition?.status !== 'True' || !Number.isFinite(finished) || finished > cutoff) return null;
  return { ref: `${namespace}/${meta.name}`, finished, build };
}

async function references(pool) {
  const result = await pool.query(REFERENCES_SQL);
  if (!Array.isArray(result?.rows)) throw new Error('Invalid Build reference inventory');
  return new Set(result.rows.map((row) => row.ref));
}

async function sweep(config, { dryRun = true, now = Date.now(), pool = null, runtime = kubernetes,
  shouldStop = () => false } = {}) {
  const result = { dryRun, examined: 0, candidates: [], deleted: [], busy: false };
  if ((config?.appRuntime || process.env.APP_RUNTIME || 'docker') !== 'kubernetes') return result;
  const cutoff = now - retentionHours(config) * 60 * 60 * 1000;
  const namespace = config.kubernetes.buildNamespace;
  pool ||= getPool(config);
  // Complete both inventories before any destructive action. A partial list,
  // missing schema or lost database connection must never mean "unreferenced".
  const builds = await runtime.listManagedBuilds(config);
  const refs = await references(pool);
  result.examined = builds.length;
  const candidates = builds.map((build) => candidate(build, namespace, cutoff))
    .filter((entry) => entry && !refs.has(entry.ref)).sort((a, b) => a.finished - b.finished);
  if (dryRun) {
    result.candidates = candidates.slice(0, MAX_DELETIONS).map((entry) => entry.ref);
    return result;
  }
  if (!candidates.length) return result;

  const client = await pool.connect();
  let locked = false;
  let releaseError;
  try {
    let attempts = 0;
    for (const entry of candidates) {
      if (attempts >= MAX_DELETIONS || shouldStop()) break;
      // Do not wait on active deployments, including on another platform
      // instance. Between candidates new deployments may acquire their lock.
      const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [BUILD_RETENTION_LOCK, 0]);
      if (lock.rows[0]?.acquired !== true) { result.busy = true; break; }
      locked = true;
      try {
        const current = await runtime.readBuild(config, entry.build.metadata.name);
        const fresh = candidate(current, namespace, cutoff);
        if (!fresh || current.metadata.uid !== entry.build.metadata.uid
          || current.metadata.resourceVersion !== entry.build.metadata.resourceVersion) continue;
        // Re-read both kinds of references while holding the deployment lock.
        if ((await references(client)).has(fresh.ref)) continue;
        result.candidates.push(fresh.ref);
        attempts++;
        await runtime.deleteBuildSnapshot(config, current);
        result.deleted.push(fresh.ref);
        log.info('build-retention', 'Deleted expired successful kpack Build', { buildRef: fresh.ref });
      } catch (err) {
        const status = err?.code || err?.response?.statusCode || err?.response?.status;
        if (status !== 404 && status !== 409) throw err;
        // Already gone or changed since the read: leave the replacement alone.
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [BUILD_RETENTION_LOCK, 0]);
        locked = false;
      }
    }
    return result;
  } catch (err) {
    releaseError = err;
    throw err;
  } finally {
    // Destroy on query/unlock errors so a session lock cannot leak into the pool.
    client.release(locked ? releaseError || new Error('Build retention lock not released') : releaseError);
  }
}

let timer = null;
let inFlight = null;
function start(config) {
  if (timer || (config?.appRuntime || process.env.APP_RUNTIME || 'docker') !== 'kubernetes') return;
  try { retentionHours(config); } catch (err) {
    log.warn('build-retention', 'kpack retention disabled: invalid configuration', { err: err.message });
    return;
  }
  const run = (dryRun) => {
    if (inFlight) return;
    inFlight = sweep(config, { dryRun, shouldStop: () => timer === null })
      .then((result) => log.info('build-retention', dryRun ? 'kpack retention preview' : 'kpack retention sweep', result))
      .catch((err) => log.warn('build-retention', 'kpack retention sweep stopped', { err: err.message }))
      .finally(() => { inFlight = null; });
  };
  run(true);
  timer = setInterval(() => run(false), INTERVAL_MS);
  timer.unref();
}

async function stop() {
  clearInterval(timer);
  timer = null;
  await inFlight;
}

module.exports = { sweep, start, stop };
