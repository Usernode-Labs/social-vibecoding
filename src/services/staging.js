const log = require('./logger');
const docker = require('./docker');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const github = require('./github');

// Local-dev URLs are emitted with `localhost` as the host and rewritten to
// whatever hostname the client is actually reaching the platform on. See
// public/js/dev-host.js — this keeps laptop + phone-on-LAN working without
// any env-var config.

async function buildAndDeployStaging(config, session, app, commitHash) {
  const containerName = `usernode-staging-${app.slug}--${session.id}`;
  const imageName = `usernode-staging-${app.slug}-${session.id}:${commitHash.substring(0, 6)}`;

  log.info('staging', 'Building staging', { sessionId: session.id, app: app.slug });

  try {
    // 1. Clone the PR branch
    const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    const cloneDir = `/tmp/usernode-staging-${session.id}`;

    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    await docker.execFileAsync('git', [
      'clone', '--depth', '1', '--branch', session.branch_name, cloneUrl, cloneDir,
    ], { timeout: 60000 });

    // 2. Build Docker image
    await docker.buildImage(cloneDir, imageName);
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // 3. Clone the production database
    const prodDbName = dbManager.appDbName(app.slug);
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    await dbManager.cloneDatabase(prodDbName, stagingDbNameStr);
    const stagingDbUrl = await dbManager.connectionUrl(stagingDbNameStr);

    // 4. Stop existing staging container if any
    if (session.staging_container_id) {
      await docker.stopAndRemove(session.staging_container_id).catch(() => {});
    }

    // 5. Run staging container
    const containerId = await docker.runContainer(containerName, {
      image: imageName,
      env: {
        DATABASE_URL: stagingDbUrl,
        JWT_SECRET: config.jwtSecret,
        PORT: '3000',
      },
      port: 3000,
    });

    // 6. Wait for health
    await docker.waitForHealthy(containerName, 3000, '/health');

    // 7. Register Caddy route + determine accessible URL
    const hostname = caddy.stagingHostname(app.slug, `s${session.id}`, commitHash);
    await caddy.registerRoute(hostname, containerName, 3000).catch(() => {});

    // See routes/apps.js for why we don't key off DOCKER_NETWORK anymore.
    const isLocalDev = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';
    let stagingUrl = `https://${hostname}`;
    if (isLocalDev) {
      const hostPort = await docker.getHostPort(containerName, 3000);
      if (hostPort) stagingUrl = `http://localhost:${hostPort}`;
    }

    log.info('staging', 'Staging deployed', { sessionId: session.id, url: stagingUrl });

    return { containerId, stagingUrl, hostname };
  } catch (err) {
    log.error('staging', 'Staging build failed', { sessionId: session.id, err: err.message });
    // Cleanup on failure
    await docker.stopAndRemove(containerName).catch(() => {});
    throw err;
  }
}

async function teardownStaging(session, app) {
  log.info('staging', 'Tearing down staging', { sessionId: session.id });

  if (session.staging_container_id) {
    await docker.stopAndRemove(session.staging_container_id).catch(() => {});
  }

  // Remove Caddy route
  if (session.staging_url) {
    try {
      const hostname = new URL(session.staging_url).hostname;
      await caddy.removeRoute(hostname);
    } catch {}
  }

  // Drop staging database
  if (app) {
    const commitHash = session.staging_url?.match(/--(\w{6})\./)?.[1] || '000000';
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    await dbManager.dropDatabase(stagingDbNameStr).catch(() => {});
  }

  log.info('staging', 'Staging torn down', { sessionId: session.id });
}

async function rebuildProduction(config, app) {
  const containerName = `usernode-app-${app.slug}`;
  const imageName = `usernode-app-${app.slug}:latest`;

  log.info('staging', 'Rebuilding production', { app: app.slug });

  // Single chokepoint for "this app is being rebuilt right now": every
  // caller (dev-chat merge, drift-poller, manual check-updates) ends up
  // here, so wrapping the body once means the version-pill UI flips to
  // its deploying state regardless of who triggered the rebuild.
  const appDeployStatus = require('./app-deploy-status');
  appDeployStatus.markStart(app.slug, { fromSha: app.main_sha || null });
  let succeeded = false;
  let resultSha = null;

  try {
    const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    const cloneDir = `/tmp/usernode-rebuild-${app.slug}`;

    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    await docker.execFileAsync('git', [
      'clone', '--depth', '1', cloneUrl, cloneDir,
    ], { timeout: 60000 });

    // Capture the exact SHA this build is pinned to so the UI can show
    // what commit is running in production (#21). The shallow clone's
    // HEAD is the tip of the default branch at clone time.
    let mainSha = null;
    try {
      const { stdout } = await docker.execFileAsync('git', [
        '-C', cloneDir, 'rev-parse', 'HEAD',
      ], { timeout: 5000 });
      mainSha = (stdout || '').trim() || null;
    } catch (err) {
      log.warn('staging', 'Failed to capture main SHA', { app: app.slug, err: err.message });
    }

    await docker.buildImage(cloneDir, imageName);
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // Stop old container and start new one
    await docker.stopAndRemove(containerName).catch(() => {});

    const dbUrl = await dbManager.connectionUrl(dbManager.appDbName(app.slug));
    const containerId = await docker.runContainer(containerName, {
      image: imageName,
      env: {
        DATABASE_URL: dbUrl,
        JWT_SECRET: config.jwtSecret,
        PORT: '3000',
      },
      port: 3000,
    });

    await docker.waitForHealthy(containerName, 3000, '/health');

    log.info('staging', 'Production rebuilt', { app: app.slug, sha: mainSha });
    succeeded = true;
    resultSha = mainSha;
    return { containerId, sha: mainSha };
  } catch (err) {
    log.error('staging', 'Production rebuild failed', { app: app.slug, err: err.message });
    throw err;
  } finally {
    appDeployStatus.markEnd(app.slug, { toSha: resultSha, failed: !succeeded });
  }
}

module.exports = { buildAndDeployStaging, teardownStaging, rebuildProduction };
