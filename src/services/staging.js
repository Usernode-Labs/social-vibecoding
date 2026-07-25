const log = require('./logger');
const docker = require('./docker');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const github = require('./github');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const appStorageEnv = require('./app-storage-env');
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

// Per-session staging-build serialization + same-commit coalescing.
//
// Staging builds for one session are triggered from several independent
// places — a worker push, the startup/interval recovery sweeper, the
// stale-pending vote kick, the manual deploy button — and nothing used to
// stop two of them running concurrently. The failure mode is nasty
// because a build's slowest step is cloning the prod DB (pg_dump |
// pg_restore, minutes for big apps) and a build BEGINS by dropping any
// prior clone via pg_terminate_backend: build B's teardown kills build
// A's in-flight pg_restore mid-COPY ("server closed the connection
// unexpectedly"), A dies loudly, records a checks 'error', and posts a
// scary ⚠ to the session chat — for a failure that was pure friendly
// fire (session 2258, 2026-07-14). The two builds also share the
// /tmp/usernode-staging-<id> checkout dir, so B's rm -rf could yank A's
// tree mid-build.
//
// Same single-process reasoning as serializeRebuild below: an in-process
// chain keyed by session id is sufficient. Builds for one session run
// one-at-a-time; different sessions still build in parallel. As a bonus,
// a caller requesting the SAME commit as the in-flight/queued build joins
// it and shares the result instead of rebuilding an identical image+clone
// back-to-back ('latest' never coalesces — it can point at different
// content at different times).
const _stagingBuilds = new Map(); // sessionId -> { commitHash, promise, tail }

async function buildAndDeployStaging(config, session, app, commitHash) {
  const key = session.id;
  const current = _stagingBuilds.get(key);
  if (current && commitHash && commitHash !== 'latest' && current.commitHash === commitHash) {
    log.info('staging', 'Joining in-flight staging build for same commit', {
      sessionId: key, commitHash,
    });
    return current.promise;
  }
  const prevTail = current ? current.tail : Promise.resolve();
  // Run after the predecessor settles either way — a failed build must
  // not block the next one (it's often exactly the retry that heals it).
  const promise = prevTail.then(
    () => buildAndDeployStagingInner(config, session, app, commitHash),
    () => buildAndDeployStagingInner(config, session, app, commitHash)
  );
  // The stored tail never rejects, so waiters always run and no unhandled
  // rejection is parked on the chain; callers still get the real result
  // or the real error via `promise`.
  const tail = promise.then(() => {}, () => {});
  const entry = { commitHash, promise, tail };
  _stagingBuilds.set(key, entry);
  tail.then(() => {
    // Self-clean once we're the last link so idle sessions don't leak
    // entries. Identity-guarded so a newer queued build isn't dropped.
    if (_stagingBuilds.get(key) === entry) _stagingBuilds.delete(key);
  });
  return promise;
}

async function buildAndDeployStagingInner(config, session, app, commitHash) {
  const containerName = `usernode-staging-${app.slug}--${session.id}`;
  const imageName = `usernode-staging-${app.slug}-${session.id}:${commitHash.substring(0, 6)}`;

  log.info('staging', 'Building staging', { sessionId: session.id, app: app.slug });

  try {
    // 1. Clone the PR branch
    const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    const cloneDir = `/tmp/usernode-staging-${session.id}`;

    // Whether the caller pinned a concrete commit. 'latest' (and any falsy
    // value) keeps the historical "build the current branch tip" behaviour
    // used by native sessions and the recovery/manual-deploy callers; a real
    // SHA means we must build EXACTLY that commit even if the branch has
    // advanced since it was captured. The image tag and clone-DB name below
    // already key off commitHash, so before this the build could tag one SHA
    // but actually compile the branch tip — harmless while the platform owns
    // the branch, but wrong for an imported PR whose external author keeps
    // pushing (#687). Pinning the checkout closes that gap.
    const pinnedSha = commitHash && commitHash !== 'latest' ? commitHash : null;

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

    // Exact-SHA pin (#687): when a concrete commit was requested, check out
    // exactly that commit. The shallow branch clone above only carries the
    // branch tip, so if the branch has advanced past the pinned SHA the
    // plain checkout fails and we fetch just that commit first (GitHub
    // permits fetching a reachable SHA), then check it out. Detaches HEAD at
    // the pinned commit; a no-op detach when the tip already IS that SHA.
    // Submodules are re-synced to the checked-out commit afterwards (a no-op
    // for dapps without any). Scoped strictly to this checkout step — the
    // rest of the build (secrets gating, DB clone, container run, teardown)
    // is unchanged.
    if (pinnedSha) {
      try {
        await docker.execFileAsync('git', [
          '-C', cloneDir, 'checkout', '--detach', pinnedSha,
        ], { timeout: 30000 });
      } catch {
        await docker.execFileAsync('git', [
          '-C', cloneDir, 'fetch', '--depth', '1', 'origin', pinnedSha,
        ], { timeout: 120000 });
        await docker.execFileAsync('git', [
          '-C', cloneDir, 'checkout', '--detach', pinnedSha,
        ], { timeout: 30000 });
      }
      await docker.execFileAsync('git', [
        '-C', cloneDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1',
      ], { timeout: 120000 }).catch(() => {});
    }

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

    // 4. Stop existing staging container if any. Short grace: a preview
    // being replaced has nothing worth draining (#767).
    if (session.staging_container_id) {
      await docker.stopAndRemove(session.staging_container_id, {
        stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
      }).catch(() => {});
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

    // NOTE: TLS pre-warm intentionally does NOT happen here. Caddy's
    // on-demand `ask` gate (routes/internal.js isKnownHost) only approves a
    // staging host once chat_sessions.staging_url already equals it — and
    // that row is persisted by the *caller*, after this function returns.
    // Warming here would race ahead of the persist, get refused by `ask`,
    // and fail the handshake in milliseconds (leaving the cold-start it was
    // meant to prevent). The caller pre-warms via warmStagingCert() right
    // after persisting staging_url and before revealing the preview button.

    log.info('staging', 'Staging deployed', { sessionId: session.id, url: stagingUrl });

    return { containerId, stagingUrl, hostname };
  } catch (err) {
    log.error('staging', 'Staging build failed', { sessionId: session.id, err: err.message });
    // Cleanup on failure — short grace, this container is being discarded.
    await docker.stopAndRemove(containerName, {
      stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
    }).catch(() => {});
    throw err;
  }
}

// Pre-warm the on-demand TLS cert for a freshly-deployed staging host so a
// real user never lands on a cold hostname (first hit otherwise hangs ~60-90s
// on ZeroSSL validation, showing a blank/black page).
//
// CRITICAL ordering contract: call this only AFTER the session's staging_url
// has been persisted to chat_sessions. Caddy's on-demand `ask` gate
// (routes/internal.js isKnownHost) approves a staging host iff
// chat_sessions.staging_url already equals it. If warmed before the persist,
// `ask` refuses (404), Caddy aborts the TLS handshake, and warmCert fails in
// milliseconds — leaving exactly the cold-start this is meant to prevent.
//
// Bounded by warmCert's internal timeout and always resolves, so a slow/failed
// warm never blocks or fails a deploy (the cert still issues lazily on first
// hit, the old behavior). No-op for local-dev http URLs.
async function warmStagingCert(session, hostname, stagingUrl) {
  if (!hostname || !stagingUrl || !stagingUrl.startsWith('https://')) return;
  log.info('staging', 'Pre-warming TLS cert before exposing preview', { sessionId: session.id, hostname });
  const warm = await caddy.warmCert(hostname);
  if (warm.ok) {
    log.info('staging', 'Cert pre-warmed', { sessionId: session.id, hostname, code: warm.code });
  } else {
    log.warn('staging', 'Cert pre-warm did not complete; preview may be slow on first hit', { sessionId: session.id, hostname, err: warm.error?.message });
  }
}

async function teardownStaging(session, app) {
  log.info('staging', 'Tearing down staging', { sessionId: session.id });

  // Short grace: the preview is going away for good, so there is nothing
  // to drain. Before #767 this step alone cost a flat ~10.9s on every
  // merge, purely waiting out a SIGTERM the container never received.
  if (session.staging_container_id) {
    await docker.stopAndRemove(session.staging_container_id, {
      stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
    }).catch(() => {});
  }

  // Drop staging database. Derive the name from the still-in-memory
  // staging_url *before* we null the column below.
  if (app) {
    const commitHash = session.staging_url?.match(/--(\w{6})\./)?.[1] || '000000';
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    await dbManager.dropDatabase(stagingDbNameStr).catch(() => {});
  }

  // Stop vouching for the now-dead hostname. Caddy's on-demand `ask` gate
  // (routes/internal.js isKnownHost) approves a staging host iff
  // chat_sessions.staging_url still equals it. Leaving it populated after the
  // container is gone makes Caddy keep (re)issuing/renewing certs for a dead
  // upstream and lets stale preview links resolve to a 502 instead of a clean
  // refusal. Nulling it here — the single chokepoint every teardown caller
  // (merge, archive, idle-reclaim) funnels through — frees those certs from
  // renewal churn and makes the gate refuse the host. (No Caddy route to
  // remove: the wildcard site maps hostnames to container names dynamically,
  // so stopping the container is what takes the preview offline; the cached
  // cert expires on its own.)
  await getPool().query(
    `UPDATE chat_sessions SET staging_url = NULL, staging_container_id = NULL WHERE id = $1`,
    [session.id]
  ).catch((err) => log.warn('staging', 'Failed to clear staging_url on teardown', { sessionId: session.id, err: err.message }));

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
  // Hoisted out of the try so the catch can stamp the failed commit
  // onto the apps.last_failure record (#416).
  let mainSha = null;

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
    try {
      await docker.execFileAsync('git', [
        'clone', '--depth', '1',
        '--recurse-submodules', '--shallow-submodules',
        cloneUrl, cloneDir,
      ], { timeout: 120000 });
    } catch (err) {
      // Stage marker for the last_failure classifier (#416).
      err.cloneFailed = true;
      throw err;
    }

    // Capture the exact SHA this build is pinned to so the UI can show
    // what commit is running in production (#21). The shallow clone's
    // HEAD is the tip of the default branch at clone time.
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

    // dapp.json's top-level `name` takes precedence over the platform
    // name. Reconciling here is what makes a merged rename PR (which
    // edits dapp.json's name and triggers this rebuild) actually apply
    // the new display name — no rename-specific apply code needed.
    // No-op when the manifest carries no name; best-effort so a rename
    // hiccup never fails the rebuild.
    await appManifest.reconcileAppName(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Name reconcile failed', { app: app.slug, err: err.message }));
    // Same deal for the manifest's `visibility` block (issue #124): a
    // merged visibility-change PR applies here, on the rebuild its
    // merge triggered. No-op when the manifest carries no visibility;
    // best-effort so it never fails the rebuild.
    await appManifest.reconcileAppVisibility(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Visibility reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `governance` block (issue #646): a merged
    // governance-change PR applies here, on the rebuild its merge
    // triggered. No-op when the block is absent; best-effort.
    await appManifest.reconcileAppGovernance(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Governance reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `screenshot.deviceScaleFactor` (issue #360): a
    // merged PR that toggles the capture density applies here on the
    // rebuild it triggered. readScreenshot defaults to 2×, so this keeps
    // apps.screenshot_device_scale current on every prod rebuild.
    await appManifest.reconcileAppScreenshot(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Screenshot reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `icon` block: a merged PR that changes the
    // homescreen icon (emoji or committed image file) applies here, on
    // the rebuild its merge triggered. The manifest is fully
    // authoritative for the icon — an absent block clears it back to
    // the letter tile. Best-effort; needs cloneDir for the image bytes.
    await appManifest.reconcileAppIcon(prodPool, app, manifest, cloneDir)
      .catch((err) => log.warn('staging', 'Icon reconcile failed', { app: app.slug, err: err.message }));
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
    // Production containers get the LLM-proxy env pair (URL + per-app
    // token); the staging path above deliberately does not — staging
    // containers must not be able to spend LLM grants (issue #34).
    const llmEnv = await appLlmEnv.productionLlmEnv(prodPool, app.id);
    // Likewise the app-storage env pair (#752) — production only; the
    // staging path above deliberately injects neither storage var.
    const storageEnv = await appStorageEnv.productionStorageEnv(prodPool, app.id);
    const containerId = await docker.runContainer(containerName, {
      image: imageName,
      env: {
        DATABASE_URL: dbUrl,
        JWT_SECRET: config.jwtSecret,
        PORT: '3000',
        USERNODE_ENV: 'production',
        ...llmEnv,
        ...storageEnv,
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

    // Clear any stale last_failure (#416): every successful deploy
    // funnels through here, so this is the single reset chokepoint for
    // the rebuild paths (dev-chat merge, drift poller, /redeploy).
    await prodPool.query(
      'UPDATE apps SET last_failure = NULL WHERE id = $1', [app.id]
    ).catch((e) => log.warn('staging', 'Failed to clear last_failure', { app: app.slug, err: e.message }));

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
      // Persist the failure detail (#416) so the "View build log" panel
      // covers failed rebuilds too. Status deliberately stays 'running'
      // (the old container keeps serving) — see app-deploy-status.js for
      // why rebuild progress never touches apps.status. Best-effort.
      const deployFailure = require('./deploy-failure');
      try {
        await getPool(config).query(
          'UPDATE apps SET last_failure = $1 WHERE id = $2',
          [JSON.stringify(deployFailure.record(err, { sha: mainSha || null })), app.id]
        );
      } catch (e) {
        log.warn('staging', 'Failed to persist last_failure', { app: app.slug, err: e.message });
      }
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
  warmStagingCert,
  teardownStaging,
  rebuildProduction,
  MissingSecretsError,
  PrivateSecretMissingStagingDefaultError,
};
