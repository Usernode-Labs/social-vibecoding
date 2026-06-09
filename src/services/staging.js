const log = require('./logger');
const docker = require('./docker');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const github = require('./github');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const { getPool } = require('../db/pool');

// Custom error thrown by both staging + prod build paths when the cloned
// repo's `dapp.json` declares required secrets that have no stored value. Callers (votes.js merge path, drift poller, dev-chat
// retries) inspect `.missingSecrets` to render a tailored "fix this"
// toast instead of a generic "build failed".
class MissingSecretsError extends Error {
  constructor(missingSecrets) {
    super(`Cannot deploy: missing required secrets [${missingSecrets.join(', ')}]`);
    this.name = 'MissingSecretsError';
    this.missingSecrets = missingSecrets;
  }
}

// Distinct error for the staging-specific case where a `required + private`
// secret has no manifest-committed `staging_default` (or `default`). Surfaces
// with a different message because the remediation is different from
// MissingSecretsError: the user can't fix this from Settings → Secrets
// (private secrets are *intentionally* not staged from the prod store).
// They have to either commit a `staging_default` to dapp.json or unmark
// the entry private. See app-conventions.md "Public vs private secrets".
class PrivateSecretMissingStagingDefaultError extends Error {
  constructor(missingKeys) {
    super(
      `Cannot stage: required+private secret(s) [${missingKeys.join(', ')}] ` +
      `have no staging fallback. Add a \`staging_default\` (or \`default\`) ` +
      `to each entry in dapp.json, or unmark them private.`
    );
    this.name = 'PrivateSecretMissingStagingDefaultError';
    this.missingKeys = missingKeys;
  }
}

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
    // --recurse-submodules + --shallow-submodules so dapps that vendor
    // upstream sources via submodules (e.g. falling-sands → sandspiel)
    // get a complete tree at build time. No-op for dapps without
    // submodules. Timeout bumped to absorb worst-case submodule fetch.
    await docker.execFileAsync('git', [
      'clone', '--depth', '1',
      '--recurse-submodules', '--shallow-submodules',
      '--branch', session.branch_name, cloneUrl, cloneDir,
    ], { timeout: 120000 });

    // 2. Read the dapp's manifest from the PR branch and check that all
    //    required secrets have stored values. Staging shares the prod
    //    secrets store for *non-private* keys (one set of values per
    //    app, not per env), so a PR introducing a new required key
    //    needs that key set in the app's Settings → Secrets first —
    //    same gate prod uses below.
    //
    //    Private secrets (the staging:private analog for env vars;
    //    see app-conventions.md "Public vs private secrets") are
    //    NOT propagated from the prod store. They resolve from
    //    manifest-committed `staging_default` / `default` only; if
    //    neither is set on a `required + private` entry, we fail
    //    loudly so the operator knows to commit a staging fallback or
    //    unmark private.
    const stagingManifest = appManifest.read(cloneDir);
    const stagingPool = getPool(config);
    const stagingStored = await appSecrets.getRawValues(stagingPool, app.id, config.jwtSecret);
    const stagingMerge = appSecrets.mergeForDeploy(
      stagingManifest, stagingStored, appSecrets.platformDefaultsFromEnv(),
      { forStaging: true }
    );
    if (stagingMerge.missingRequired.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new MissingSecretsError(stagingMerge.missingRequired);
    }
    if (stagingMerge.missingPrivateStagingDefault.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new PrivateSecretMissingStagingDefaultError(
        stagingMerge.missingPrivateStagingDefault
      );
    }

    // 3. Build Docker image
    await docker.buildImage(cloneDir, imageName);
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // 3. Clone the production database. cloneDatabase creates a fresh
    // per-clone postgres role with its own random password — the
    // staging container connects as that ephemeral role, not as the
    // shared superuser. The password lives only in the staging
    // container's DATABASE_URL env (never persisted on the platform);
    // teardown drops the role with the clone DB.
    const prodDbName = dbManager.appDbName(app.slug);
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    const { password: stagingDbPassword } = await dbManager.cloneDatabase(prodDbName, stagingDbNameStr);
    const stagingDbUrl = dbManager.connectionUrl(stagingDbNameStr, stagingDbPassword);

    // 4. Stop existing staging container if any
    if (session.staging_container_id) {
      await docker.stopAndRemove(session.staging_container_id).catch(() => {});
    }

    // 5. Run staging container
    //
    // Forward display-only locators so a fork running self-hosted under its
    // own domain / GitHub org sees correct URLs in its self-app staging
    // preview (otherwise the staging UI falls back to the canonical
    // Usernode-Labs defaults baked into services/caddy.js + config.js).
    //
    // Explicitly NOT forwarded:
    //   - DOCKER_NETWORK: only consumed by docker.js / worker.js when
    //     spawning containers, which staging cannot do anyway (no Docker
    //     socket mount, Phase 2g). Forwarding adds nothing.
    //   - DB_CONTAINER: consumed by db-manager.js to build postgres
    //     `connectionString` URLs. The staging container's own pool uses
    //     DATABASE_URL (set explicitly above) and doesn't need this.
    //     Leaving it unset means db-manager falls back to a stale default
    //     ('project-usernode-db') that doesn't resolve on the prod
    //     network — an accidental defense layer that blocks any code path
    //     inside staging from opening direct pg.Pool connections to other
    //     databases in the prod postgres cluster using the real superuser
    //     password trapped inside DATABASE_URL. Costs nothing to keep
    //     since no legitimate consumer in staging needs the real value.
    //     See SELF-HOSTING.md Phase 5 risks.
    const inheritedEnv = {};
    for (const key of ['USERNODE_DOMAIN', 'USERNODE_PLATFORM_REPO']) {
      if (process.env[key]) inheritedEnv[key] = process.env[key];
    }

    const containerId = await docker.runContainer(containerName, {
      image: imageName,
      env: {
        DATABASE_URL: stagingDbUrl,
        JWT_SECRET: config.jwtSecret,
        PORT: '3000',
        USERNODE_ENV: 'staging',
        ...inheritedEnv,
        ...stagingMerge.env,
      },
      port: 3000,
    });

    // 6. Wait for health
    await docker.waitForHealthy(containerName, 3000, '/health');

    // 7. Determine accessible URL. No Caddy route to register: the
    // wildcard site in the Caddyfile maps this hostname straight to the
    // staging container (usernode-staging-<slug>--<id>) and issues TLS
    // on-demand, so having the container up + named is enough to serve it.
    const hostname = caddy.stagingHostname(app.slug, `s${session.id}`);

    // See routes/apps.js for why we don't key off DOCKER_NETWORK anymore.
    const isLocalDev = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';
    let stagingUrl = `https://${hostname}`;
    if (isLocalDev) {
      const hostPort = await docker.getHostPort(containerName, 3000);
      if (hostPort) stagingUrl = `http://localhost:${hostPort}`;
    }

    // Pre-warm the on-demand TLS cert BEFORE returning, so callers only
    // persist staging_url / emit `staging_ready` (which is what reveals the
    // preview button) once the link actually works. Otherwise the button
    // appears the instant the container is healthy, but the first click hits
    // a cold hostname and hangs ~60-90s on ZeroSSL validation, showing a
    // blank page. The "Building staging preview…" spinner stays up during
    // this wait. Bounded so a slow/failed warm never blocks the deploy: on
    // timeout we proceed anyway and the cert just issues lazily on first hit
    // (the old behavior). No-op in local-dev (http://localhost:<port>).
    if (stagingUrl.startsWith('https://')) {
      log.info('staging', 'Pre-warming TLS cert before exposing preview', { sessionId: session.id, hostname });
      const warm = await caddy.warmCert(hostname);
      if (warm.ok) {
        log.info('staging', 'Cert pre-warmed', { sessionId: session.id, hostname, code: warm.code });
      } else {
        log.warn('staging', 'Cert pre-warm did not complete; preview may be slow on first hit', { sessionId: session.id, hostname, err: warm.error?.message });
      }
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

  // No Caddy route to remove — the wildcard site maps hostnames to
  // container names dynamically, so stopping the container above is what
  // takes the preview offline. The on-demand cert stays cached in Caddy
  // harmlessly; the ask endpoint stops vouching for the host once the
  // caller nulls staging_url.

  // Drop staging database
  if (app) {
    const commitHash = session.staging_url?.match(/--(\w{6})\./)?.[1] || '000000';
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    await dbManager.dropDatabase(stagingDbNameStr).catch(() => {});
  }

  log.info('staging', 'Staging torn down', { sessionId: session.id });
}

// Per-app rebuild serialization. Every prod-rebuild caller (dev-chat
// merge, post-merge sibling sweep, drift poller, manual check-updates,
// issues auto-fix) funnels through rebuildProduction. When two of them
// fire for the SAME app close together — e.g. PR #25 and #26 both
// merging within a minute, each kicking off its own rebuild — their
// `stopAndRemove(name)` / `runContainer(name)` calls interleave and the
// second `docker run` 405s with "container name is already in use"
// (exactly the failure that left whiteboard #26 merged-on-GitHub but
// not-marked-merged). The platform is a single Node process, so an
// in-process promise chain keyed by slug is sufficient: concurrent
// rebuilds of one app run one-at-a-time, each cloning the latest main
// and converging on HEAD. Different apps still rebuild in parallel.
const _rebuildChains = new Map(); // slug -> Promise (rejection-swallowing tail)

function serializeRebuild(slug, fn) {
  const prev = _rebuildChains.get(slug) || Promise.resolve();
  // Run after the predecessor settles, regardless of whether it
  // succeeded — one app's failed rebuild must not block the next one.
  const result = prev.then(() => fn(), () => fn());
  // The stored tail never rejects, so the next waiter's `.then` always
  // runs and an unhandled rejection is never parked on the chain.
  const tail = result.then(() => {}, () => {});
  _rebuildChains.set(slug, tail);
  // Self-clean the map once we're the last link, so idle apps don't leak
  // entries. Guard the identity check so a newer rebuild isn't dropped.
  tail.finally(() => {
    if (_rebuildChains.get(slug) === tail) _rebuildChains.delete(slug);
  });
  return result; // callers still get the real containerId/sha or the real error
}

async function rebuildProduction(config, app) {
  return serializeRebuild(app.slug, () => rebuildProductionInner(config, app));
}

async function rebuildProductionInner(config, app) {
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
  let missingSecretsFromErr = null;

  try {
    const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    const cloneDir = `/tmp/usernode-rebuild-${app.slug}`;

    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    // --recurse-submodules + --shallow-submodules so dapps that vendor
    // upstream sources via submodules (e.g. falling-sands → sandspiel)
    // get a complete tree at build time. No-op for dapps without
    // submodules. Timeout bumped to absorb worst-case submodule fetch.
    await docker.execFileAsync('git', [
      'clone', '--depth', '1',
      '--recurse-submodules', '--shallow-submodules',
      cloneUrl, cloneDir,
    ], { timeout: 120000 });

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

    // Read manifest from the cloned working tree. Snapshot it onto
    // the app row first so the Secrets UI knows about a brand-new
    // required key the moment we observe it (even if the deploy then
    // blocks because that key has no stored value). Then block before
    // docker build if any required secret is unset — no point
    // compiling an image we can't run. The thrown MissingSecretsError
    // carries the list so callers (votes.js merge, drift poller,
    // manual rebuild) can render an actionable error.
    const manifest = appManifest.read(cloneDir);
    const prodPool = getPool(config);
    await prodPool.query(
      `UPDATE apps SET manifest_snapshot = $1 WHERE id = $2`,
      [JSON.stringify(manifest), app.id]
    );
    const stored = await appSecrets.getRawValues(prodPool, app.id, config.jwtSecret);
    const merge = appSecrets.mergeForDeploy(
      manifest, stored, appSecrets.platformDefaultsFromEnv()
    );
    if (merge.missingRequired.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new MissingSecretsError(merge.missingRequired);
    }

    await docker.buildImage(cloneDir, imageName);
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // Stop old container and start new one
    await docker.stopAndRemove(containerName).catch(() => {});

    // Reload the app row to pick up apps.db_password — the per-role
    // migration in db/migrate.js may have populated it after the
    // caller fetched `app`, and createApp may have set it on a
    // first-deploy path that arrives here on the next rebuild.
    const { rows: dbPwdRows } = await prodPool.query(
      'SELECT db_password FROM apps WHERE id = $1', [app.id]
    );
    const appDbPassword = dbPwdRows[0]?.db_password;
    if (!appDbPassword) {
      throw new Error(
        `rebuildProduction: app ${app.slug} has no db_password — ` +
        `migrateAppDbsToPerRole should have populated it at platform boot.`
      );
    }
    const dbUrl = dbManager.connectionUrl(dbManager.appDbName(app.slug), appDbPassword);
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

    await docker.waitForHealthy(containerName, 3000, '/health');

    // No Caddy route to register. The wildcard site in the Caddyfile
    // maps `<slug>.<domain>` straight to this container
    // (usernode-app-<slug>) and issues TLS on-demand, so a healthy,
    // correctly-named container is automatically reachable. This closed
    // the old "Secure Connection Failed" class of bug where a rebuild
    // came up healthy but its per-host route block was missing or got
    // clobbered by a concurrent conf rewrite.

    log.info('staging', 'Production rebuilt', { app: app.slug, sha: mainSha });
    succeeded = true;
    resultSha = mainSha;
    return { containerId, sha: mainSha };
  } catch (err) {
    if (err instanceof MissingSecretsError) {
      missingSecretsFromErr = err.missingSecrets;
      log.warn('staging', 'Production rebuild blocked — missing required secrets', {
        app: app.slug, missing: err.missingSecrets,
      });
    } else {
      log.error('staging', 'Production rebuild failed', { app: app.slug, err: err.message });
    }
    throw err;
  } finally {
    appDeployStatus.markEnd(app.slug, {
      toSha: resultSha,
      failed: !succeeded,
      missingSecrets: missingSecretsFromErr,
    });
  }
}

module.exports = {
  buildAndDeployStaging,
  teardownStaging,
  rebuildProduction,
  MissingSecretsError,
  PrivateSecretMissingStagingDefaultError,
};
