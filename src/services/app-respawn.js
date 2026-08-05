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
const dbManager = require('./db-manager');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const appStorageEnv = require('./app-storage-env');
const { appIdentityEnv } = require('./app-identity-env');
const { getPool } = require('../db/pool');

// Assemble the complete production run contract for an already-built image.
// Kept separate from the destructive replacement primitive so the admin
// rollover can hand the exact same image/env/limits to app-blue-green.
async function existingImageRunSpec(config, app) {
  if (!app.db_password) {
    throw new Error(
      `runExistingImage: app ${app.slug} has no db_password — ` +
      `migrateAppDbsToPerRole should have populated it first.`
    );
  }

  const imageName = `usernode-app-${app.slug}:latest`;

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
  return {
    image: imageName,
    env: {
      DATABASE_URL: dbUrl,
      ...appIdentityEnv(app, config),
      PORT: '3000',
      USERNODE_ENV: 'production',
      ...llmEnv,
      ...storageEnv,
      ...merge.env,
    },
    port: 3000,
  };
}

// Core shared by respawnAppContainer (boot migration) and app-heal.js:
// assemble the production env contract, stop+rm any existing container, and
// run a fresh one. Does NOT health-check or persist apps.container_id.
async function runExistingImage(config, app) {
  const spec = await existingImageRunSpec(config, app);
  if (!spec) return null;
  const containerName = `usernode-app-${app.slug}`;
  await docker.stopAndRemove(containerName).catch(() => {});
  const containerId = await docker.runContainer(containerName, spec);

  return containerId;
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
  await docker.waitForHealthy(containerName, 3000, '/health').catch((err) => {
    log.warn('app-respawn', 'Container did not become healthy after respawn', {
      slug: app.slug, err: err.message,
    });
  });

  const pool = getPool(config);
  await pool.query(
    'UPDATE apps SET container_id = $1 WHERE id = $2',
    [containerId, app.id]
  );

  log.info('app-respawn', 'App respawned', { slug: app.slug, containerId });
  return containerId;
}

module.exports = { respawnAppContainer, runExistingImage, existingImageRunSpec };
