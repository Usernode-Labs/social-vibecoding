'use strict';

// Blue-green lifecycle for child-app production containers. This module owns
// only container/routing choreography; cloning, manifest reconciliation,
// secrets and image builds stay in staging.rebuildProduction.

const dockerDefault = require('./docker');
const caddyDefault = require('./caddy');
const logDefault = require('./logger');

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const DEFAULT_MAX_PARALLEL = boundedInt(process.env.APP_BLUE_GREEN_MAX_PARALLEL, 2, 1, 8);
const DEFAULT_DRAIN_MS = boundedInt(process.env.APP_BLUE_GREEN_DRAIN_MS, 30000, 0, 300000);
const DEFAULT_CHECK_INTERVAL_MS = 5000;

class Admission {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseFn();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  releaseFn() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.releaseFn());
      else this.active -= 1;
    };
  }
}

function isEligible(deployment) {
  return !!deployment
    && deployment.strategy === 'blue-green'
    && deployment.databaseCompatibility === 'expand-contract'
    && deployment.backgroundWork === 'none';
}

function edgeIsReady(result) {
  return !!result?.ok && Number.isInteger(result.code) && result.code < 500;
}

function healthError(message) {
  const err = new Error(message);
  err.healthcheckFailed = true;
  return err;
}

function createController({
  docker = dockerDefault,
  caddy = caddyDefault,
  log = logDefault,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxParallel = DEFAULT_MAX_PARALLEL,
  drainMs = DEFAULT_DRAIN_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
} = {}) {
  const admission = new Admission(boundedInt(maxParallel, DEFAULT_MAX_PARALLEL, 1, 8));

  async function inspect(name) {
    const result = await docker.inspectContainer(name);
    if (result == null) throw new Error(`Cannot inspect ${name}; Docker state is unavailable`);
    return result;
  }

  async function removeRequired(name, context) {
    const result = await docker.stopAndRemove(name);
    if (!result?.removed) {
      throw new Error(`${context}: ${result?.error || `could not remove ${name}`}`);
    }
    return result;
  }

  async function recoverSlots({ stableName, nextName, oldName, port }) {
    let stable = await inspect(stableName);
    let old = await inspect(oldName);
    let next = await inspect(nextName);

    // Prefer a runnable known-old version whenever the stable slot is absent
    // OR present-but-dead. Never delete the only runnable rollback target.
    // This covers interruption between renames and a candidate that crashed
    // before the controller could finish its confidence window.
    if (stable.status !== 'running' && old.status === 'running') {
      if (stable.status !== 'not_found') {
        await removeRequired(stableName, 'dead stable-slot cleanup failed');
      }
      await docker.renameContainer(oldName, stableName);
      log.warn('app-blue-green', 'Recovered prior production slot', { stableName });
      stable = await inspect(stableName);
      old = { status: 'not_found', labels: {} };
    } else if (stable.status !== 'running' && next.status === 'running'
      && await docker.probeHealthOnce(nextName, port, '/health')) {
      // No rollback slot exists (for example, an interrupted first deploy).
      // A healthy candidate is strictly better than leaving the route dead.
      if (stable.status !== 'not_found') {
        await removeRequired(stableName, 'dead stable-slot cleanup failed');
      }
      await docker.renameContainer(nextName, stableName);
      log.warn('app-blue-green', 'Recovered healthy candidate into empty production slot', { stableName });
      stable = await inspect(stableName);
      next = { status: 'not_found', labels: {} };
    }

    if (stable.status !== 'not_found' && next.status !== 'not_found') {
      await removeRequired(nextName, 'stale candidate cleanup failed');
    }
    if (stable.status !== 'not_found' && old.status !== 'not_found') {
      await removeRequired(oldName, 'stale rollback cleanup failed');
    }
    return inspect(stableName);
  }

  async function verifyStable(stableName, hostname, port) {
    if (!await docker.probeHealthOnce(stableName, port, '/health')) {
      throw healthError(`Blue-green stable healthcheck failed: ${stableName}`);
    }
    const edge = await caddy.probeEdge(hostname, { handshakeOnly: false });
    if (!edgeIsReady(edge)) {
      throw healthError(
        `Blue-green edge probe failed for ${hostname}: `
        + (edge?.error?.message || `HTTP ${edge?.code ?? 'unknown'}`)
      );
    }
    return edge;
  }

  async function deploy({ slug, image, env, port = 3000, hostname }) {
    const waitedAt = Date.now();
    log.info('app-blue-green', 'Waiting for overlap admission', { slug, maxParallel: admission.limit });
    const release = await admission.acquire();
    log.info('app-blue-green', 'Overlap admission acquired', { slug, waitedMs: Date.now() - waitedAt });

    const stableName = `usernode-app-${slug}`;
    const nextName = `${stableName}--next`;
    const oldName = `${stableName}--old`;
    const failedName = `${stableName}--failed`;
    let candidateStarted = false;
    let cutover = false;
    let hasRollback = false;

    try {
      let stable = await recoverSlots({ stableName, nextName, oldName, port });
      if (await inspect(failedName).then((s) => s.status !== 'not_found')) {
        await removeRequired(failedName, 'stale failed-candidate cleanup failed');
      }

      const containerId = await docker.runContainer(nextName, { image, env, port });
      candidateStarted = true;
      await docker.waitForHealthy(nextName, port, '/health');
      log.info('app-blue-green', 'Candidate ready', { slug, nextName });

      stable = await inspect(stableName);
      if (stable.status !== 'not_found') {
        // Even an exited stable container owns the name and must move aside.
        await docker.renameContainer(stableName, oldName);
        hasRollback = stable.status === 'running';
      }

      try {
        await docker.renameContainer(nextName, stableName);
        cutover = true;
      } catch (err) {
        if ((await inspect(stableName)).status === 'not_found'
          && (await inspect(oldName)).status !== 'not_found') {
          try {
            await docker.renameContainer(oldName, stableName);
          } catch (restoreErr) {
            throw new Error(
              `Candidate cutover failed (${err.message}) and old-slot restore failed: ${restoreErr.message}`
            );
          }
        }
        throw err;
      }

      log.info('app-blue-green', 'Traffic cut over', { slug, hasRollback });
      await verifyStable(stableName, hostname, port);

      if (hasRollback) {
        const confidenceMs = boundedInt(drainMs, DEFAULT_DRAIN_MS, 0, 300000);
        const intervalMs = boundedInt(checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS, 100, 30000);
        const deadline = Date.now() + confidenceMs;
        while (Date.now() < deadline) {
          await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
          await verifyStable(stableName, hostname, port);
        }
        const removed = await removeRequired(oldName, 'rollback-slot drain failed');
        log.info('app-blue-green', 'Rollback slot drained', {
          slug, confidenceMs, stopMs: removed.stopMs, forceKilled: removed.forceKilled,
        });
      } else if ((await inspect(oldName)).status !== 'not_found') {
        await removeRequired(oldName, 'non-runnable old-slot cleanup failed');
      }

      return { containerId, strategy: 'blue-green' };
    } catch (err) {
      if (cutover && hasRollback) {
        log.warn('app-blue-green', 'Cutover failed; rolling back', { slug, err: err.message });
        let failedMovedAside = false;
        try {
          const stable = await inspect(stableName).catch(() => null);
          if (stable && stable.status !== 'not_found') {
            try {
              await docker.renameContainer(stableName, failedName);
              failedMovedAside = true;
            } catch (renameErr) {
              // A failed candidate is no longer entitled to the stable name.
              // If Docker cannot rename it, remove it so the known-old slot can
              // be restored instead of silently leaving two versions alive.
              await removeRequired(
                stableName,
                `rollback could not move failed stable (${renameErr.message})`
              );
            }
          }
          if ((await inspect(stableName).catch(() => ({ status: 'unknown' }))).status === 'not_found') {
            await docker.renameContainer(oldName, stableName);
            await docker.waitForHealthy(stableName, port, '/health');
            await verifyStable(stableName, hostname, port);
            log.warn('app-blue-green', 'Rollback restored prior production', { slug });
          }
        } finally {
          if (failedMovedAside) {
            await removeRequired(failedName, 'failed candidate cleanup after rollback failed');
          }
        }
      } else if (cutover) {
        // There was no runnable prior version. The candidate passed its
        // direct readiness check, so removing it would turn a degraded edge
        // verification into a certain outage. Keep the only runnable stable
        // target but clean any non-runnable old slot and report the deploy
        // failure so the watchdog/operator can retry the edge check.
        if ((await inspect(oldName)).status !== 'not_found') {
          await removeRequired(oldName, 'non-runnable old-slot cleanup after failed cutover');
        }
        log.warn('app-blue-green', 'No rollback target; keeping ready candidate on stable name', {
          slug, err: err.message,
        });
      } else if (candidateStarted) {
        await removeRequired(nextName, 'failed candidate cleanup failed');
      }
      throw err;
    } finally {
      release();
      log.info('app-blue-green', 'Overlap admission released', { slug });
    }
  }

  return { deploy, recoverSlots, verifyStable, admission };
}

const defaultController = createController();

module.exports = {
  deploy: defaultController.deploy,
  isEligible,
  createController,
  DEFAULT_DRAIN_MS,
  DEFAULT_MAX_PARALLEL,
};
