// Lightweight container respawn for child apps. Used by the boot
// migration in src/db/migrate.js when an app's DB has just been
// adopted under the per-role model (apps.db_password populated for
// the first time): the running container still has the old
// shared-superuser DATABASE_URL and needs to be restarted with the
// new per-role URL so the principle-of-least-privilege isolation
// actually takes effect.
//
// Distinct from staging.js's `rebuildProduction`, which does a full
// git clone + docker build + run. This helper assumes the app's
// image is already built (the case at boot-migration time — every
// running app has a `usernode-app-<slug>:latest` image already on
// the host) and just stop+rm+run with fresh env.

const log = require('./logger');
const docker = require('./docker');
const dbManager = require('./db-manager');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const { getPool } = require('../db/pool');

async function respawnAppContainer(config, app) {
  if (app.self_hosted) {
    // The platform's own row is pinned to container_id='usernode'
    // (the docker-compose service), which we deliberately do not
    // restart from inside ourselves. Phase 2g.
    return;
  }
  if (!app.db_password) {
    throw new Error(
      `respawnAppContainer: app ${app.slug} has no db_password — ` +
      `migrateAppDbsToPerRole should have populated it first.`
    );
  }

  const containerName = `usernode-app-${app.slug}`;
  const imageName = `usernode-app-${app.slug}:latest`;

  log.info('app-respawn', 'Respawning app container with new per-role URL', {
    slug: app.slug, container: containerName,
  });

  const pool = getPool(config);
  const manifest = app.manifest_snapshot || { secrets: [] };
  const stored = await appSecrets.getRawValues(pool, app.id, config.jwtSecret);
  const merge = appSecrets.mergeForDeploy(
    manifest, stored, appSecrets.platformDefaultsFromEnv()
  );

  // Boot-migration time: missing required secrets means the prod
  // container would have been failing health checks already, so don't
  // bother respawning. Leave the (now broken) old container in place;
  // operator will have to re-run /redeploy after fixing secrets.
  if (merge.missingRequired.length) {
    log.warn('app-respawn', 'Refusing to respawn app with missing required secrets', {
      slug: app.slug, missing: merge.missingRequired,
    });
    return null;
  }

  const dbUrl = dbManager.connectionUrl(
    dbManager.appDbName(app.slug), app.db_password
  );

  await docker.stopAndRemove(containerName).catch(() => {});

  // Same production env contract as app-creator / rebuildProduction —
  // a respawn must not silently drop the LLM-proxy pair (issue #34).
  const llmEnv = await appLlmEnv.productionLlmEnv(pool, app.id);
  const containerId = await docker.runContainer(containerName, {
    image: imageName,
    env: {
      DATABASE_URL: dbUrl,
      JWT_SECRET: config.jwtSecret,
      PORT: '3000',
      USERNODE_ENV: 'production',
      ...llmEnv,
      ...merge.env,
    },
    port: 3000,
  });

  // Health check is best-effort here — we don't want a slow-starting
  // app to block platform boot. If it fails to come up the operator
  // gets a warning in the logs and the existing /redeploy + drift
  // poller paths will repair it.
  await docker.waitForHealthy(containerName, 3000, '/health').catch((err) => {
    log.warn('app-respawn', 'Container did not become healthy after respawn', {
      slug: app.slug, err: err.message,
    });
  });

  await pool.query(
    'UPDATE apps SET container_id = $1 WHERE id = $2',
    [containerId, app.id]
  );

  log.info('app-respawn', 'App respawned', { slug: app.slug, containerId });
  return containerId;
}

module.exports = { respawnAppContainer };
