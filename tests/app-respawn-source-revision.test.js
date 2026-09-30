// A respawn re-runs the image already serving production, so it must keep
// the source-revision label proposal-delivery reads (#3335). Dropping it
// turned every merged proposal on a healed or rolled-over app into
// "delivery unknown" (#3368).
//
// Run with: node --test tests/app-respawn-source-revision.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const LABEL = 'social.usernode.io/source-revision';
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
let fx;

stub(require.resolve('../src/services/logger'), { info() {}, warn() {}, error() {}, debug() {} });
stub(require.resolve('../src/services/docker'), {
  imageId: async (ref) => {
    fx.resolves.push(ref);
    const id = ref === 'usernode-app-demo:latest' ? fx.latestId : null;
    // A build retagging :latest right after the one resolution: the id
    // already read must be what both the check and the deploy use.
    if (fx.retagAfterResolve) fx.latestId = 'sha256:racer';
    return id;
  },
});
stub(require.resolve('../src/services/db-manager'), {
  appDbName: (slug) => `app_${slug}`, connectionUrl: () => 'postgres://x',
});
stub(require.resolve('../src/services/app-secrets'), {
  getRawValues: async () => ({}),
  mergeForDeploy: () => ({ missingRequired: [], env: {} }),
  platformDefaultsFromEnv: () => ({}),
});
stub(require.resolve('../src/services/app-llm-env'), { productionLlmEnv: async () => ({}) });
stub(require.resolve('../src/services/app-storage-env'), { productionStorageEnv: async () => ({}) });
stub(require.resolve('../src/services/app-identity-env'), { appIdentityEnv: () => ({}) });
stub(require.resolve('../src/db/pool'), { getPool: () => ({ query: async () => ({ rows: [] }) }) });
stub(require.resolve('../src/services/application-runtime'), {
  mode: () => fx.mode,
  productionRef: (_config, app) => ({ runtimeKind: fx.mode, runtimeName: `usernode-app-${app.slug}` }),
  inspect: async () => {
    if (fx.inspectError) throw fx.inspectError;
    return fx.live;
  },
  deploy: async (_config, opts) => {
    fx.deploys.push(opts);
    return { runtimeName: 'usernode-app-demo' };
  },
});

const { runExistingImage } = require('../src/services/app-respawn');
const app = { id: 1, slug: 'demo', db_password: 'pw', image_ref: 'registry/demo@sha256:1' };

function reset(over = {}) {
  fx = { mode: 'docker', deploys: [], resolves: [], inspectError: null, latestId: 'sha256:aaa',
    retagAfterResolve: false,
    live: { status: 'running', imageId: 'sha256:aaa', labels: { [LABEL]: SHA } }, ...over };
}

test('a docker respawn keeps the running container’s source revision', async () => {
  reset();
  await runExistingImage({}, app);
  assert.equal(fx.deploys[0].imageRef, 'sha256:aaa', 'the tag is pinned to its id and the id is run');
  assert.deepEqual(fx.deploys[0].labels, { [LABEL]: SHA });
});

test('a retag racing the respawn cannot pair an old label with a new image', async () => {
  reset({ retagAfterResolve: true });
  await runExistingImage({}, app);
  assert.deepEqual(fx.resolves, ['usernode-app-demo:latest'], 'the tag is resolved exactly once');
  assert.equal(fx.deploys[0].imageRef, 'sha256:aaa');
  assert.deepEqual(fx.deploys[0].labels, { [LABEL]: SHA });
});

test('a docker respawn carries nothing when :latest no longer names the running image', async () => {
  // A rebuild retagged :latest and failed before deploying: re-running the
  // tag now ships the NEW image, which the OLD revision cannot vouch for.
  reset({ latestId: 'sha256:bbb' });
  await runExistingImage({}, app);
  assert.equal(fx.deploys[0].imageRef, 'sha256:bbb');
  assert.deepEqual(fx.deploys[0].labels, {});

  reset({ latestId: null });
  await runExistingImage({}, app);
  assert.equal(fx.deploys[0].imageRef, 'usernode-app-demo:latest', 'an unresolvable tag runs as before');
  assert.deepEqual(fx.deploys[0].labels, {});

  for (const over of [{ live: { status: 'running', labels: { [LABEL]: SHA } } }]) {
    reset(over);
    await runExistingImage({}, app);
    assert.deepEqual(fx.deploys[0].labels, {}, 'an unproven image identity carries nothing');
  }
});

test('a kubernetes respawn keeps it only when re-running the same image', async () => {
  reset({ mode: 'kubernetes',
    live: { status: 'running', imageRef: app.image_ref, labels: { [LABEL]: SHA.toUpperCase() } } });
  await runExistingImage({}, app);
  assert.deepEqual(fx.resolves, [], 'a kubernetes digest is already immutable');
  assert.equal(fx.deploys[0].imageRef, app.image_ref);
  assert.deepEqual(fx.deploys[0].labels, { [LABEL]: SHA });

  reset({ mode: 'kubernetes',
    live: { status: 'running', imageRef: 'registry/demo@sha256:other', labels: { [LABEL]: SHA } } });
  await runExistingImage({}, app);
  assert.deepEqual(fx.deploys[0].labels, {}, 'a different image cannot vouch for this one');

  reset({ mode: 'kubernetes', live: { status: 'running', labels: { [LABEL]: SHA } } });
  await runExistingImage({}, app);
  assert.deepEqual(fx.deploys[0].labels, {}, 'an unreported image cannot vouch either');
});

test('no label, a gone container or a failed inspect claims no revision', async () => {
  for (const over of [
    { live: { status: 'running', labels: {} } },
    { live: { status: 'not_found', labels: {} } },
    { live: null },
    { live: { status: 'running', labels: { [LABEL]: 'not-a-sha' } } },
    { inspectError: new Error('daemon down') },
  ]) {
    reset(over);
    await runExistingImage({}, app);
    assert.deepEqual(fx.deploys[0].labels, {});
  }
});
