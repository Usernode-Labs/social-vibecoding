/**
 * Production apps' health (issue #426): the I/O of the app-health clock
 * and of app delivery's heal (src/workflow/app-delivery/).
 *
 * Nothing here decides whether to heal. The app-health clock (scan) looks
 * at every status='running', non-self-hosted app's runtime each minute and
 * tells app delivery about each one that is not running (Unhealthy); the
 * error page tells it about an app a person could not reach (reportVisit:
 * Unreachable). App delivery decides: it runs one thing at a time on an
 * app's runtime, so a heal never races a deploy, and it keeps the backoff
 * that stops a crash-looping app from being restarted every minute for
 * ever. Its heal work (heal, below) tries the cheapest cure:
 *
 *   - Kubernetes: a Deployment that exists is restarted; a probe first when
 *     a person could not reach an app its runtime calls running.
 *   - Docker: a stopped container is started in place; a running one a
 *     person could not reach is probed, and restarted when it does not
 *     answer.
 *   - Neither helped, or nothing is there: an app with a repository needs a
 *     deploy (app delivery runs it); one without (GitHub is off) runs its
 *     built image again with a freshly assembled env.
 *
 * Each time it brings an app back, it records the minute (app-outages.js),
 * which the Infra topic's figures count. apps.status stays 'running'
 * throughout (flipping it would drop the app's URL from the home tile).
 */

const log = require('./logger');
const docker = require('./docker');
const applicationRuntime = require('./application-runtime');
const appOutages = require('./app-outages');
const appTeardown = require('./app-teardown');
const deployFailure = require('./deploy-failure');

// APP_HEAL_INTERVAL_MS (config.appHealIntervalMs): how often the clock
// looks; 0 switches it off.
function intervalMs(config) {
  const v = config && Number.isFinite(config.appHealIntervalMs)
    ? config.appHealIntervalMs
    : parseInt(process.env.APP_HEAL_INTERVAL_MS || '60000', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function containerName(slug) {
  return `usernode-app-${slug}`;
}

// The app-health clock's run: every running app's runtime, and app delivery
// told about each one that is not running, keyed by the run (a run done
// again tells nothing twice). Resolves what it found.
async function scan(config, pool, { n, shouldStop = () => false,
  report = (appId, state, key) => require('../workflow/platform.ts').reportUnhealthy(appId, state, key) } = {}) {
  const { rows } = await pool.query(
    `SELECT id, slug, runtime_kind, runtime_name FROM apps
      WHERE status = 'running' AND self_hosted IS NOT TRUE
      ORDER BY id`);
  const down = [];
  let checked = 0;
  for (const app of rows) {
    if (shouldStop()) break;
    const ref = applicationRuntime.productionRef(config, app);
    let state;
    try {
      state = await applicationRuntime.status({ ...config, appRuntime: ref.runtimeKind }, ref);
    } catch (err) {
      log.warn('app-heal', 'Runtime state unknown', { slug: app.slug, err: err.message });
      continue;
    }
    checked += 1;
    if (state === 'running') continue;
    down.push(app.slug);
    await report(app.id, String(state || 'not_found'), `health:${app.id}:${n}`);
  }
  return { checked, down };
}

// The error page: a person reached it instead of the app. App delivery
// probes and heals it if it should. Keyed per app and minute: the page's
// retries and other visitors add nothing. Never throws; fire-and-forget.
// This process's last report per app (its minute): the page re-checks every
// few seconds and other visitors arrive, and one report a minute says it.
// Cost only: the key makes a second report a replay anyway.
const visited = new Map();
function reportVisit(pool, slug) {
  const minute = Math.floor(Date.now() / 60_000);
  if (visited.get(slug) === minute) return;
  visited.set(slug, minute);
  if (visited.size > 1000) visited.clear();
  (async () => {
    const { rows: [app] } = await pool.query(
      `SELECT id FROM apps WHERE slug = $1 AND status = 'running' AND self_hosted IS NOT TRUE`, [slug]);
    if (!app) return;
    await require('../workflow/platform.ts').reportUnreachable(app.id, `visit:${app.id}:${minute}`);
  })().catch((err) => {
    log.warn('app-heal', 'Could not report an unreachable app', { slug, err: err.message });
  });
}

// The heal: app delivery's work for an app reported down (or unreachable,
// `probe`). Resolves its status: healthy, waits_for_new_commit, restarted,
// started, respawned, deleting, skipped, or needs_deploy (app delivery then
// deploys). Throws when it could not cure it; app delivery backs off.
async function heal(config, pool, appId, { probe = false, via = 'sweep', signal = null } = {}) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
  if (!app || app.self_hosted || app.status !== 'running') return { status: 'skipped' };
  if (await appTeardown.isTearingDown(pool, { id: app.id })) return { status: 'deleting' };
  const runtimeRef = applicationRuntime.productionRef(config, app);
  const cfg = { ...config, appRuntime: runtimeRef.runtimeKind };
  const state = await applicationRuntime.status(cfg, runtimeRef);
  const result = runtimeRef.runtimeKind === 'kubernetes'
    ? await healKubernetes(cfg, pool, app, runtimeRef, state, { probe, signal })
    : await healDocker(cfg, pool, app, state, { probe });
  // A deploy app delivery runs now is the outage's cure as a deploy request
  // was before (app-outages' RESTART_OUTCOMES).
  appOutages.recordHealed(pool, app, { status: result.status === 'needs_deploy' ? 'deploy_requested' : result.status }, via);
  log.info('app-heal', 'Heal finished', { slug: app.slug, state, status: result.status });
  return result;
}

// What only a new runtime cures: a deploy for an app with a repository; for
// one without (GitHub is off), its built image run again.
async function replace(config, pool, app) {
  if (app.repo_url && require('./github').isEnabled()) return { status: 'needs_deploy' };
  try {
    const containerId = await require('./app-respawn').runExistingImage(config, app);
    // Missing required secrets: unrunnable until a person adds them.
    if (!containerId) throw new Error(`cannot respawn ${app.slug}: missing required secrets`);
    const runtimeKind = applicationRuntime.mode(config);
    // Kubernetes deploy already waits for the replacement replicas' readiness.
    if (runtimeKind === 'docker') await docker.waitForHealthy(containerName(app.slug), 3000, '/health', 10);
    await pool.query(
      'UPDATE apps SET container_id = $1, last_deploy_at = NOW(), runtime_kind = $3, runtime_name = $4 WHERE id = $2',
      [runtimeKind === 'docker' ? containerId : null, app.id, runtimeKind, containerId]);
    log.info('app-heal', 'App respawned from existing image', { slug: app.slug });
    return { status: 'respawned' };
  } finally {
    // A respawn takes minutes, so an app can be deleted while one runs: an
    // app that is gone or going by the end keeps no runtime.
    await appTeardown.removeRuntimeIfDeleted(config, pool, app, { who: 'recovery' });
  }
}

async function healKubernetes(config, pool, app, runtimeRef, state, { probe, signal }) {
  if (state === 'running' && (!probe || await applicationRuntime.probeHealth(config, runtimeRef))) {
    return { status: 'healthy' };
  }
  // The Deployment's template is an image refused for running as root (a
  // newer commit than the one that last went live; the previous ReplicaSet
  // keeps serving). A restart rolls the same refusal out; a rebuild of the
  // same commit makes the same image. Only a commit that changes the
  // Dockerfile helps, and a merge or the drift clock deploys that.
  const refused = deployFailure.asRecord(app.last_failure);
  if (refused?.kind === deployFailure.ROOT_IMAGE && refused.sha && refused.sha !== app.main_sha) {
    return { status: 'waits_for_new_commit' };
  }
  if (state !== 'not_found') {
    try {
      // The restart waits for the rollout (up to five minutes), and an app
      // that cannot start never rolls out. A process that stops meanwhile
      // gives the heal up: the next report heals it again.
      await race(applicationRuntime.restart(config, runtimeRef), signal);
      return { status: 'restarted' };
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn('app-heal', 'Kubernetes restart failed; it needs a new runtime', { slug: app.slug, err: err.message });
    }
  }
  return replace(config, pool, app);
}

async function healDocker(config, pool, app, state, { probe }) {
  const name = containerName(app.slug);
  if (state === 'running') {
    if (!probe) return { status: 'healthy' };
    // A person could not reach it, yet the container claims to be running:
    // probe it, and restart a hung process. waitForHealthy's short form
    // gives ~2 tries (~4s).
    try {
      await docker.waitForHealthy(name, 3000, '/health', 2);
      return { status: 'healthy' };
    } catch (_) {
      log.warn('app-heal', 'Container running but not answering; restarting', { slug: app.slug });
      await docker.restartContainer(name);
      await docker.waitForHealthy(name, 3000, '/health', 10);
      return { status: 'restarted' };
    }
  }
  // Not running: exited / created / paused / dead / restarting past its
  // grace (app delivery gave it one), or gone.
  if (state !== 'not_found') {
    try {
      await docker.startContainer(name);
      await docker.waitForHealthy(name, 3000, '/health', 10);
      log.info('app-heal', 'Container started in place', { slug: app.slug });
      return { status: 'started' };
    } catch (err) {
      log.warn('app-heal', 'In-place start failed; it needs a new runtime', { slug: app.slug, err: err.message });
    }
  }
  return replace(config, pool, app);
}

// The promise, or the work's stop, whichever comes first.
function race(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('the heal was stopped'));
  return Promise.race([promise, new Promise((_, rejectStop) => {
    signal.addEventListener('abort', () => rejectStop(new Error('the heal was stopped')), { once: true });
  })]);
}

module.exports = { intervalMs, scan, reportVisit, heal };
