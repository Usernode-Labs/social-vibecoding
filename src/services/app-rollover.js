'use strict';

/**
 * Bulk container rollover — recreate every running child-app container
 * with a freshly assembled environment.
 *
 * WHY THIS EXISTS
 *
 * Docker has no "set env on a live container" primitive, and neither does
 * the platform: an env change (a newly injected variable, a rotated key)
 * only reaches an app when its container is stop+rm+run with env built by
 * the CURRENT platform process. `docker restart` / `docker start` preserve
 * the original env, so a host reboot or an app-heal fast-path start leaves
 * a container looking perfectly healthy while still holding stale env.
 *
 * Before this module the only on-demand env-correct path was
 * `POST /api/apps/:slug/redeploy` → `staging.deployProduction`, which does
 * a full clone + `docker build` (p50 ~28s per app) one app at a time. The
 * cheap path — `appRespawn.runExistingImage`, which re-runs the image that
 * is already on the host with a freshly assembled env (~3-6s per app) —
 * was reachable only from the one-time boot migration and the watchdog.
 * This module exposes it as one admin-triggered sweep.
 *
 * DELIBERATELY ENV-ONLY. The respawn path reuses each app's existing
 * image, so a rollover never ships undeployed code and never applies
 * pending manifest reconciliation (name / visibility / governance /
 * admins / icon). That is the whole point: it is the safer tool than
 * /redeploy for "the environment changed, nothing else did". The full
 * rebuild is used only as a fallback when the image is missing.
 *
 * SHAPE
 *
 *   - One job at a time across every process: the container-rollover clock
 *     (src/workflow/clock/services.ts), which runs only when an admin asks
 *     (start: its RunNow). A start while a job runs is answered with the job
 *     under way; the route turns that into a 409. Each app is a step of the
 *     run's work item (services/fleet-job.js), so a restart carries the job
 *     on after the apps it rolled, and its progress is that checkpoint,
 *     which any process reads (read). It was an object in the memory of the
 *     web process whose route started it: two presses on two processes ran
 *     two sweeps, and a restart lost the job.
 *   - Per-app failure isolation: every unit is individually caught, the
 *     drain continues, and the failure lands in `apps.last_failure` so the
 *     existing "View build log" panel covers it.
 *   - Progress rides existing WS machinery: per-app
 *     `app_redeploy_status` (via app-deploy-status markStart/markEnd, which
 *     is what flips the version pills) plus one aggregate
 *     `admin_rollover_status` sent only to admin sockets.
 */

const log = require('./logger');
const docker = require('./docker');
const appRespawn = require('./app-respawn');
const appDeployStatus = require('./app-deploy-status');
const deployFailure = require('./deploy-failure');
const events = require('./events');
const fleetJob = require('./fleet-job');
const { getPool } = require('../db/pool');
const { withResourceUse } = require('./build-retention-guard');
const { PRODUCTION_BUILD_LOCK } = require('./advisory-locks');

// Mirrors app-heal.js's MAX_HEALS_PER_TICK: the existing precedent for
// "how much docker churn is polite on this host". At 3, at most three apps
// are briefly unavailable at once.
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

// The clock that runs the job (src/workflow/clock/services.ts).
const JOB = 'container-rollover';

// The apps this sweep owns. `self_hosted IS NOT TRUE` is the primary
// self-app exclusion — the platform's own row is status='running' too, so
// omitting it would try to stop the container serving the request. Same
// predicate app-heal.poll uses.
const ELIGIBLE_WHERE = "status = 'running' AND self_hosted IS NOT TRUE";

// slug -> row shape runExistingImage needs (db_password, manifest_snapshot)
// plus what the fallback and the UI need.
const ELIGIBLE_COLUMNS = `id, slug, name, db_password, manifest_snapshot, repo_url,
         self_hosted, main_sha, image_ref, deploy_state, deploy_started_at, deploy_from_sha`;
const SELECT_ELIGIBLE = `
  SELECT ${ELIGIBLE_COLUMNS}
    FROM apps
   WHERE ${ELIGIBLE_WHERE}
   ORDER BY id`;
// The same row again, read once this app's turn holds the locks: a deploy
// that ran while the job waited (a merge, Redeploy, the drift poller) may
// have built a newer image, which the respawn must run rather than the one
// the job saw when it started (on Kubernetes image_ref is a digest).
const SELECT_ONE = `
  SELECT ${ELIGIBLE_COLUMNS}
    FROM apps
   WHERE id = $1 AND ${ELIGIBLE_WHERE}`;

// Per-app outcomes, in the spirit of app-heal.checkAndHealOne's documented
// status enum:
//   rolled                  — image re-run with fresh env, healthy
//   rebuild_requested       — image was missing; the rebuild was asked of
//                             app delivery
//   skipped_deploying       — another rebuild owns this slug right now
//   skipped_missing_secrets — required secrets unset; image can't run
//   skipped_no_db_password  — per-role migration hasn't populated it
//   skipped_deleted         — app row vanished mid-job
//   failed                  — docker run / health check threw
const FAILED = 'failed';

function isStagingEnv() {
  return process.env.USERNODE_ENV === 'staging';
}

function concurrency() {
  const raw = parseInt(process.env.ROLLOVER_CONCURRENCY || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
  return Math.min(raw, MAX_CONCURRENCY);
}

const SHAPE = {
  rowsField: 'apps',
  keyOf: (app) => String(app.id),
  rowOf: (app) => ({ appId: app.id, slug: app.slug }),
};

// Lazily required so the module graph stays acyclic (ws.js does not import
// this module, but routes that load ws also load this) — same dodge
// app-deploy-status.js documents.
function broadcast(job) {
  try {
    const { broadcastToAdmins } = require('./ws');
    broadcastToAdmins({ type: 'admin_rollover_status', job });
  } catch (err) {
    log.warn('app-rollover', 'broadcast failed', { err: err.message });
  }
}

/** The job under way, or the last one, as the console shows it. */
async function read(pool) {
  const run = await require('../workflow/platform.ts').clockRunOf(pool, JOB);
  return fleetJob.snapshotOf(run, { ...SHAPE, concurrency: concurrency() });
}

async function eligibleCount(config) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM apps WHERE ${ELIGIBLE_WHERE}`
  );
  return rows[0] ? rows[0].n : 0;
}

/**
 * Staging demo job — request-time injection per the "Staging mock data"
 * convention, so the console section renders reviewable rows in a preview
 * (which has no production containers to roll over at all). Never
 * persisted; the route only serves it behind IS_STAGING && ?demo=1, and
 * POST stays refused in staging regardless.
 */
function demoJob() {
  return {
    id: 1,
    startedAt: '2026-01-01T12:00:00.000Z',
    startedBy: 'staging-demo-admin',
    finishedAt: '2026-01-01T12:00:47.000Z',
    concurrency: DEFAULT_CONCURRENCY,
    total: 5,
    done: 5,
    failed: 1,
    stale: false,
    demo: true,
    apps: [
      { appId: 900001, slug: 'staging-demo-app-one', state: 'rolled', ms: 4100, error: null },
      { appId: 900002, slug: 'staging-demo-app-two', state: 'rolled', ms: 3700, error: null },
      { appId: 900003, slug: 'staging-demo-app-three', state: 'rebuild_requested', ms: 31200, error: null },
      {
        appId: 900004,
        slug: 'staging-demo-app-four',
        state: 'skipped_missing_secrets',
        ms: 120,
        error: null,
      },
      {
        appId: 900005,
        slug: 'staging-demo-app-five',
        state: FAILED,
        ms: 22400,
        error: 'Container did not become healthy after respawn',
      },
    ],
  };
}

/**
 * Ask for a sweep: the container-rollover clock's run, on whichever process
 * runs the workflow. Returns { started, job }: `started: false` with the job
 * under way when one runs (anywhere).
 */
async function start(pool, admin) {
  const now = await read(pool);
  if (now && !now.finishedAt && !now.stale) return { started: false, job: now };
  const asked = await require('../workflow/platform.ts').askClockRun(JOB, admin);
  return { started: !!asked, job: await read(pool) };
}

/** The clock's run: every eligible app rolled over, a step each. */
async function runJob(ctx, { config, pool }) {
  return fleetJob.run(ctx, {
    name: JOB,
    ...SHAPE,
    concurrency: concurrency(),
    list: async () => (await pool.query(SELECT_ELIGIBLE)).rows.map((r) => ({ id: r.id, slug: r.slug })),
    unit: async ({ id }) => {
      const { rows: [app] } = await pool.query(SELECT_ONE, [id]);
      if (!app) return { outcome: 'skipped_deleted' };
      return rollOne(config, pool, app);
    },
    publish: broadcast,
    finish: (job, { durationMs }) => {
      const tally = job.apps.reduce((acc, a) => { acc[a.state] = (acc[a.state] || 0) + 1; return acc; }, {});
      // The job's record in the audit trail, with its tally.
      return events.record(pool, {
        type: events.EVENT_TYPES.CONTAINERS_ROLLED_OVER,
        userId: ctx.input.asked?.userId ?? null,
        metadata: {
          jobId: job.id,
          startedBy: job.startedBy,
          total: job.total,
          rolled: tally.rolled || 0,
          rebuildRequested: tally.rebuild_requested || 0,
          skipped: Object.keys(tally).filter((k) => k.startsWith('skipped_')).reduce((n, k) => n + tally[k], 0),
          failed: job.failed,
          failedSlugs: job.apps.filter((a) => a.state === FAILED).map((a) => a.slug),
          durationMs,
        },
      });
    },
  });
}

/**
 * One app's unit of work. Never throws — every path resolves to an
 * outcome string so a single bad app can't take the sweep down.
 */
async function rollOne(config, pool, app) {
  const containerName = `usernode-app-${app.slug}`;
  const imageName = `usernode-app-${app.slug}:latest`;

  // Something else (merge, drift poller, heal) owns this slug right now, in
  // this process or by app delivery anywhere (the row's deploy_state).
  // Stepping on it would interleave two stopAndRemove/runContainer pairs.
  const deploy = appDeployStatus.read(app.slug, app);
  if (deploy && deploy.deploying) return { outcome: 'skipped_deploying' };

  const kubernetesMode = config.appRuntime === 'kubernetes';
  const hasImage = kubernetesMode
    ? !!app.image_ref
    : await docker.imageExists(imageName).catch(() => false);

  if (!hasImage) {
    // Fallback: the cheap path needs an image on the host. Without one, a
    // rebuild is asked of app delivery, which runs it (one deploy of an app
    // at a time, under the build lock).
    if (!app.repo_url) {
      const err = new Error(
        `no image ${imageName} on the host and no repo_url — nothing to run`
      );
      await persistFailure(pool, app, err, 'start');
      log.warn('app-rollover', 'Cannot roll over app', { slug: app.slug, err: err.message });
      return { outcome: FAILED, error: err.message };
    }
    try {
      await require('../workflow/platform.ts').requestDeploy(app.id, 'rollover');
      return { outcome: 'rebuild_requested' };
    } catch (err) {
      log.warn('app-rollover', 'Rebuild fallback failed', {
        slug: app.slug, err: err.message,
      });
      return { outcome: FAILED, error: err.message };
    }
  }

  // Per-slug serialization: a rollover and app delivery's deploys of the
  // same app queue behind one another. This is the race staging.js's
  // serializeRebuild comment documents — runExistingImage does not take the
  // lock on its own. The chain orders this process; PRODUCTION_BUILD_LOCK
  // (Kubernetes) orders this against a deploy in another process, as
  // staging.deployProduction takes it.
  const staging = require('./staging');
  return staging.serializeRebuild(app.slug, () => withResourceUse(config, PRODUCTION_BUILD_LOCK, app.slug, async () => {
    const { rows: [current] } = await pool.query(SELECT_ONE, [app.id]);
    if (!current) return { outcome: 'skipped_deleted' };
    const now = appDeployStatus.read(current.slug, current);
    if (now && now.deploying) return { outcome: 'skipped_deploying' };
    app = current;
    // markStart/markEnd are the only emitters of app_redeploy_status, so
    // this is what makes the version pills spin during a rollover.
    appDeployStatus.markStart(app.slug, { fromSha: app.main_sha || null });
    let failedForPill = false;
    try {
      let containerId;
      try {
        containerId = await appRespawn.runExistingImage(config, app);
      } catch (err) {
        if (/db_password/.test(err.message || '')) {
          log.warn('app-rollover', 'App has no db_password — skipping', { slug: app.slug });
          return { outcome: 'skipped_no_db_password' };
        }
        failedForPill = true;
        await persistFailure(pool, app, err, 'start');
        log.warn('app-rollover', 'Respawn failed', { slug: app.slug, err: err.message });
        return { outcome: FAILED, error: err.message };
      }

      // null means required secrets are unset. Do NOT fall back to
      // deployProduction — it would raise MissingSecretsError for the
      // same reason, after a pointless clone + build.
      if (!containerId) return { outcome: 'skipped_missing_secrets' };

      try {
        if (kubernetesMode) {
          const { rowCount } = await pool.query(
            `UPDATE apps SET container_id = NULL, runtime_kind = 'kubernetes',
               runtime_name = $1, last_deploy_at = NOW() WHERE id = $2`,
            [containerId, app.id]
          );
          if (!rowCount) return { outcome: 'skipped_deleted' };
          return { outcome: 'rolled' };
        }
        await docker.waitForHealthy(containerName, 3000, '/health', 10);
      } catch (err) {
        failedForPill = true;
        await persistFailure(pool, app, err, 'healthcheck');
        log.warn('app-rollover', 'Container did not become healthy after respawn', {
          slug: app.slug, err: err.message,
        });
        return { outcome: FAILED, error: err.message };
      }

      // container_id AND last_deploy_at, mirroring app-heal's
      // recoverFromScratch. Deliberately NOT apps.status (flipping it
      // drops the app's URL from the home tile — see app-deploy-status.js)
      // and NOT main_sha (nothing was rebuilt).
      const { rowCount } = await pool.query(
        'UPDATE apps SET container_id = $1, last_deploy_at = NOW() WHERE id = $2',
        [containerId, app.id]
      );
      if (!rowCount) return { outcome: 'skipped_deleted' };
      return { outcome: 'rolled' };
    } finally {
      appDeployStatus.markEnd(app.slug, { failed: failedForPill });
    }
  }));
}

// apps.last_failure so the existing "View build log" panel covers rollover
// failures too. classify() honors an explicit stage, so a failed docker run
// reads 'start' and a failed health wait reads 'healthcheck'. sha is null —
// nothing was built.
async function persistFailure(pool, app, err, stage) {
  try {
    await pool.query(
      'UPDATE apps SET last_failure = $1 WHERE id = $2',
      [JSON.stringify(deployFailure.record(err, { stage, sha: null })), app.id]
    );
  } catch (e) {
    log.warn('app-rollover', 'Failed to persist last_failure', {
      slug: app.slug, err: e.message,
    });
  }
}

module.exports = {
  start,
  read,
  runJob,
  rollOne,
  demoJob,
  eligibleCount,
  isStagingEnv,
  concurrency,
  JOB,
  DEFAULT_CONCURRENCY,
  SELECT_ELIGIBLE,
};
