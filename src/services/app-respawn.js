// Lightweight container respawn for child apps. Used by the boot
// migration in src/db/migrate.js when an app's DB has just been
// adopted under the per-role model (apps.db_password populated for
// the first time): the running container still has the old
// shared-superuser DATABASE_URL and needs to be restarted with the
// new per-role URL so the principle-of-least-privilege isolation
// actually takes effect. Also reused by the production watchdog
// (services/app-heal.js) to re-run an already-built image for apps
// without a repo_url when their container has gone missing.
//
// Distinct from staging.js's `rebuildProduction`, which does a full
// git clone + docker build + run. These helpers assume the app's
// image is already built (`usernode-app-<slug>:latest` exists on the
// host) and just stop+rm+run with fresh env.

const log = require('./logger');
const docker = require('./docker');
const applicationRuntime = require('./application-runtime');
const dbManager = require('./db-manager');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const appStorageEnv = require('./app-storage-env');
const { appIdentityEnv } = require('./app-identity-env');
const { getPool } = require('../db/pool');

const SOURCE_REVISION_LABEL = 'social.usernode.io/source-revision';

// Core shared by respawnAppContainer (boot migration) and app-heal.js:
// assemble the production env contract (per-role DATABASE_URL, LLM-proxy
// pair, merged secrets) for the app's ALREADY-BUILT image, stop+rm any
// existing container, and `docker run` a fresh one. Returns the new
// containerId, or null when required secrets are missing (the image
// cannot run — callers decide whether that's a warn or a failure).
// Does NOT health-check and does NOT persist apps.container_id; callers
// own both so each can pick its own strictness.
// The source-revision label is the evidence proposal-delivery reads to say
// a merged proposal is live (#3335). A respawn re-runs the SAME image, so
// the revision it serves does not change — carry the label over from the
// runtime being replaced rather than dropping it (#3368: every heal and
// rollover used to strip it, turning each merged row back to "unknown").
// Only a label the live runtime itself reports is carried, never
// apps.main_sha, which can be backfilled from the remote without a deploy.
// And only when the live runtime provably runs the image being re-run: on
// docker that image is the mutable `:latest` tag, which a rebuild can
// retag and then fail before deploying, so the container's immutable image
// id must equal what the tag resolves to now. Without that proof nothing
// is carried and delivery reads `unknown` until the next real rebuild.
async function carriedSourceRevision(config, app, imageName) {
  try {
    const ref = applicationRuntime.productionRef(config, app);
    const live = await applicationRuntime.inspect(config, ref);
    const sha = String(live?.labels?.[SOURCE_REVISION_LABEL] || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sha)) return {};
    if (ref.runtimeKind === 'docker') {
      const target = await docker.imageId(imageName);
      if (!live.imageId || !target || live.imageId !== target) return {};
    } else if (!live.imageRef || live.imageRef !== imageName) {
      return {};
    }
    return { [SOURCE_REVISION_LABEL]: sha };
  } catch (err) {
    log.warn('app-respawn', 'Could not read the running source revision', {
      slug: app.slug, err: err.message,
    });
    return {};
  }
}

async function runExistingImage(config, app) {
  if (!app.db_password) {
    throw new Error(
      `runExistingImage: app ${app.slug} has no db_password — ` +
      `migrateAppDbsToPerRole should have populated it first.`
    );
  }

  const containerName = `usernode-app-${app.slug}`;
  const imageName = applicationRuntime.mode(config) === 'kubernetes'
    ? app.image_ref
    : `usernode-app-${app.slug}:latest`;
  if (!imageName) throw new Error(`runExistingImage: app ${app.slug} has no reusable image_ref`);

  const pool = getPool(config);
  const manifest = app.manifest_snapshot || { secrets: [] };
  const stored = await appSecrets.getRawValues(pool, app.id, config.dataEncryptionKey);
  const merge = appSecrets.mergeForDeploy(
    manifest, stored, appSecrets.platformDefaultsFromEnv()
  );

  // Missing required secrets means the image can't be run correctly.
  // Leave any existing (broken) container in place; the operator has to
  // fix the secrets and /redeploy.
  if (merge.missingRequired.length) {
    log.warn('app-respawn', 'Refusing to run image with missing required secrets', {
      slug: app.slug, missing: merge.missingRequired,
    });
    return null;
  }

  const dbUrl = dbManager.connectionUrl(
    dbManager.appDbName(app.slug), app.db_password
  );

  // Same production env contract as app-creator / rebuildProduction —
  // a respawn must not silently drop the LLM-proxy pair (issue #34) or
  // the app-storage pair (#752).
  const llmEnv = await appLlmEnv.productionLlmEnv(pool, app.id);
  const storageEnv = await appStorageEnv.productionStorageEnv(pool, app.id);
  const labels = await carriedSourceRevision(config, app, imageName);
  const deployed = await applicationRuntime.deploy(config, {
    app,
    environment: 'production',
    imageRef: imageName,
    dockerName: containerName,
    labels,
    env: {
      DATABASE_URL: dbUrl,
      ...appIdentityEnv(app, config),
      PORT: '3000',
      USERNODE_ENV: 'production',
      ...llmEnv,
      ...storageEnv,
      ...merge.env,
    },
  });

  return deployed.runtimeName;
}

async function respawnAppContainer(config, app) {
  if (app.self_hosted) {
    // The platform's own row is pinned to container_id='usernode'
    // (the docker-compose service), which we deliberately do not
    // restart from inside ourselves. Phase 2g.
    return;
  }

  const containerName = `usernode-app-${app.slug}`;

  log.info('app-respawn', 'Respawning app container with new per-role URL', {
    slug: app.slug, container: containerName,
  });

  const containerId = await runExistingImage(config, app);
  if (!containerId) return null;

  // Health check is best-effort here — we don't want a slow-starting
  // app to block platform boot. If it fails to come up the operator
  // gets a warning in the logs and the existing /redeploy + drift
  // poller + app-heal watchdog paths will repair it.
  if (applicationRuntime.mode(config) === 'docker') await docker.waitForHealthy(containerName, 3000, '/health').catch((err) => {
    log.warn('app-respawn', 'Container did not become healthy after respawn', {
      slug: app.slug, err: err.message,
    });
  });

  const pool = getPool(config);
  const runtimeKind = applicationRuntime.mode(config);
  await pool.query(
    `UPDATE apps SET container_id = $1, runtime_kind = $2, runtime_name = $3 WHERE id = $4`,
    [runtimeKind === 'docker' ? containerId : null, runtimeKind, containerId, app.id]
  );

  log.info('app-respawn', 'App respawned', { slug: app.slug, containerId });
  return containerId;
}

module.exports = { respawnAppContainer, runExistingImage };
