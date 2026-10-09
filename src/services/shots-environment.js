'use strict';

// #2380 — exact-revision, internal-only base/head environments for visual
// shots. Both databases are recreated from one immutable redacted source
// before exploration and before each clean replay pass. No caller receives a
// public hostname and the app is not told which side it is rendering.

const fs = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const applicationRuntime = require('./application-runtime');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const dbManager = require('./db-manager');
const docker = require('./docker');
const github = require('./github');
const log = require('./logger');
const pendingSecrets = require('./pending-secrets');
const stagingEnv = require('./staging-env');
const shotsFixtures = require('./shots-fixtures');
const shotsDemoStates = require('./shots-demo-states');
const { getPool } = require('../db/pool');

const IMAGE_RECIPE = 'v1';
const SHOTS_LABEL = 'social.usernode.io/shots-run';
const SHOTS_SIDE_LABEL = 'social.usernode.io/shots-side';
// Earlier recovery marked cleanup complete without removing hosted fixtures.
const RESOURCE_CLEANUP_VERSION = 2;

class ShotsEnvironmentError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ShotsEnvironmentError';
    this.code = code;
    this.detail = detail;
  }
}

// Promise.all rejects before sibling work settles. That is unsafe for source
// checkouts, image builds, database clones, and deploys because cleanup could
// remove a directory or template while the sibling still uses it.
async function allSettledValues(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

function exactSha(value, label = 'revision') {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ShotsEnvironmentError('invalid_shots_revision', `${label} must be an exact 40-character commit SHA.`);
  }
  return sha;
}

function repoParts(repoUrl) {
  const match = String(repoUrl || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) throw new ShotsEnvironmentError('invalid_shots_repository', 'Before/after shots need an HTTPS GitHub repository.');
  return { owner: match[1], repo: match[2] };
}

function runtimeName(runId, side, kind = 'docker') {
  if (!/^[0-9a-f]{32}$/.test(String(runId || '')) || !['base', 'head'].includes(side)) {
    throw new ShotsEnvironmentError('invalid_shots_runtime', 'Shots runtime identity is invalid.');
  }
  const token = runId.slice(0, 16);
  return kind === 'kubernetes'
    ? `sv-shots-${token}-${side === 'base' ? 'b' : 'h'}`
    : `usernode-shots-${token}-${side}`;
}

// The name a run's runtime had before the rename, when shots were "visual
// evidence". Recovery removes it too, for a run the previous release started.
function legacyRuntimeName(runId, side, kind = 'docker') {
  return runtimeName(runId, side, kind).replace(/^(sv|usernode)-shots-/, '$1-evidence-');
}

function dockerImageName(app, sha) {
  const appId = Number(app?.id);
  if (!Number.isInteger(appId) || appId <= 0) throw new ShotsEnvironmentError('invalid_shots_app', 'Shots app id is invalid.');
  return `usernode-shots-${appId}:${exactSha(sha).slice(0, 16)}-${IMAGE_RECIPE}`;
}

function shotsCapacityEnv(config, app) {
  return app?.slug === config?.selfAppSlug ? { MAX_APPS: '0' } : {};
}

function hostedFixtureApp(runId) {
  return {
    id: shotsFixtures.HOSTED_APP_ID,
    slug: shotsFixtures.hostedAppSlug(runId),
    name: 'Homeroom shots app',
  };
}

function hostedFixtureRefs(config, runId) {
  const app = hostedFixtureApp(runId);
  return [app, { ...app, slug: app.slug.replace(/^homeroom-shots-/, 'homeroom-evidence-') }]
    .map((fixture) => applicationRuntime.productionRef(config, fixture));
}

async function removeRuntime(config, ref, options) {
  const result = await applicationRuntime.remove(config, ref, options);
  // The Docker adapter reports a surviving container instead of rejecting.
  if (result?.removed === false) {
    throw new ShotsEnvironmentError('shots_cleanup_incomplete', result.error || 'Shots runtime is still present.');
  }
  return result;
}

async function hostedFixtureImageRef(config) {
  if (applicationRuntime.mode(config) === 'kubernetes') {
    const imageRef = config?.kubernetes?.captureImage;
    if (!imageRef?.includes('@sha256:')) {
      throw new ShotsEnvironmentError(
        'missing_shots_fixture_image',
        'The hosted-app shots fixture requires the immutable capture image.'
      );
    }
    return imageRef;
  }
  const visuals = require('./visuals');
  await visuals.ensureCaptureImage();
  return visuals.CAPTURE_IMAGE;
}

async function ensureHostedFixtureRuntime(config, pair, { onProgress = null } = {}) {
  const app = hostedFixtureApp(pair.runId);
  const ref = applicationRuntime.productionRef(config, app);
  pair.hostedFixtureRef = ref;
  if (pair.hostedFixtureDeployment
      && await applicationRuntime.probeHealth(config, ref, { timeoutMs: 3_000 })) {
    return pair.hostedFixtureDeployment;
  }
  if (pair.hostedFixtureDeployment) {
    await applicationRuntime.remove(config, ref).catch(() => {});
    pair.hostedFixtureDeployment = null;
  }
  onProgress?.({ stage: 'deploy_hosted_app_fixture' });
  const imageRef = await hostedFixtureImageRef(config);
  const imageDigest = await immutableImageDigest(config, imageRef);
  if (pair.hostedFixtureImageDigest && pair.hostedFixtureImageDigest !== imageDigest) {
    throw new ShotsEnvironmentError(
      'shots_fixture_mismatch',
      'The hosted-app shots fixture image changed during the run.'
    );
  }
  pair.hostedFixtureImageDigest = imageDigest;
  try {
    pair.hostedFixtureDeployment = await applicationRuntime.deploy(config, {
      app,
      environment: 'production',
      sessionId: pair.sessionId,
      imageRef,
      dockerName: ref.runtimeName,
      runtimeName: ref.runtimeName,
      internalOnly: false,
      command: ['node', '/app/shots-hosted-app-fixture.js'],
      env: { NODE_ENV: 'production', PORT: '3000' },
      port: 3000,
      memory: '256m',
      cpus: '0.5',
      labels: {
        [SHOTS_LABEL]: pair.runId,
        [SHOTS_SIDE_LABEL]: 'hosted-app',
      },
    });
    return pair.hostedFixtureDeployment;
  } catch (error) {
    await applicationRuntime.remove(config, ref).catch(() => {});
    throw error;
  }
}

async function git(args, options = {}) {
  return docker.execFileAsync('git', args, { timeout: options.timeout || 120_000, maxBuffer: 4 * 1024 * 1024 });
}

// A shallow clone from GitHub fails now and then for reasons that say
// nothing about the proposal: exit 128 on a reset connection or a GitHub
// 5xx. One failed attempt used to fail the whole run (two runs on
// 2026-09-30, both at 13:22 UTC). Retry a bounded number of times, with a
// pause that gives a brief outage room to pass.
const CLONE_ATTEMPTS = 3;
const CLONE_BACKOFF_MS = Object.freeze([2_000, 6_000]);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function cloneWithRetry(cloneUrl, checkoutDir, {
  attempts = CLONE_ATTEMPTS, backoffMs = CLONE_BACKOFF_MS, wait = sleep,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Submodules stay in the clone even though checkoutExactRevision
      // updates them for the exact revision afterwards: that update is
      // best-effort (a pinned commit a depth-1 fetch cannot reach fails
      // it), and then this copy is the only one the build has.
      await git(['clone', '--depth', '1', '--no-tags', '--recurse-submodules', '--shallow-submodules', cloneUrl, checkoutDir]);
      return;
    } catch (error) {
      lastError = error;
      // A partial clone leaves a directory `git clone` refuses to reuse.
      await fs.rm(checkoutDir, { recursive: true, force: true }).catch(() => {});
      if (attempt < attempts) {
        log.warn('shots', 'Shots checkout clone failed; retrying', {
          attempt, attempts, exitCode: error?.code ?? null,
        });
        await wait(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
      }
    }
  }
  throw lastError;
}

async function checkoutExactRevision({ app, session, sha, side, parentDir }) {
  const revision = exactSha(sha, `${side} SHA`);
  const { owner, repo } = repoParts(app.repo_url);
  const cloneUrl = await github.getCloneUrl(owner, repo);
  const checkoutDir = path.join(parentDir, side);
  await cloneWithRetry(cloneUrl, checkoutDir);

  const refs = [];
  if (side === 'head' && Number(session?.pr_number) > 0) refs.push(`refs/pull/${Number(session.pr_number)}/head`);
  refs.push(revision);
  let checkedOut = false;
  let lastError = null;
  try {
    await git(['-C', checkoutDir, 'checkout', '--detach', revision], { timeout: 30_000 });
    checkedOut = true;
  } catch (err) { lastError = err; }
  for (const ref of refs) {
    if (checkedOut) break;
    try {
      await git(['-C', checkoutDir, 'fetch', '--depth', '1', '--no-tags', 'origin', ref]);
      await git(['-C', checkoutDir, 'checkout', '--detach', revision], { timeout: 30_000 });
      checkedOut = true;
    } catch (err) { lastError = err; }
  }
  if (!checkedOut) {
    throw new ShotsEnvironmentError('shots_revision_unreachable', `Could not check out the exact ${side} revision.`, lastError?.message || null);
  }
  await git(['-C', checkoutDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1']).catch(() => {});
  const { stdout } = await git(['-C', checkoutDir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
  const resolved = String(stdout || '').trim().toLowerCase();
  if (resolved !== revision) {
    throw new ShotsEnvironmentError('shots_revision_mismatch', `${side} checkout resolved to a different commit.`);
  }
  return { side, sha: revision, dir: checkoutDir };
}

async function resolvedStagingEnv(config, pool, session, app, checkoutDir) {
  const manifest = appManifest.read(checkoutDir);
  const stored = await appSecrets.getRawValues(pool, app.id, config.dataEncryptionKey);
  try {
    const held = await pendingSecrets.rawValuesForSession(pool, session.id, config.dataEncryptionKey);
    for (const [key, value] of Object.entries(held || {})) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) stored[key] = value;
    }
  } catch (err) {
    log.warn('shots', 'Pending proposal secrets unavailable for shots environment', {
      sessionId: session.id, error: err.message,
    });
  }
  const merged = appSecrets.mergeForDeploy(
    manifest, stored, appSecrets.platformDefaultsFromEnv(), { forStaging: true }
  );
  if (merged.missingRequired.length || merged.missingPrivateStagingDefault.length) {
    throw new ShotsEnvironmentError(
      'shots_missing_secrets',
      'The paired shots environment cannot start because its exact revision is missing staging-safe variables.',
      {
        missingRequired: merged.missingRequired,
        missingPrivateStagingDefault: merged.missingPrivateStagingDefault,
      }
    );
  }
  return { ...stagingEnv.platformStagingEnv(app, config), ...merged.env };
}

async function immutableImageDigest(config, imageRef) {
  return applicationRuntime.mode(config) === 'docker' ? docker.imageDigest(imageRef) : imageRef;
}

async function buildRevision(config, { app, session, checkout, reuseImageRef = null, onProgress = null }) {
  if (reuseImageRef && session.staging_commit_sha === checkout.sha) {
    const reusable = applicationRuntime.mode(config) !== 'docker' || await docker.imageExists(reuseImageRef);
    if (reusable) {
      return {
        imageRef: reuseImageRef,
        buildRef: session.staging_build_ref || null,
        imageDigest: await immutableImageDigest(config, reuseImageRef),
        reused: true,
      };
    }
  }

  const dockerImage = dockerImageName(app, checkout.sha);
  if (applicationRuntime.mode(config) === 'docker' && await docker.imageExists(dockerImage)) {
    return {
      imageRef: dockerImage, buildRef: null,
      imageDigest: await docker.imageDigest(dockerImage), reused: true,
    };
  }
  const built = await applicationRuntime.build(config, {
    app,
    revision: checkout.sha,
    environment: 'staging',
    sessionId: session.id,
    sourceDir: checkout.dir,
    dockerImage,
    onProgress,
  });
  return {
    ...built,
    imageDigest: await immutableImageDigest(config, built.imageRef),
    reused: !!built.reused,
  };
}

// An image that names no USER runs as root, and the pod's runAsNonRoot
// refuses it before the process starts ("CreateContainerConfigError:
// container has runAsNonRoot and image will run as root"). App Dockerfiles the
// platform writes have declared USER 1000:1000 since #2302, but a proposal's
// BASE side is rebuilt from the commit the proposal started from, which can
// predate an app's own fix; the proposal is sometimes that fix ("... and fix
// Dockerfile", 2026-09-30). The shots copies are disposable, so in exactly
// that case run the image as the conventional app user and take the shots,
// instead of failing the run over a before-side the app has already fixed.
// Every other image keeps its own user.
const ROOT_IMAGE_REJECTION = /runAsNonRoot and image will run as root/;
const SHOTS_FALLBACK_UID = 1000;

async function deployShotsRuntime(config, params, deploy = applicationRuntime.deploy) {
  try {
    return await deploy(config, params);
  } catch (error) {
    const text = [error?.message, error?.terminalPodDetails, error?.containerLogs]
      .filter(Boolean).join('\n');
    if (params.runAsUser != null || !ROOT_IMAGE_REJECTION.test(text)) throw error;
    log.warn('shots', 'Shots runtime image runs as root; starting it as the conventional app user', {
      runtimeName: params.runtimeName || null, uid: SHOTS_FALLBACK_UID,
    });
    return deploy(config, { ...params, runAsUser: SHOTS_FALLBACK_UID });
  }
}

async function preparePair(config, { pool = getPool(config), run, session, app, onProgress = null }) {
  if (!run?.id) throw new ShotsEnvironmentError('invalid_shots_run', 'Shots run is required.');
  const baseSha = exactSha(run.base_sha || run.baseSha, 'base SHA');
  const headSha = exactSha(run.head_sha || run.headSha, 'head SHA');
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `usernode-shots-${run.id.slice(0, 8)}-`));
  let prepared = null;
  const stage = (name) => {
    if (typeof onProgress === 'function') onProgress({ stage: name });
  };
  try {
    stage('checkout_revisions');
    const [baseCheckout, headCheckout] = await allSettledValues([
      checkoutExactRevision({ app, session, sha: baseSha, side: 'base', parentDir: rootDir }),
      checkoutExactRevision({ app, session, sha: headSha, side: 'head', parentDir: rootDir }),
    ]);
    stage('resolve_staging_env');
    const [baseEnv, headEnv] = await allSettledValues([
      resolvedStagingEnv(config, pool, session, app, baseCheckout.dir),
      resolvedStagingEnv(config, pool, session, app, headCheckout.dir),
    ]);
    stage('prepare_fixture');
    const source = await dbManager.prepareStagingCloneSource(
      dbManager.appDbName(app.slug), { sourceId: run.id }
    );
    prepared = source;
    stage('build_revisions');
    const [baseImage, headImage] = await allSettledValues([
      buildRevision(config, { app, session, checkout: baseCheckout, onProgress }),
      buildRevision(config, {
        app, session, checkout: headCheckout,
        reuseImageRef: session.staging_image_ref || null, onProgress,
      }),
    ]);
    const kind = applicationRuntime.mode(config);
    return {
      runId: run.id,
      sessionId: session.id,
      app,
      rootDir,
      preparedSource: source,
      fixtureFingerprint: source.fingerprint,
      fixtureProfileSet: false,
      fixtureProfile: null,
      availableFixtures: [],
      hostedFixtureRef: null,
      hostedFixtureDeployment: null,
      hostedFixtureImageDigest: null,
      sides: {
        base: {
          sha: baseSha, checkout: baseCheckout.dir, env: baseEnv,
          dbName: dbManager.shotsDbName(app.slug, run.id, 'base'),
          runtimeName: runtimeName(run.id, 'base', kind), ...baseImage,
        },
        head: {
          sha: headSha, checkout: headCheckout.dir, env: headEnv,
          dbName: dbManager.shotsDbName(app.slug, run.id, 'head'),
          runtimeName: runtimeName(run.id, 'head', kind), ...headImage,
        },
      },
      deployments: null,
    };
  } catch (err) {
    if (prepared) await dbManager.releasePreparedCloneSource(prepared).catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function runtimeRef(config, pair, side) {
  return { runtimeKind: applicationRuntime.mode(config), runtimeName: pair.sides[side].runtimeName };
}

async function stopPair(config, pair, { strict = false } = {}) {
  const results = await Promise.allSettled(['base', 'head'].map((side) => removeRuntime(
    config, runtimeRef(config, pair, side), { stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC }
  )));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  for (const err of errors) {
    log.warn('shots', 'Shots runtime cleanup failed', {
      runId: pair.runId, error: err.message,
    });
  }
  pair.deployments = null;
  if (strict && errors.length) {
    throw new ShotsEnvironmentError(
      'shots_runtime_reset_failed',
      'The previous before and after builds could not be stopped cleanly.',
      errors.map((err) => err.message).slice(0, 4)
    );
  }
  return { stopped: errors.length === 0, errors };
}

async function resetPair(config, pair, { onProgress = null } = {}) {
  if (!pair?.preparedSource || !pair?.sides) throw new ShotsEnvironmentError('invalid_shots_pair', 'Prepared shots pair is required.');
  await stopPair(config, pair, { strict: true });
  try {
    // Two real shots resets timed out while the clone passes ran together.
    // The ownership/redaction passes scan this app's large schema; serialize
    // them to reduce contention against the same immutable source.
    const clones = [];
    for (const side of ['base', 'head']) {
      onProgress?.({ stage: `clone_${side}` });
      const spec = pair.sides[side];
      const cloned = await dbManager.cloneFromPreparedSource(pair.preparedSource, spec.dbName, {
        onProgress: (phase) => onProgress?.({ stage: `clone_${side}_${phase}` }),
      });
      clones.push([side, cloned]);
    }
    const cloneBySide = Object.fromEntries(clones);
    onProgress?.({ stage: 'deploy_pair' });
    const deployments = await allSettledValues(['base', 'head'].map(async (side) => {
      const spec = pair.sides[side];
      // A production clone can legitimately sit at the platform's app cap.
      // That makes ordinary create-dialog stories unreachable even though
      // the feature works for a member on a server with capacity. Disable
      // only this self-app limit inside disposable shots runtimes; neither
      // production nor an ordinary staging preview receives the override.
      const shotsEnv = shotsCapacityEnv(config, pair.app);
      const deployed = await deployShotsRuntime(config, {
        app: pair.app,
        environment: 'staging',
        sessionId: pair.sessionId,
        imageRef: spec.imageRef,
        dockerName: spec.runtimeName,
        runtimeName: spec.runtimeName,
        internalOnly: true,
        env: {
          DATABASE_URL: dbManager.connectionUrl(spec.dbName, cloneBySide[side].password),
          ...spec.env,
          ...shotsEnv,
        },
        port: 3000,
        memory: docker.STAGING_MEMORY,
        cpus: docker.STAGING_CPUS,
        labels: {
          [SHOTS_LABEL]: pair.runId,
          [SHOTS_SIDE_LABEL]: side,
          [stagingEnv.LABEL_ENV_FP]: stagingEnv.envFingerprint({ ...spec.env, ...shotsEnv }),
        },
      });
      return [side, deployed];
    }));
    pair.deployments = Object.fromEntries(deployments);
    let fixtureProfile = null;
    let availableFixtures = [];
    if (pair.app.slug === config.selfAppSlug) {
      const fixtureProfiles = [];
      // One moment for every row written below, on both sides: read once
      // here, never by either side's own clock (shots-fixtures.pairMoment).
      const at = shotsFixtures.pairMoment();
      const fixtureInputs = Object.fromEntries(['base', 'head'].map((side) => [side, {
        databaseUrl: dbManager.connectionUrl(pair.sides[side].dbName, cloneBySide[side].password),
        slug: pair.app.slug, runId: pair.runId, side, at,
      }]));
      onProgress?.({ stage: 'seed_shots_identities' });
      const admins = await allSettledValues(['base', 'head'].map((side) =>
        shotsFixtures.ensureFullAdminIdentity(fixtureInputs[side])));
      fixtureProfiles.push(shotsFixtures.FULL_ADMIN_PROFILE);
      availableFixtures.push(admins[0]);
      await ensureHostedFixtureRuntime(config, pair, { onProgress });
      onProgress?.({ stage: 'seed_hosted_app_fixture' });
      const hostedApps = await allSettledValues(['base', 'head'].map((side) =>
        shotsFixtures.ensureHostedAppFixture(fixtureInputs[side])));
      fixtureProfiles.push(`${shotsFixtures.HOSTED_APP_PROFILE}@${pair.hostedFixtureImageDigest}`);
      availableFixtures.push(hostedApps[0]);
      onProgress?.({ stage: 'inspect_shots_fixtures' });
      const ready = await allSettledValues(['base', 'head'].map((side) =>
        shotsFixtures.canCopyMemberAgentSession(fixtureInputs[side])));
      // A fixture must exist on BOTH exact revisions. Never insert a state
      // on only one side of a before/after comparison.
      if (ready.every(Boolean)) {
        onProgress?.({ stage: 'seed_shots_fixtures' });
        const seeded = await allSettledValues(['base', 'head'].map((side) =>
          shotsFixtures.copyMemberAgentSession({
            ...fixtureInputs[side], selfAppSlug: config.selfAppSlug,
          })));
        fixtureProfiles.push(shotsFixtures.PROFILE);
        availableFixtures.push(seeded[0]);
        const adminSeeded = await allSettledValues(['base', 'head'].map((side) =>
          shotsFixtures.copyFullAdminAgentSession({
            ...fixtureInputs[side], selfAppSlug: config.selfAppSlug,
          })));
        fixtureProfiles.push(shotsFixtures.FULL_ADMIN_SESSION_PROFILE);
        availableFixtures.push(adminSeeded[0]);
      }
      // The demo states (shots-demo-states.js) a screen needs and these
      // copies cannot reach by themselves. Each goes in only where both
      // revisions can hold it.
      onProgress?.({ stage: 'seed_shots_demo_states' });
      const demoInputs = Object.fromEntries(['base', 'head'].map((side) =>
        [side, { ...fixtureInputs[side], selfAppSlug: config.selfAppSlug }]));
      const demoReady = await allSettledValues(['base', 'head'].map((side) =>
        shotsDemoStates.inspectDemoStates(demoInputs[side])));
      const stateIds = shotsDemoStates.STATE_IDS.filter((id) =>
        demoReady.every((ready) => ready.includes(id)));
      if (stateIds.length) {
        const demo = await shotsDemoStates.installDemoStates(demoInputs, stateIds);
        fixtureProfiles.push(...demo.installed.map((state) => state.id));
        availableFixtures.push(...demo.installed);
        if (demo.skipped.length) {
          log.warn('shots', 'Shots demo states left out of a pair', { runId: pair.runId, skipped: demo.skipped });
        }
      }
      fixtureProfile = fixtureProfiles.join('+');
    }
    if (pair.fixtureProfileSet && pair.fixtureProfile !== fixtureProfile) {
      throw new ShotsEnvironmentError('shots_fixture_mismatch',
        'A paired shots reset changed the available fixture profile.');
    }
    pair.fixtureProfileSet = true;
    pair.fixtureProfile = fixtureProfile;
    pair.availableFixtures = availableFixtures;
    pair.fixtureFingerprint = fixtureProfile
      ? crypto.createHash('sha256').update(`${pair.preparedSource.fingerprint}\n${fixtureProfile}`).digest('hex')
      : pair.preparedSource.fingerprint;
    return {
      origins: {
        base: applicationRuntime.appOrigin(config, pair.deployments.base),
        head: applicationRuntime.appOrigin(config, pair.deployments.head),
      },
      baseSha: pair.sides.base.sha,
      headSha: pair.sides.head.sha,
      fixtureFingerprint: pair.fixtureFingerprint,
      availableFixtures,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    };
  } catch (err) {
    await stopPair(config, pair);
    await Promise.all(['base', 'head'].map((side) => dbManager.dropDatabase(pair.sides[side].dbName, { strict: true }).catch(() => {})));
    throw err;
  }
}

async function cleanupPair(config, pair) {
  if (!pair) return { cleaned: true, errors: [] };
  const errors = [];
  const stopped = await stopPair(config, pair).catch((err) => ({ errors: [err] }));
  errors.push(...(stopped.errors || []));
  if (pair.hostedFixtureRef) {
    await removeRuntime(config, pair.hostedFixtureRef)
      .catch((err) => errors.push(err));
    pair.hostedFixtureDeployment = null;
  }
  for (const side of ['base', 'head']) {
    const dbName = pair.sides?.[side]?.dbName;
    if (dbName) await dbManager.dropDatabase(dbName, { strict: true }).catch((err) => errors.push(err));
  }
  if (pair.preparedSource) {
    await dbManager.releasePreparedCloneSource(pair.preparedSource).catch((err) => errors.push(err));
  }
  if (pair.rootDir) await fs.rm(pair.rootDir, { recursive: true, force: true }).catch((err) => errors.push(err));
  if (errors.length) {
    log.warn('shots', 'Shots pair cleanup completed with leaks to sweep', {
      runId: pair.runId, errors: errors.map((err) => err.message).slice(0, 6),
    });
  }
  return { cleaned: errors.length === 0, errors: errors.map((err) => err.message) };
}

module.exports = {
  IMAGE_RECIPE,
  SHOTS_LABEL,
  SHOTS_SIDE_LABEL,
  RESOURCE_CLEANUP_VERSION,
  ShotsEnvironmentError,
  allSettledValues,
  exactSha,
  repoParts,
  runtimeName,
  legacyRuntimeName,
  dockerImageName,
  shotsCapacityEnv,
  hostedFixtureApp,
  hostedFixtureRefs,
  removeRuntime,
  hostedFixtureImageRef,
  ensureHostedFixtureRuntime,
  CLONE_ATTEMPTS,
  cloneWithRetry,
  SHOTS_FALLBACK_UID,
  deployShotsRuntime,
  checkoutExactRevision,
  resolvedStagingEnv,
  buildRevision,
  preparePair,
  resetPair,
  stopPair,
  cleanupPair,
};
