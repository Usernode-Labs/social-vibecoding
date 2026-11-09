'use strict';

// Previews asleep (#6157): a third state between running and torn down.
//
// WHY. Every open proposal keeps a running preview (a Kubernetes Deployment
// `sv-preview-<appId>-s<sessionId>` with one replica, its pod, and its
// database clone with open connections), and a preview backing a live vote
// is exempt from both the idle and the pressure sweep, because a reviewer
// arriving at a dead link is worse than a tight connection budget. Teardown
// was the only way to reclaim one, and it is dear to undo: the image is
// rebuilt and the checks capture runs again. So proposals waiting for votes
// held real resources for as long as they waited.
//
// SLEEP. A preview nobody has used for PREVIEW_SLEEP_AFTER_MS (one hour by
// default: no request to its host that the platform saw, no Preview click,
// no checks, shots or worker turn on its change) is scaled to no replicas
// (staging-reap.js sweepSleep picks them, sleep() below puts one to sleep).
// Its image, its Deployment, Service and Ingress, its database clone and the
// session's records all stay, so there is no dead link: whatever opens it
// wakes it. This includes vote-backed previews, for that reason.
//
// WAKE. Web callers append preview.wake work and wait for its durable
// receipt; only a conductor (or the standalone all role) writes Kubernetes.
// wake() scales it back to one replica and waits for the pod: the
// same image of the same head, no rebuild and no checks run again. Every
// door wakes it:
//   - Preview and Try it (routes/sessions.js ensure-staging, preview-status),
//     behind the "spinning back up" loader, told `staging_awake` when ready;
//   - a direct link: the app-host gate's waking page (routes/app-error.js)
//     with the gate on; with it off, the shared asset backend's
//     (scripts/serve-platform-assets.js), the route a sleeping preview's
//     Ingress takes while it has no pod (kubernetes.routePreviewForSleep).
//     The page asks the platform to wake it (POST /__preview_wake), polls,
//     and reloads once the app answers;
//   - a checks run (the preview machine's checks.run, wakeForRun): a preview
//     that does not wake in time is the platform's fault, never the change's.
// A preview built with another platform environment is rebuilt instead of
// woken, as the stale sweep would have done (staging-recovery
// stagingNeedsRebuild judges a sleeping one by its labels).
//
// What it still costs is its database clone, which the sleep logs the size
// of and the admin console totals (asleepTotals).
//
// Only Kubernetes previews sleep: a Docker preview is the standalone
// deployment's, whose host has no such pressure, and is left as it was.
//
// The machine is not told: a sleeping preview still serves its attempt as
// far as the machine knows, and everything of the machine's that reaches the
// runtime wakes it first (a build writes the Deployment with one replica,
// and the `published` write ends the sleep; a run wakes it). Sleep and wake
// exclude each other through PREVIEW_SLEEP_LOCK, and the sleep's claim reads
// the machine's state under it, so a preview the machine builds or checks,
// or one somebody works on, is never put to sleep.

const log = require('./logger');

const DEFAULT_SLEEP_AFTER_MS = 60 * 60 * 1000;
// How long a wake waits for the pod to serve (its image on the node or
// pulled again, then its probes).
const WAKE_TIMEOUT_MS = 4 * 60 * 1000;
// Then how long it waits for the preview's public address to answer the app
// rather than the waking page (the ingress controller takes its new route).
const EDGE_WAIT_MS = 45 * 1000;
const EDGE_POLL_MS = 2000;
// A preview's opens move its session's last_activity_at at most this often.
const TOUCH_EVERY_MS = 60 * 1000;
// A direct link's wake asked again (the page asks every so often) is not
// asked of the cluster more often than this.
const LINK_WAKE_EVERY_MS = 10 * 1000;

// The preview machine's states in which an attempt serves and the machine
// runs nothing on it (machine.ts SERVES): the only ones a preview sleeps in.
const SLEEP_STATES = new Set(['settled', 'deferred', 'failed']);

// A Homeroom preview host's label: `<slug>--s<sessionId>` (caddy.js
// stagingHostname), as the gate reads it (edge-gate.js upstreamFor).
const PREVIEW_LABEL_RE = /^[a-z0-9-]+?--s(\d+)(?:--[a-z0-9]+)?$/;

// PREVIEW_SLEEP_AFTER_MS (config.previewSleepAfterMs): how long a preview
// may go unused before it sleeps. 0 switches sleep off.
function sleepAfterMs(config = null) {
  const configured = config && config.previewSleepAfterMs != null
    ? Number(config.previewSleepAfterMs)
    : parseInt(process.env.PREVIEW_SLEEP_AFTER_MS || '', 10);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_SLEEP_AFTER_MS;
  return configured;
}

// The Kubernetes calls need the app namespace; the same fallback the reap
// passes use (staging-reap.js kubernetesConfig).
function kubernetesConfig(config) {
  return {
    ...(config || {}),
    appRuntime: 'kubernetes',
    kubernetes: {
      ...(config?.kubernetes || {}),
      appNamespace: config?.kubernetes?.appNamespace || process.env.APP_NAMESPACE || 'social-apps',
    },
  };
}

// Whether the row says its preview is asleep (a wake may be under way).
function isAsleep(session) {
  return !!session && !!session.staging_asleep_at && session.staging_runtime_kind === 'kubernetes';
}

const lockKey = (id) => [require('./advisory-locks').PREVIEW_SLEEP_LOCK, Number(id)];
const sessionLocks = () => require('../db/session-locks');

/**
 * Put one preview to sleep. `candidate` is a row staging-reap selectSleepers
 * chose ({ id, staging_runtime_name, serving: { n, db } }). The row is
 * claimed first, and only while it is still what was chosen: unused past the
 * window, the same runtime, the machine serving that attempt with nothing of
 * its own running, no checks run on the cluster, and nobody working on it
 * (session-work.ts workedOnSql). Then the Deployment is scaled to none,
 * fenced on that attempt; anything but a scale gives the claim back. Never
 * throws for the cluster's answer; resolves { outcome, bytes }.
 */
async function sleep(config, pool, candidate, { afterMs = sleepAfterMs(config), deps = {} } = {}) {
  const kubernetes = deps.kubernetes || require('./kubernetes');
  const dbManager = deps.dbManager || require('./db-manager');
  const id = Number(candidate.id);
  const name = String(candidate.staging_runtime_name || '');
  const n = Number(candidate.serving?.n);
  if (!Number.isSafeInteger(id) || !name || !Number.isInteger(n) || !(afterMs > 0)) return { outcome: 'skipped_invalid' };
  const kube = kubernetesConfig(config);
  const { workedOnSql } = require('../workflow/session-work.ts');
  const { ifSessionLockFree, BUSY } = sessionLocks();
  const out = await ifSessionLockFree(pool, lockKey(id), async () => {
    const { rows: [claimed] } = await pool.query(
      `UPDATE chat_sessions cs SET staging_asleep_at = now(), staging_asleep_db_bytes = NULL
        WHERE cs.id = $1 AND cs.staging_asleep_at IS NULL AND cs.staging_url IS NOT NULL
          AND cs.staging_runtime_kind = 'kubernetes' AND cs.staging_runtime_name = $2
          AND cs.status IN ('active', 'paused', 'promoted', 'merging')
          AND cs.last_activity_at < now() - make_interval(secs => $3::double precision)
          AND NOT EXISTS (SELECT 1 FROM check_runs cr WHERE cr.session_id = cs.id)
          AND EXISTS (SELECT 1 FROM wf_instances w
                       WHERE w.machine = 'preview' AND w.key = 'session:' || cs.id
                         AND w.state IN ('settled', 'deferred', 'failed')
                         AND (w.data->'serving'->>'n')::int = $4
                         AND COALESCE((w.data->'serving'->>'lost')::boolean, FALSE) = FALSE)
          AND NOT ${workedOnSql()}
        RETURNING cs.id`, [id, name, afterMs / 1000, n]);
    if (!claimed) return { outcome: 'skipped_changed' };
    let scaled;
    try {
      scaled = await kubernetes.scalePreview(kube, name, 0, { attempt: n });
    } catch (err) {
      scaled = 'failed';
      log.warn('preview-sleep', 'Could not scale a preview down; it stays awake', { sessionId: id, runtimeName: name, err: err.message });
    }
    if (scaled !== 'scaled' && scaled !== 'unchanged') {
      await pool.query('UPDATE chat_sessions SET staging_asleep_at = NULL WHERE id = $1', [id]);
      return { outcome: scaled === 'failed' ? 'failed' : `skipped_${scaled}` };
    }
    // The direct link's route while it has no pod. Best-effort: a preview
    // whose route could not move is still asleep, and still wakes from
    // Homeroom; its link answers the ingress controller's own 503 until then.
    try {
      await kubernetes.routePreviewForSleep(kube, name, { asleep: true });
    } catch (err) {
      log.warn('preview-sleep', 'A sleeping preview\'s link could not be routed to the waking page', {
        sessionId: id, runtimeName: name, err: err.message,
      });
    }
    return { outcome: 'asleep' };
  });
  if (out === BUSY) return { outcome: 'skipped_busy' };
  if (out.outcome !== 'asleep') return out;
  // What it still holds: its database clone (#6157 item 5).
  const db = candidate.serving?.db || null;
  const bytes = db ? await dbManager.databaseSize(db).catch(() => null) : null;
  if (bytes != null) {
    await pool.query(
      'UPDATE chat_sessions SET staging_asleep_db_bytes = $2 WHERE id = $1 AND staging_asleep_at IS NOT NULL',
      [id, bytes]).catch(() => {});
  }
  log.info('preview-sleep', 'Preview asleep', {
    sessionId: id, runtimeName: name, attempt: n, db, dbBytes: bytes,
    dbGb: bytes == null ? null : Math.round((bytes / 1e9) * 100) / 100,
  });
  return { outcome: 'asleep', bytes };
}

// Wakes under way in this process, by session: a second door asking while
// one wakes joins it.
const waking = new Map();

/**
 * Wake a session's preview if it sleeps. Resolves { status }:
 *   'none'    it has no Kubernetes preview to wake;
 *   'awake'   it was not asleep (nothing done);
 *   'woke'    it was, and now serves (its address answers the app);
 *   'timeout' its pod did not serve in time; it stays recorded asleep, so
 *             the next door asks again;
 *   'failed'  its runtime is gone, or its route could not be put back.
 * `url` is the preview's address. Never rejects for the cluster's answer.
 */
function wake(config, pool, sessionId, opts = {}) {
  const id = Number(sessionId);
  const going = waking.get(id);
  if (going) return going;
  const run = wakeOnce(config, pool, id, opts)
    .catch((err) => {
      log.warn('preview-sleep', 'Preview wake failed', { sessionId: id, err: err.message });
      return { status: 'failed', detail: err.message };
    })
    .finally(() => { if (waking.get(id) === run) waking.delete(id); });
  waking.set(id, run);
  return run;
}

async function readPreview(pool, id) {
  const { rows: [row] } = await pool.query(
    `SELECT id, app_id, staging_url, staging_runtime_kind, staging_runtime_name, staging_asleep_at, status
       FROM chat_sessions WHERE id = $1`, [id]);
  return row || null;
}

async function wakeOnce(config, pool, id, {
  reason = 'open', timeoutMs = WAKE_TIMEOUT_MS, edgeWaitMs = EDGE_WAIT_MS, edgePollMs = EDGE_POLL_MS, repairRoute = false, deps = {},
} = {}) {
  const kubernetes = deps.kubernetes || require('./kubernetes');
  const row = await readPreview(pool, id);
  if (!row || !row.staging_url || row.staging_runtime_kind !== 'kubernetes' || !row.staging_runtime_name) return { status: 'none' };
  if (!['active', 'paused', 'promoted', 'merging'].includes(row.status)) return { status: 'none' };
  if (!row.staging_asleep_at && !repairRoute) return { status: 'awake', url: row.staging_url };
  if (require('./process-role').processRole() === 'web') {
    return (deps.workflow || require('../workflow/platform.ts')).requestPreviewWake({
      sessionId: id, appId: row.app_id, reason, repairRoute,
    }, { waitMs: timeoutMs + edgeWaitMs });
  }
  const kube = kubernetesConfig(config);
  const name = row.staging_runtime_name;
  if (!row.staging_asleep_at) {
    await kubernetes.routePreviewForSleep(kube, name, { asleep: false });
    return { status: 'awake', url: row.staging_url };
  }
  const startedAt = Date.now();
  const { withSessionLock } = sessionLocks();
  // Scaled up under the lock: a sleep in progress finishes first, and is
  // then found asleep here.
  const scaled = await withSessionLock(pool, lockKey(id), async () => {
    const now = await readPreview(pool, id);
    if (!now?.staging_asleep_at || now.staging_runtime_name !== name) return 'awake';
    return kubernetes.scalePreview(kube, name, 1);
  });
  if (scaled === 'awake') return { status: 'awake', url: row.staging_url };
  if (scaled === 'missing') return { status: 'failed', detail: 'The preview\'s runtime is gone' };
  // 'conflict': written meanwhile (a build, which deploys one replica, or
  // another process's wake). Either way the pod is what to wait for.
  try {
    await kubernetes.waitForPreview(kube, name, { timeoutMs });
  } catch (err) {
    log.warn('preview-sleep', 'A sleeping preview did not wake in time', {
      sessionId: id, runtimeName: name, reason, timeoutMs, err: err.message,
    });
    return { status: 'timeout', detail: 'The preview was asleep and did not wake in time' };
  }
  // Its direct link back to it. The sleep is not ended without it: a
  // preview recorded awake whose link still answered the waking page would
  // never be put right.
  try {
    await kubernetes.routePreviewForSleep(kube, name, { asleep: false });
  } catch (err) {
    log.warn('preview-sleep', 'A woken preview\'s link could not be routed back to it', { sessionId: id, runtimeName: name, err: err.message });
    return { status: 'failed', detail: 'The preview woke, but its address could not be routed back to it' };
  }
  await edgeAnswers(row, { edgeWaitMs, edgePollMs, deps });
  await withSessionLock(pool, lockKey(id), () => pool.query(
    `UPDATE chat_sessions SET staging_asleep_at = NULL, staging_asleep_db_bytes = NULL,
            last_activity_at = GREATEST(last_activity_at, now())
      WHERE id = $1 AND staging_runtime_name = $2`, [id, name]));
  const ms = Date.now() - startedAt;
  log.info('preview-sleep', 'Preview woke', { sessionId: id, runtimeName: name, reason, ms });
  return { status: 'woke', url: row.staging_url, ms };
}

// Until the preview's public address answers the app (anything but a 5xx,
// as staging.verifyStagingEdge judges it), or `edgeWaitMs` passes: the
// ingress controller takes the route back a moment after it is written.
// Not a failure when it does not: the pod serves, and the next look sees it.
async function edgeAnswers(row, { edgeWaitMs, edgePollMs, deps }) {
  if (!(edgeWaitMs > 0)) return true;
  let hostname;
  try { hostname = new URL(row.staging_url).hostname; } catch (_) { return true; }
  const staging = deps.staging || require('./staging');
  const deadline = Date.now() + edgeWaitMs;
  for (;;) {
    const probe = await staging.verifyStagingEdge(row, hostname, row.staging_url).catch(() => null);
    // No probe at all (an address that is not https: a local run).
    if (probe === undefined || probe?.ok) return true;
    if (Date.now() + edgePollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, edgePollMs));
  }
}

/**
 * A checks run's door (the preview machine's checks.run): the preview it
 * checks, awake. `{ ok: false, detail }` when it slept and did not wake: the
 * run reports that as the platform's fault, never the change's.
 */
async function wakeForRun(config, pool, sessionId, opts = {}) {
  const out = await wake(config, pool, sessionId, { reason: 'checks', ...opts });
  if (out.status === 'timeout' || out.status === 'failed') {
    return { ok: false, detail: out.detail || 'The preview was asleep and did not wake in time' };
  }
  return { ok: true, woke: out.status === 'woke' };
}

// Opens Homeroom saw (a Preview click, a request to the preview's host
// through the app-host gate) move the session's last_activity_at, so a
// preview in use does not sleep: at most once a minute, in SQL and in this
// process. `slug`: the app a preview host named, which the session must be
// of (a host is the visitor's to write). Never throws.
const touched = new Map();
async function touchActivity(pool, sessionId, { slug = null, now = Date.now() } = {}) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const last = touched.get(id);
  if (last && now - last < TOUCH_EVERY_MS) return false;
  if (touched.size >= 5000) touched.clear();
  touched.set(id, now);
  try {
    await pool.query(
      `UPDATE chat_sessions cs SET last_activity_at = now()
        WHERE cs.id = $1 AND cs.last_activity_at < now() - make_interval(secs => $2::double precision)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM apps a WHERE a.id = cs.app_id AND a.slug = $3::text))`,
      [id, TOUCH_EVERY_MS / 1000, slug]);
    return true;
  } catch (err) {
    log.warn('preview-sleep', 'Could not note a preview\'s use', { sessionId: id, err: err.message });
    return false;
  }
}

// The session a Homeroom preview host names, or null (a production host, a
// custom domain, anything else).
function previewSessionOfHost(rawHost) {
  const parsed = require('./app-access').parseAppHost(rawHost);
  const m = parsed ? PREVIEW_LABEL_RE.exec(parsed.label) : null;
  return m ? { sessionId: Number(m[1]), slug: parsed.slug, host: parsed.host } : null;
}

/**
 * A direct link's wake (POST /__preview_wake, from the waking page): the
 * preview the host names, woken in the background. A preview found awake
 * whose link still lands on the waking page has its route put back. Resolves
 * { status: 'unknown' | 'waking' | 'awake' } at once.
 */
const linkWakes = new Map();
async function wakeByHost(config, pool, rawHost, { now = Date.now(), deps = {} } = {}) {
  const named = previewSessionOfHost(rawHost);
  if (!named) return { status: 'unknown' };
  const { rows: [row] } = await pool.query(
    `SELECT cs.id, cs.staging_url, cs.staging_runtime_kind, cs.staging_runtime_name, cs.staging_asleep_at
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1 AND a.slug = $2`,
    [named.sessionId, named.slug]);
  if (!row || !row.staging_url || row.staging_runtime_kind !== 'kubernetes') return { status: 'unknown' };
  const last = linkWakes.get(row.id);
  if (last && now - last < LINK_WAKE_EVERY_MS) return { status: row.staging_asleep_at ? 'waking' : 'awake' };
  if (linkWakes.size >= 5000) linkWakes.clear();
  linkWakes.set(row.id, now);
  if (row.staging_asleep_at) {
    wake(config, pool, row.id, { reason: 'link', deps });
    return { status: 'waking' };
  }
  // Awake, yet its link reached the waking page: its route is put back.
  wake(config, pool, row.id, { reason: 'link', repairRoute: true, deps });
  return { status: 'awake' };
}

/** Every sleeping preview, and what their database clones weigh (bytes). */
async function asleepTotals(pool) {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS count, COALESCE(sum(staging_asleep_db_bytes), 0)::text AS bytes,
            count(staging_asleep_db_bytes)::int AS measured
       FROM chat_sessions WHERE staging_asleep_at IS NOT NULL AND staging_url IS NOT NULL`);
  return { count: Number(r?.count) || 0, bytes: Number(r?.bytes) || 0, measured: Number(r?.measured) || 0 };
}

module.exports = {
  DEFAULT_SLEEP_AFTER_MS,
  WAKE_TIMEOUT_MS,
  SLEEP_STATES,
  sleepAfterMs,
  isAsleep,
  sleep,
  wake,
  wakeForRun,
  touchActivity,
  previewSessionOfHost,
  wakeByHost,
  asleepTotals,
  _resetForTest: () => { waking.clear(); touched.clear(); linkWakes.clear(); },
};
