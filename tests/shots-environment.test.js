'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const environment = require('../src/services/shots-environment');
const runtime = require('../src/services/application-runtime');
const dbManager = require('../src/services/db-manager');
const fixtures = require('../src/services/shots-fixtures');
const demoStates = require('../src/services/shots-demo-states');

test('shots resource names are deterministic, side-specific, and bounded', () => {
  const runId = '0123456789abcdef0123456789abcdef';
  assert.equal(environment.runtimeName(runId, 'base', 'docker'), 'usernode-shots-0123456789abcdef-base');
  assert.equal(environment.runtimeName(runId, 'head', 'kubernetes'), 'sv-shots-0123456789abcdef-h');
  assert.ok(environment.runtimeName(runId, 'base', 'kubernetes').length <= 63);
  assert.notEqual(environment.runtimeName(runId, 'base'), environment.runtimeName(runId, 'head'));
  assert.throws(() => environment.runtimeName(runId, 'other'), /invalid/i);
});

test('shots image tags key the exact revision and recipe', () => {
  const sha = 'a'.repeat(40);
  const tag = environment.dockerImageName({ id: 42 }, sha);
  assert.equal(tag, `usernode-shots-42:${'a'.repeat(16)}-${environment.IMAGE_RECIPE}`);
  assert.throws(() => environment.dockerImageName({ id: 42 }, 'main'), /exact 40-character/);
});

test('only the Homeroom self-app shots runtime bypasses the server app cap', () => {
  const config = { selfAppSlug: 'usernode-2d5619' };
  assert.deepEqual(environment.shotsCapacityEnv(config, { slug: 'usernode-2d5619' }), {
    MAX_APPS: '0',
  });
  assert.deepEqual(environment.shotsCapacityEnv(config, { slug: 'another-app' }), {});
});

test('only Homeroom\'s own pair gets a phone sign-in code, one per pair, six digits', () => {
  const config = { selfAppSlug: 'usernode-2d5619' };
  assert.deepEqual(environment.shotsPhoneSignInEnv(config, { slug: 'usernode-2d5619' }, '048213'), {
    SHOTS_PHONE_TEST_CODE: '048213',
  });
  assert.deepEqual(environment.shotsPhoneSignInEnv(config, { slug: 'another-app' }, '048213'), {},
    'a child app has no phone sign-in');
  for (const bad of [null, '', '4821', 'abcdef', '1234567']) {
    assert.deepEqual(environment.shotsPhoneSignInEnv(config, { slug: 'usernode-2d5619' }, bad), {}, String(bad));
  }
  const pair = { app: { slug: 'usernode-2d5619' } };
  const code = environment.pairPhoneTestCode(config, pair);
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(environment.pairPhoneTestCode(config, pair), code, 'every reset of the pair keeps it');
  assert.equal(pair.phoneTestCode, code);
  assert.equal(environment.pairPhoneTestCode(config, { app: { slug: 'another-app' } }), null);
  const codes = new Set(Array.from({ length: 20 }, () =>
    environment.pairPhoneTestCode(config, { app: { slug: 'usernode-2d5619' } })));
  assert.ok(codes.size > 1, 'each pair makes its own');
});

test('an ordinary staging preview is never given the phone code, and no dapp.json can give it one', () => {
  const appManifest = require('../src/services/app-manifest');
  const appSecrets = require('../src/services/app-secrets');
  const stagingEnv = require('../src/services/staging-env');
  // The platform-owned half of every preview's env (staging.js) carries none.
  assert.equal('SHOTS_PHONE_TEST_CODE' in stagingEnv.platformStagingEnv({ id: 1 }, {}), false);
  // A manifest declaring it, with a default, is refused like every reserved
  // key, so the merged env a preview (or a shots side) starts from has none.
  assert.ok(appManifest.RESERVED_KEYS.has('SHOTS_PHONE_TEST_CODE'));
  const secrets = appManifest.readSecrets({
    secrets: [{ key: 'SHOTS_PHONE_TEST_CODE', default: '123456' }, { key: 'OTHER', default: 'x' }],
  });
  assert.deepEqual(secrets.map((entry) => entry.key), ['OTHER']);
  const merged = appSecrets.mergeForDeploy({ secrets }, {}, {}, { forStaging: true });
  assert.equal('SHOTS_PHONE_TEST_CODE' in merged.env, false);
});

test('only canonical HTTPS GitHub repositories are accepted', () => {
  assert.deepEqual(environment.repoParts('https://github.com/Usernode-Labs/example.git'), {
    owner: 'Usernode-Labs', repo: 'example',
  });
  assert.throws(() => environment.repoParts('git@github.com:owner/repo.git'), /HTTPS GitHub/);
  assert.throws(() => environment.repoParts('https://example.com/owner/repo'), /HTTPS GitHub/);
});

test('parallel cleanup waits for every sibling before surfacing a failure', async () => {
  const order = [];
  let release;
  const slow = new Promise((resolve) => { release = () => { order.push('slow'); resolve('ok'); }; });
  const pending = environment.allSettledValues([
    slow,
    Promise.reject(new Error('boom')),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await assert.rejects(pending, /boom/);
  assert.deepEqual(order, ['slow']);
});

test('each paired reset serializes clones and adds the same member and full-admin fixtures to both revisions', async () => {
  const original = {
    remove: runtime.remove, deploy: runtime.deploy, appOrigin: runtime.appOrigin,
    clone: dbManager.cloneFromPreparedSource, connectionUrl: dbManager.connectionUrl,
    fullAdmin: fixtures.ensureFullAdminIdentity,
    hostedApp: fixtures.ensureHostedAppFixture,
    inspect: fixtures.canCopyMemberAgentSession, copy: fixtures.copyMemberAgentSession,
    copyAdmin: fixtures.copyFullAdminAgentSession,
    inspectDemo: demoStates.inspectDemoStates, installDemo: demoStates.installDemoStates,
  };
  const runId = '2'.repeat(32);
  const slug = 'usernode-2d5619';
  const pair = {
    app: { slug }, runId, sessionId: 42,
    preparedSource: { fingerprint: 'source-fingerprint' },
    sides: Object.fromEntries(['base', 'head'].map((side) => [side, {
      dbName: dbManager.shotsDbName(slug, runId, side), runtimeName: `shots-${side}`,
      sha: side === 'base' ? 'a'.repeat(40) : 'b'.repeat(40),
      imageRef: `image-${side}`, imageDigest: `digest-${side}`, env: {},
    }])),
  };
  const order = [];
  const deployedEnvs = [];
  const deployedLabels = [];
  let cloneActive = false;
  try {
    runtime.remove = async () => {};
    runtime.deploy = async (_config, spec) => {
      deployedEnvs.push(spec.env);
      deployedLabels.push(spec.labels);
      return { runtimeName: spec.runtimeName };
    };
    runtime.appOrigin = (_config, deployment) => `http://${deployment.runtimeName}`;
    dbManager.cloneFromPreparedSource = async (_source, dbName, { onProgress }) => {
      assert.equal(cloneActive, false, 'the next clone must wait for the prior redaction pass');
      cloneActive = true;
      order.push(dbName);
      onProgress('copy_template');
      await new Promise((resolve) => setImmediate(resolve));
      onProgress('scrub_private');
      cloneActive = false;
      return { password: 'disposable' };
    };
    dbManager.connectionUrl = (dbName) => `postgres://fixture@db/${dbName}`;
    // Every writer is handed the pair's one moment, the same on both sides.
    const moments = [];
    fixtures.ensureFullAdminIdentity = async ({ side, at }) => (moments.push(['admin', side, at]), {
      id: fixtures.FULL_ADMIN_PROFILE, persona: 'full_admin', path: '/#admin/users',
      appMembership: { appId: 42, slug, status: 'member' }, side,
    });
    fixtures.canCopyMemberAgentSession = async () => true;
    fixtures.ensureHostedAppFixture = async ({ side, at }) => (moments.push(['hosted', side, at]), {
      id: fixtures.HOSTED_APP_PROFILE, persona: 'member', startPath: '/#apps',
      path: `/app/${fixtures.hostedAppSlug(runId)}`,
      appSlug: fixtures.hostedAppSlug(runId),
    });
    fixtures.copyMemberAgentSession = async ({ side, at }) => (moments.push(['member', side, at]), { id: fixtures.PROFILE,
      persona: 'member', path: '/#messages/agent/990899', side });
    const adminSides = [];
    fixtures.copyFullAdminAgentSession = async ({ side, at }) => {
      adminSides.push(side);
      moments.push(['admin-session', side, at]);
      return { id: fixtures.FULL_ADMIN_SESSION_PROFILE, persona: 'full_admin', path: '/#messages/agent/990897', side };
    };
    // Each side can hold some demo states; only those BOTH can hold are
    // written, and both sides are written together.
    const [runs, preview, list] = demoStates.STATE_IDS;
    demoStates.inspectDemoStates = async ({ side }) => (side === 'base' ? [runs, preview, list] : [list, runs]);
    const demoCalls = [];
    demoStates.installDemoStates = async (inputs, stateIds) => {
      demoCalls.push({ sides: Object.keys(inputs), dbs: [inputs.base.databaseUrl, inputs.head.databaseUrl], stateIds });
      moments.push(['demo', 'base', inputs.base.at], ['demo', 'head', inputs.head.at]);
      return {
        installed: stateIds.map((id) => ({ id, persona: 'member', shows: [{ state: id, path: '/#messages' }] })),
        skipped: [],
      };
    };
    const progress = [];
    const captureDigest = `capture@sha256:${'c'.repeat(64)}`;
    const deployment = await environment.resetPair({
      selfAppSlug: slug,
      appRuntime: 'kubernetes',
      kubernetes: { captureImage: captureDigest, appDomain: 'apps.example.invalid', platformDomain: 'example.invalid' },
    }, pair,
      { onProgress: (event) => progress.push(event.stage) });
    assert.deepEqual(order, [pair.sides.base.dbName, pair.sides.head.dbName]);
    assert.equal(moments.length, 10);
    assert.equal(new Set(moments.map(([, , at]) => at)).size, 1, 'one moment, read once per reset');
    assert.equal(moments[0][2], new Date(Date.parse(moments[0][2])).toISOString());
    assert.deepEqual(progress.slice(0, 6), [
      'clone_base', 'clone_base_copy_template', 'clone_base_scrub_private',
      'clone_head', 'clone_head_copy_template', 'clone_head_scrub_private',
    ]);
    assert.deepEqual(demoCalls, [{
      sides: ['base', 'head'],
      dbs: [`postgres://fixture@db/${pair.sides.base.dbName}`, `postgres://fixture@db/${pair.sides.head.dbName}`],
      stateIds: [runs, list],
    }]);
    assert.deepEqual(deployment.availableFixtures.slice(4).map((fixture) => fixture.id), [runs, list]);
    assert.ok(progress.includes('seed_shots_demo_states'));
    assert.equal(deployment.availableFixtures.length, 6);
    assert.equal(deployment.availableFixtures[0].persona, 'full_admin');
    assert.deepEqual(deployment.availableFixtures[0].appMembership,
      { appId: 42, slug, status: 'member' });
    assert.equal(deployment.availableFixtures[1].appSlug, fixtures.hostedAppSlug(runId));
    assert.equal(deployment.availableFixtures[2].persona, 'member');
    // The full admin gets an agent session too, on both revisions, so a list
    // drawn only for a viewer with sessions is there before as well as after.
    assert.equal(deployment.availableFixtures[3].id, fixtures.FULL_ADMIN_SESSION_PROFILE);
    assert.deepEqual(adminSides.sort(), ['base', 'head']);
    const pairedEnvs = deployedEnvs.filter((env) => env.DATABASE_URL);
    assert.equal(pairedEnvs.length, 2);
    assert.ok(pairedEnvs.every((env) => env.MAX_APPS === '0'));
    // Phone sign-in's test numbers: one random code, the same on both sides,
    // handed on for the brief and kept out of the env fingerprint label.
    const [baseCode, headCode] = pairedEnvs.map((env) => env.SHOTS_PHONE_TEST_CODE);
    assert.match(baseCode, /^[0-9]{6}$/);
    assert.equal(headCode, baseCode, 'the same code on both sides of the pair');
    assert.equal(deployment.phoneTestCode, baseCode);
    assert.equal(pair.phoneTestCode, baseCode, 'kept on the pair for a later reset');
    const stagingEnv = require('../src/services/staging-env');
    const pairedLabels = deployedLabels.filter((labels) => labels?.[environment.SHOTS_SIDE_LABEL] !== 'hosted-app');
    assert.equal(pairedLabels.length, 2);
    for (const labels of pairedLabels) {
      assert.equal(labels[stagingEnv.LABEL_ENV_FP], stagingEnv.envFingerprint({ MAX_APPS: '0' }),
        'the label describes the env without the code');
    }
    assert.ok(progress.includes('seed_shots_identities'));
    assert.ok(progress.includes('deploy_hosted_app_fixture'));
    assert.ok(progress.includes('seed_hosted_app_fixture'));
    assert.equal(deployment.fixtureFingerprint, crypto.createHash('sha256')
      .update(`source-fingerprint\n${fixtures.FULL_ADMIN_PROFILE}`
        + `+${fixtures.HOSTED_APP_PROFILE}@${captureDigest}+${fixtures.PROFILE}+${fixtures.FULL_ADMIN_SESSION_PROFILE}`
        + `+${runs}+${list}`).digest('hex'));
  } finally {
    runtime.remove = original.remove;
    runtime.deploy = original.deploy;
    runtime.appOrigin = original.appOrigin;
    dbManager.cloneFromPreparedSource = original.clone;
    dbManager.connectionUrl = original.connectionUrl;
    fixtures.ensureFullAdminIdentity = original.fullAdmin;
    fixtures.ensureHostedAppFixture = original.hostedApp;
    fixtures.canCopyMemberAgentSession = original.inspect;
    fixtures.copyMemberAgentSession = original.copy;
    demoStates.inspectDemoStates = original.inspectDemo;
    demoStates.installDemoStates = original.installDemo;
    fixtures.copyFullAdminAgentSession = original.copyAdmin;
  }
});

test('a child app\'s pair gets no phone sign-in code', async () => {
  const original = {
    remove: runtime.remove, deploy: runtime.deploy, appOrigin: runtime.appOrigin,
    clone: dbManager.cloneFromPreparedSource, connectionUrl: dbManager.connectionUrl,
  };
  const runId = '3'.repeat(32);
  const slug = 'family-chores';
  const pair = {
    app: { slug }, runId, sessionId: 43,
    preparedSource: { fingerprint: 'source-fingerprint' },
    sides: Object.fromEntries(['base', 'head'].map((side) => [side, {
      dbName: dbManager.shotsDbName(slug, runId, side), runtimeName: `shots-${side}`,
      sha: side === 'base' ? 'a'.repeat(40) : 'b'.repeat(40),
      imageRef: `image-${side}`, imageDigest: `digest-${side}`, env: { USERNODE_ENV: 'staging' },
    }])),
  };
  const deployedEnvs = [];
  try {
    runtime.remove = async () => {};
    runtime.deploy = async (_config, spec) => {
      deployedEnvs.push(spec.env);
      return { runtimeName: spec.runtimeName };
    };
    runtime.appOrigin = (_config, deployment) => `http://${deployment.runtimeName}`;
    dbManager.cloneFromPreparedSource = async () => ({ password: 'disposable' });
    dbManager.connectionUrl = (dbName) => `postgres://fixture@db/${dbName}`;
    const deployment = await environment.resetPair({ selfAppSlug: 'usernode-2d5619' }, pair);
    assert.equal(deployedEnvs.length, 2);
    assert.ok(deployedEnvs.every((env) => !('SHOTS_PHONE_TEST_CODE' in env) && !('MAX_APPS' in env)));
    assert.equal(deployment.phoneTestCode, null);
    assert.equal('phoneTestCode' in pair, false);
  } finally {
    runtime.remove = original.remove;
    runtime.deploy = original.deploy;
    runtime.appOrigin = original.appOrigin;
    dbManager.cloneFromPreparedSource = original.clone;
    dbManager.connectionUrl = original.connectionUrl;
  }
});

test('paired cleanup removes the hosted app runtime with both exact revisions', async () => {
  const original = {
    remove: runtime.remove,
    drop: dbManager.dropDatabase,
    release: dbManager.releasePreparedCloneSource,
  };
  const removed = [];
  try {
    runtime.remove = async (_config, ref) => { removed.push(ref.runtimeName); };
    dbManager.dropDatabase = async () => {};
    dbManager.releasePreparedCloneSource = async () => {};
    const pair = {
      runId: 'f'.repeat(32),
      sides: {
        base: { runtimeName: 'shots-base', dbName: 'fixture-base' },
        head: { runtimeName: 'shots-head', dbName: 'fixture-head' },
      },
      hostedFixtureRef: { runtimeKind: 'kubernetes', runtimeName: 'shots-hosted-app' },
      hostedFixtureDeployment: { runtimeName: 'shots-hosted-app' },
      preparedSource: { fingerprint: 'fixture' },
    };
    const result = await environment.cleanupPair({ appRuntime: 'kubernetes' }, pair);
    assert.equal(result.cleaned, true);
    assert.deepEqual(removed.sort(), [
      'shots-base', 'shots-head', 'shots-hosted-app',
    ]);
    assert.equal(pair.hostedFixtureDeployment, null);
  } finally {
    runtime.remove = original.remove;
    dbManager.dropDatabase = original.drop;
    dbManager.releasePreparedCloneSource = original.release;
  }
});

test('a failed checkout clone is retried from a clean directory, a bounded number of times', async (t) => {
  const docker = require('../src/services/docker');
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const pathMod = require('node:path');
  const saved = docker.execFileAsync;
  t.after(() => { docker.execFileAsync = saved; });
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'shots-clone-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const target = pathMod.join(dir, 'base');

  // Fails twice, leaving a partial directory each time, then succeeds.
  let calls = 0;
  const seen = [];
  docker.execFileAsync = async (cmd, args) => {
    calls += 1;
    seen.push({ cmd, args, existed: await fsp.stat(target).then(() => true, () => false) });
    if (calls < 3) {
      await fsp.mkdir(target, { recursive: true });
      await fsp.writeFile(pathMod.join(target, 'partial'), 'x');
      throw Object.assign(new Error('Command failed: git clone'), { code: 128 });
    }
    return { stdout: '', stderr: '' };
  };
  const waits = [];
  await environment.cloneWithRetry('https://github.com/o/r.git', target, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(calls, 3);
  assert.deepEqual(seen.map((s) => s.existed), [false, false, false], 'each attempt starts from no directory');
  assert.deepEqual(waits, [2000, 6000]);
  assert.deepEqual(seen[0].args.slice(0, 6),
    ['clone', '--depth', '1', '--no-tags', '--recurse-submodules', '--shallow-submodules'],
    'the clone itself is unchanged');

  // Out of attempts: the last error surfaces, so the run still fails loudly.
  calls = 0;
  docker.execFileAsync = async () => { calls += 1; throw Object.assign(new Error('still down'), { code: 128 }); };
  await assert.rejects(environment.cloneWithRetry('https://github.com/o/r.git', target, { wait: async () => {} }),
    /still down/);
  assert.equal(calls, environment.CLONE_ATTEMPTS);

  const src = require('node:fs').readFileSync(pathMod.join(__dirname, '../src/services/shots-environment.js'), 'utf8');
  assert.match(src, /const checkoutDir = path\.join\(parentDir, side\);\n  await cloneWithRetry\(cloneUrl, checkoutDir\);/,
    'the exact-revision checkout clones through the retry');
});

test('a before-side image that runs as root is started as the conventional app user, and only then', async () => {
  const rejection = Object.assign(
    new Error('Deployment social-apps/sv-shots-635f26f930d88a1f-b cannot start: app: CreateContainerConfigError: container has runAsNonRoot and image will run as root'),
    { terminalPodFailure: true }
  );
  const calls = [];
  const deploy = async (_config, params) => {
    calls.push(params);
    if (params.runAsUser == null) throw rejection;
    return { runtimeName: params.runtimeName };
  };
  const params = { runtimeName: 'sv-shots-635f26f930d88a1f-b', imageRef: 'x@sha256:1' };
  const deployed = await environment.deployShotsRuntime({}, params, deploy);
  assert.deepEqual(deployed, { runtimeName: params.runtimeName });
  assert.deepEqual(calls.map((c) => c.runAsUser), [undefined, environment.SHOTS_FALLBACK_UID]);
  assert.equal(environment.SHOTS_FALLBACK_UID, 1000, 'the uid app Dockerfiles declare (USER 1000:1000)');

  // Any other failure is the run's real failure: no second attempt.
  const other = new Error('Deployment social-apps/x cannot start: app: CrashLoopBackOff');
  let tries = 0;
  await assert.rejects(environment.deployShotsRuntime({}, params, async () => { tries += 1; throw other; }), other);
  assert.equal(tries, 1);

  // The fallback is tried once: if uid 1000 is also refused, that error stands.
  let attempts = 0;
  const still = new Error('container has runAsNonRoot and image will run as root');
  await assert.rejects(environment.deployShotsRuntime({}, params, async () => { attempts += 1; throw still; }), still);
  assert.equal(attempts, 2);

  // The rejection can arrive in the pod details rather than the message.
  const detailed = Object.assign(new Error('Deployment social-apps/x cannot start'), {
    terminalPodDetails: 'app: CreateContainerConfigError: container has runAsNonRoot and image will run as root',
  });
  const seen = [];
  await environment.deployShotsRuntime({}, params, async (_c, p) => {
    seen.push(p.runAsUser);
    if (p.runAsUser == null) throw detailed;
    return {};
  });
  assert.deepEqual(seen, [undefined, 1000]);

  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/services/shots-environment.js'), 'utf8');
  assert.match(src, /const deployed = await deployShotsRuntime\(config, \{/, 'both shots sides deploy through the fallback');
  assert.doesNotMatch(src, /await applicationRuntime\.deploy\(config, \{\n\s+app: pair\.app,/);
});
