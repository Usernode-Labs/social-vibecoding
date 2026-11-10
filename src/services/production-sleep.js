'use strict';

// Ordinary production apps sleep by default after fourteen idle days.
// Only documented exceptions stay awake. Missing activity keeps an app running. The web
// process records access and asks app delivery to wake; only conductor work
// changes Kubernetes. Two app.wake work slots bound wakes across replicas.
const log = require('./logger');
const { isHealth } = require('./gateway-activity');
const { APP_SLEEP_LOCK } = require('./advisory-locks');
const ANNOTATION = 'social.usernode.io/production-asleep-at';

function policy(config = null) {
  let excluded = config?.appSleepExcludedApps ?? process.env.APP_SLEEP_EXCLUDED_APPS ?? {};
  if (typeof excluded === 'string') {
    try { excluded = JSON.parse(excluded); }
    catch { throw new Error('APP_SLEEP_EXCLUDED_APPS must be a JSON object'); }
  }
  if (!excluded || Array.isArray(excluded) || typeof excluded !== 'object'
    || Object.entries(excluded).some(([id, reason]) => !/^[1-9]\d*$/.test(id)
      || !Number.isSafeInteger(Number(id)) || typeof reason !== 'string' || !reason.trim())) {
    throw new Error('APP_SLEEP_EXCLUDED_APPS must map positive app IDs to nonempty reasons');
  }
  const afterMs = Number(config?.appSleepAfterMs ?? process.env.APP_SLEEP_AFTER_MS ?? 1209600000);
  if (!Number.isSafeInteger(afterMs) || afterMs < 0) throw new Error('APP_SLEEP_AFTER_MS must be a non-negative integer');
  const supported = (config?.appRuntime ?? process.env.APP_RUNTIME) === 'kubernetes'
    && process.env.USERNODE_ENV !== 'staging' && !process.env.STAGING_SESSION_ID;
  const gate = (config?.kubernetes?.appGate ?? process.env.APP_GATE) === 'on';
  return { excluded, afterMs: gate ? afterMs : 0, supported };
}

function isAsleep(deployment) {
  return deployment?.spec?.replicas === 0 && !!deployment.metadata?.annotations?.[ANNOTATION]
    && deployment.metadata?.labels?.['social.usernode.io/environment'] === 'production';
}

async function requestWake(appId, asleepAt, { deps = {}, now = Date.now() } = {}) {
  const workflow = deps.workflow || require('../workflow/platform.ts');
  await workflow.reportAppWake(appId, `app-wake:${appId}:${new Date(asleepAt).getTime()}:${Math.floor(now / 10000)}`);
}

// Called only after the edge has authorized the actual request. The lock is
// shared with the sleep claim: an access either prevents the claim or sees
// the completed sleep and waits for a wake. Health probes never wake an app.
async function access(pool, appId, uri, { config = null, deps = {}, request = {} } = {}) {
  const p = policy(config);
  if (!p.supported) return { eligible: false, ready: true };
  const health = isHealth(uri, request);
  const locks = deps.locks || require('../db/session-locks');
  let row;
  await locks.withSessionLock(pool, [APP_SLEEP_LOCK, Number(appId)], async () => {
    if (health) {
      ({ rows: [row] } = await pool.query('SELECT asleep_at FROM app_runtime_sleep WHERE app_id = $1', [appId]));
    } else {
      ({ rows: [row] } = await pool.query(
        `INSERT INTO app_runtime_sleep (app_id, last_request_at)
         SELECT id, now() FROM apps WHERE id = $1 AND self_hosted IS NOT TRUE
           AND status = 'running' AND runtime_kind = 'kubernetes'
         ON CONFLICT (app_id) DO UPDATE SET last_request_at = now()
         RETURNING asleep_at`, [appId]));
    }
  });
  if (row?.asleep_at && !health) await requestWake(Number(appId), row.asleep_at, { deps });
  return { eligible: true, ready: !row?.asleep_at, waking: !health };
}

function idleAt(snapshots, runtimeName, now, afterMs) {
  if (!Array.isArray(snapshots) || !snapshots.length) return false;
  return snapshots.every((snapshot) => {
    if (snapshot.version !== 1 || snapshot.overflow || !Number.isFinite(snapshot.now)
      || Math.abs(now - snapshot.now) > 15000 || !snapshot.upstreams || typeof snapshot.upstreams !== 'object') return false;
    const row = snapshot.upstreams[runtimeName];
    return row === undefined || (row.active === 0 && Number.isFinite(row.lastRequestAt)
      && row.lastRequestAt <= now - afterMs);
  });
}

async function sweep(config, pool, { deps = {}, shouldStop = () => false } = {}) {
  const p = policy(config);
  if (!p.supported) return { off: true };
  const kubernetes = deps.kubernetes || require('./kubernetes');
  const locks = deps.locks || require('../db/session-locks');
  // Newly discovered apps get a full observation window, even when their previous
  // runtime was idle. A missing row is never evidence of inactivity.
  if (p.afterMs) await pool.query(
    `INSERT INTO app_runtime_sleep (app_id)
     SELECT id FROM apps WHERE NOT (id = ANY($1::int[])) AND status = 'running'
       AND self_hosted IS NOT TRUE AND runtime_kind = 'kubernetes'
     ON CONFLICT (app_id) DO NOTHING`, [Object.keys(p.excluded).map(Number)]);
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.runtime_name, a.main_sha, a.deploy_state, s.last_request_at, s.asleep_at, s.deployment_uid
       FROM apps a JOIN app_runtime_sleep s ON s.app_id = a.id
      WHERE a.status = 'running' AND a.self_hosted IS NOT TRUE AND a.runtime_kind = 'kubernetes'
      ORDER BY a.id`);
  const summary = { examined: rows.length, asleep: 0, waking: 0, skipped: 0 };
  // Adding an exception or disabling sleep wakes existing sleepers too.
  for (const app of rows.filter((a) => a.asleep_at && (p.excluded[a.id] || p.afterMs === 0)).slice(0, 10)) {
    if (shouldStop()) return summary;
    await requestWake(app.id, app.asleep_at, { deps }); summary.waking += 1;
  }
  if (!p.afterMs) return summary;
  let snapshots;
  try { snapshots = await kubernetes.appGateActivity(config); }
  catch (err) { log.warn('production-sleep', 'Gateway activity unavailable; apps stay awake', { err: err.message }); return { ...summary, telemetryUnavailable: true }; }
  // Check every app: active lower IDs must not starve idle higher IDs.
  // The successful sleep limit below still bounds scale-downs per pass.
  for (const app of rows.filter((a) => !a.asleep_at)) {
    if (shouldStop()) break;
    if (p.excluded[app.id] || !app.runtime_name || app.deploy_state === 'deploying'
      || !app.last_request_at || !(new Date(app.last_request_at).getTime() < Date.now() - p.afterMs)
      || !idleAt(snapshots, app.runtime_name, Date.now(), p.afterMs)) { summary.skipped += 1; continue; }
    const result = await locks.ifSessionLockFree(pool, [APP_SLEEP_LOCK, app.id], async () => {
      const deployment = await kubernetes.readProductionForSleep(config, app);
      if (!deployment) return false;
      const { rows: [claimed] } = await pool.query(
        `UPDATE app_runtime_sleep s SET asleep_at = now(), runtime_name = $2, deployment_uid = $3
          FROM apps a WHERE s.app_id = $1 AND a.id = s.app_id AND s.asleep_at IS NULL
           AND s.last_request_at < now() - make_interval(secs => $4::double precision)
           AND a.runtime_name = $2 AND a.status = 'running' AND a.self_hosted IS NOT TRUE
           AND a.deploy_state IS DISTINCT FROM 'deploying'
           AND a.main_sha IS NOT DISTINCT FROM $5::text
         RETURNING s.asleep_at::text AS asleep_at`, [app.id, app.runtime_name, deployment.metadata.uid, p.afterMs / 1000, app.main_sha]);
      if (!claimed) return false;
      try {
        const outcome = await kubernetes.scaleProductionForSleep(config, deployment, 0, claimed.asleep_at);
        if (outcome === 'scaled') return true;
        if (!['conflict', 'missing'].includes(outcome)) throw new Error('The scale-down outcome was not confirmed');
      } catch (err) {
        // A transport failure is not proof the write failed: Kubernetes may
        // already have accepted replicas=0. Keep the durable claim so access
        // and rollback can still wake it. A wake also fences a delayed sleep
        // write when the provider still reports one replica.
        log.warn('production-sleep', 'Scale-down outcome unknown; retaining wake claim', { appId: app.id, err: err.message });
        try { await requestWake(app.id, claimed.asleep_at, { deps }); }
        catch (wakeErr) {
          log.warn('production-sleep', 'Recovery wake could not be queued; claim retained for access or rollback',
            { appId: app.id, err: wakeErr.message });
        }
        return false;
      }
      // Conflict and not-found are definitive rejections, rather than lost
      // responses to a possibly committed write.
      await pool.query('UPDATE app_runtime_sleep SET asleep_at = NULL WHERE app_id = $1 AND asleep_at = $2',
        [app.id, claimed.asleep_at]);
      return false;
    });
    if (result === true) summary.asleep += 1; else summary.skipped += 1;
    if (summary.asleep >= 5) break;
  }
  log.info('production-sleep', 'Production idle pass finished', summary);
  return summary;
}

// app.wake work, concurrency two globally. The per-app lock coalesces any
// clock or recovery work too; Kubernetes resourceVersion fences a rollout.
async function wake(config, pool, appId, { deps = {}, signal = null } = {}) {
  if (!policy(config).supported) return { status: 'skipped' };
  const kubernetes = deps.kubernetes || require('./kubernetes');
  const locks = deps.locks || require('../db/session-locks');
  const app = await locks.withSessionLock(pool, [APP_SLEEP_LOCK, Number(appId)], async () => {
    signal?.throwIfAborted();
    const { rows: [row] } = await pool.query(
      `SELECT a.id, a.slug, a.runtime_name, s.asleep_at::text AS asleep_at, s.deployment_uid
         FROM apps a JOIN app_runtime_sleep s ON s.app_id = a.id
        WHERE a.id = $1 AND a.status = 'running' AND a.self_hosted IS NOT TRUE`, [appId]);
    if (!row?.asleep_at) return null;
    const deployment = await kubernetes.readProductionForSleep(config, row, { waking: true });
    if (!deployment) throw new Error('The sleeping app runtime is missing or no longer owned');
    const result = await kubernetes.scaleProductionForSleep(config, deployment, 1);
    if (!['scaled', 'unchanged'].includes(result)) throw new Error(`App wake lost to another runtime write: ${result}`);
    signal?.throwIfAborted();
    return row;
  });
  if (!app) return { status: 'healthy' };
  // Requests must still be able to record activity and hear "waking" while
  // the pod starts. Holding the app lock here would exhaust decision timeouts.
  await kubernetes.waitForPreview(config, app.runtime_name, { timeoutMs: 4 * 60 * 1000 });
  signal?.throwIfAborted();
  await locks.withSessionLock(pool, [APP_SLEEP_LOCK, Number(appId)], () => pool.query(
    `UPDATE app_runtime_sleep SET asleep_at = NULL, last_request_at = now()
      WHERE app_id = $1 AND asleep_at = $2`, [appId, app.asleep_at]));
  log.info('production-sleep', 'Production app awake', { appId, runtimeName: app.runtime_name });
  return { status: 'started' };
}

module.exports = { ANNOTATION, policy, isAsleep, access, idleAt, sweep, wake };
