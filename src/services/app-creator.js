const log = require('./logger');
const github = require('./github');
const docker = require('./docker');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const { getTemplateFiles } = require('./template');
const { getPool } = require('../db/pool');
const { pushAppStatusUpdate } = require('./ws');

async function createApp(config, appRow) {
  const pool = getPool(config);
  const { id: appId, name, slug } = appRow;

  try {
    log.info('app-creator', 'Starting app creation', { appId, slug });

    await updateStatus(pool, appId, 'creating');

    // 1. Create the database for this app
    const dbName = dbManager.appDbName(slug);
    await dbManager.createDatabase(dbName);
    const dbUrl = await dbManager.connectionUrl(dbName);

    // 2. GitHub repo handling
    //    - Import-existing path: appRow.repo_url is preset by the route
    //      after pre-flighting bot access. Skip create+push and just
    //      record useGitHub=true so the clone block below runs.
    //    - New-app path: create a fresh repo under the bot's account and
    //      seed it with the template (existing behavior).
    let repoUrl = appRow.repo_url || null;
    let useGitHub = !!repoUrl;

    if (!repoUrl && github.isEnabled()) {
      try {
        const botUsername = await github.getBotUsername();
        const repo = await github.createRepo(botUsername, slug, {
          description: `${name} — built on Usernode Social Vibecoding`,
        });
        repoUrl = repo.html_url;

        const files = getTemplateFiles(name, slug, dbUrl, config.jwtSecret);
        await github.pushFiles(botUsername, slug, files, {
          message: `Initialize ${name} from Usernode template`,
        });

        await pool.query('UPDATE apps SET repo_url = $1 WHERE id = $2', [repoUrl, appId]);
        useGitHub = true;
      } catch (err) {
        log.warn('app-creator', 'GitHub repo creation failed, falling back to local build', { err: err.message });
      }
    } else if (repoUrl) {
      log.info('app-creator', 'Importing existing repo (skipping create+push)', { appId, slug, repoUrl });
    }

    // 3. Build Docker image
    const containerName = `usernode-app-${slug}`;
    const imageName = `usernode-app-${slug}:latest`;
    const tempDir = `/tmp/usernode-build-${slug}`;
    const fs = require('fs');
    const path = require('path');

    await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});

    if (useGitHub) {
      // For new-app builds the repo lives at <botUsername>/<slug> (the
      // create+push block above just made it). For import-existing the
      // repo lives at whatever owner/name the user pasted, so we parse
      // owner+repo back out of repo_url. parseGithubUrl handles all the
      // URL shapes we accept on the way in, so this round-trip is safe.
      const parsed = github.parseGithubUrl(repoUrl);
      let cloneOwner;
      let cloneRepo;
      if (parsed) {
        cloneOwner = parsed.owner;
        cloneRepo = parsed.repo;
      } else {
        cloneOwner = await github.getBotUsername();
        cloneRepo = slug;
      }
      const cloneUrl = await github.getCloneUrl(cloneOwner, cloneRepo);
      // --recurse-submodules + --shallow-submodules so dapps that vendor
      // upstream sources via submodules (e.g. falling-sands → sandspiel)
      // get a complete tree at build time. No-op for dapps without
      // submodules. Timeout bumped to absorb worst-case submodule fetch.
      await docker.execFileAsync('git', [
        'clone', '--depth', '1',
        '--recurse-submodules', '--shallow-submodules',
        cloneUrl, tempDir,
      ], {
        timeout: 120000,
      });
    } else {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'public'), { recursive: true });

      const files = getTemplateFiles(name, slug, dbUrl, config.jwtSecret);
      for (const f of files) {
        const filePath = path.join(tempDir, f.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, f.content);
      }
    }

    // Snapshot the SHA (if this was a git clone) so the UI can show
    // what commit is live on prod (#21). Local-template builds stay
    // null; that's fine — the pill just hides until the first merge.
    let mainSha = null;
    if (useGitHub) {
      try {
        const { stdout } = await docker.execFileAsync('git', [
          '-C', tempDir, 'rev-parse', 'HEAD',
        ], { timeout: 5000 });
        mainSha = (stdout || '').trim() || null;
      } catch (err) {
        log.warn('app-creator', 'Failed to capture initial SHA', { slug, err: err.message });
      }
    }

    // Read the dapp's `dapp.json` from the cloned working tree, then
    // snapshot it onto the app row so the Secrets API can render the
    // manifest-declared keys without re-cloning. Bail out
    // (without building/running) if any required key is unset — the
    // UI will surface 'awaiting_secrets' so the creator (or app
    // majority) can fill them in, then call POST /api/apps/:slug/redeploy
    // to retry.
    const manifest = appManifest.read(tempDir);
    await pool.query(
      `UPDATE apps SET manifest_snapshot = $1 WHERE id = $2`,
      [JSON.stringify(manifest), appId]
    );

    const storedValues = await appSecrets.getRawValues(pool, appId, config.jwtSecret);
    const merge = appSecrets.mergeForDeploy(
      manifest, storedValues, appSecrets.platformDefaultsFromEnv()
    );
    if (merge.missingRequired.length) {
      log.info('app-creator', 'Required secrets unset; entering awaiting_secrets', {
        appId, slug, missing: merge.missingRequired,
      });
      await pool.query(
        `UPDATE apps SET status = 'awaiting_secrets', repo_url = COALESCE($1, repo_url), main_sha = COALESCE($2, main_sha)
         WHERE id = $3`,
        [repoUrl || null, mainSha || null, appId]
      );
      await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
      pushAppStatusUpdate({
        id: appId, slug, status: 'awaiting_secrets', missingSecrets: merge.missingRequired,
      });
      return;
    }

    await docker.buildImage(tempDir, imageName);
    await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});

    // 4. Remove any existing container with the same name
    await docker.stopAndRemove(containerName).catch(() => {});

    // 5. Run the container
    const containerId = await docker.runContainer(containerName, {
      image: imageName,
      env: {
        DATABASE_URL: dbUrl,
        JWT_SECRET: config.jwtSecret,
        PORT: '3000',
        USERNODE_ENV: 'production',
        ...merge.env,
      },
      port: 3000,
    });

    // 6. Wait for health
    await docker.waitForHealthy(containerName, 3000, '/health');

    // 7. Register Caddy route (may fail in local dev — that's ok)
    const hostname = caddy.productionHostname(slug);
    await caddy.registerRoute(hostname, containerName, 3000).catch((err) => {
      log.warn('app-creator', 'Caddy route registration failed (ok in local dev)', { err: err.message });
    });

    // 8. Determine the app's accessible URL
    // See routes/apps.js for why we don't key off DOCKER_NETWORK anymore.
    const isLocalDev = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';
    let appUrl = `https://${hostname}`;
    if (isLocalDev) {
      const hostPort = await docker.getHostPort(containerName, 3000);
      if (hostPort) appUrl = `http://localhost:${hostPort}`;
    }

    // 9. Update app status
    await pool.query(
      'UPDATE apps SET status = $1, container_id = $2, main_sha = $3 WHERE id = $4',
      ['running', containerId, mainSha || null, appId]
    );

    pushAppStatusUpdate({ id: appId, slug, status: 'running', url: appUrl });
    log.info('app-creator', 'App created successfully', { appId, slug, hostname, appUrl, repoUrl });
  } catch (err) {
    log.error('app-creator', 'App creation failed', { appId, slug, err: err.message });
    await updateStatus(pool, appId, 'error');
    pushAppStatusUpdate({ id: appId, slug, status: 'error' });
  }
}

async function updateStatus(pool, appId, status) {
  await pool.query('UPDATE apps SET status = $1 WHERE id = $2', [status, appId]);
}

module.exports = { createApp };
