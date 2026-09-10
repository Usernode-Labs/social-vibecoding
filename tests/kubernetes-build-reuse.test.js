const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

const digest = (c) => `sha256:${c.repeat(64)}`;
const cfg = { kubernetes: {
  buildNamespace: 'builds', repositoryPrefix: 'registry.test/apps', cacheRepositoryPrefix: 'registry.test/cache',
  builderImage: `registry.test/builder@${digest('a')}`, buildServiceAccount: 'builder', nodeVersion: '22.*', activeDeadlineSeconds: 30,
} };
const app = { id: 12, slug: 'demo', repo_url: 'https://github.com/example/demo' };
const revision = 'b'.repeat(40);
function previous(name = 'previous', finished = '2026-09-10T10:00:00Z') {
  return {
    metadata: { name, namespace: 'builds', labels: {
      'app.kubernetes.io/managed-by': 'social-vibecoding-runtime', 'social.usernode.io/app-id': '12',
    } },
    spec: { builder: { image: cfg.kubernetes.builderImage }, serviceAccountName: 'builder',
      source: { git: { url: app.repo_url, revision: 'c'.repeat(40) } },
      env: [{ name: 'BP_NODE_VERSION', value: '22.*' }, { name: 'NODE_ENV', value: 'production' },
        { name: 'GIT_SHA', value: 'c'.repeat(40) }, { name: 'BPE_OVERRIDE_GIT_SHA', value: 'c'.repeat(40) }],
    },
    status: { conditions: [{ type: 'Succeeded', status: 'True', lastTransitionTime: finished }],
      latestImage: `registry.test/apps/demo@${digest('c')}`, stack: { id: 'stack' } },
  };
}
async function build(pages, { config = cfg, listError = null } = {}) {
  const created = [], lists = [];
  kubernetes._setClientsForTest({ custom: {
    async listNamespacedCustomObject(request) {
      lists.push(request);
      if (listError) throw listError;
      return pages[lists.length - 1];
    },
    async createNamespacedCustomObject(request) { created.push(request.body); },
    async getNamespacedCustomObject() {
      return { status: { conditions: [{ type: 'Succeeded', status: 'True' }],
        latestImage: `registry.test/apps/demo@${digest('d')}` } };
    },
  } });
  const result = await kubernetes.createBuild(config, { app, revision, environment: 'staging', sessionId: 42 });
  return { body: created[0], lists, result };
}
test.afterEach(() => kubernetes._setClientsForTest(null));

test('uses newest compatible successful image across pages, preserving source and output identity', async () => {
  const older = previous('older', '2026-09-09T10:00:00Z');
  older.status.latestImage = `registry.test/apps/demo@${digest('e')}`;
  const newer = previous();
  newer.spec.env.reverse();
  const { body, lists, result } = await build([
    { items: [older], metadata: { continue: 'page2' } }, { items: [newer] },
  ]);
  assert.deepEqual(body.spec.lastBuild, { image: newer.status.latestImage });
  assert.equal(body.spec.source.git.revision, revision);
  assert.match(body.spec.tags[0], new RegExp(`:git-${revision}-[a-f0-9]{12}$`));
  assert.equal(body.spec.cache.registry.tag, 'registry.test/cache/demo:cache');
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.equal(lists[1]._continue, 'page2');
  assert.match(lists[0].labelSelector, /social.usernode.io\/app-id=12/);
  const cold = await build([{ items: [] }]);
  assert.deepEqual(body.spec.tags, cold.body.spec.tags);
  assert.equal(body.metadata.name, cold.body.metadata.name, 'cache discovery must not alter artifact identity');
});

const excluded = {
  failed: (b) => { b.status.conditions[0].status = 'False'; },
  running: (b) => { b.status.conditions[0].status = 'Unknown'; },
  deleting: (b) => { b.metadata.deletionTimestamp = '2026-09-10T10:01:00Z'; },
  owned: (b) => { b.metadata.ownerReferences = [{ kind: 'Image' }]; },
  foreignApp: (b) => { b.metadata.labels['social.usernode.io/app-id'] = '99'; },
  foreignManager: (b) => { b.metadata.labels['app.kubernetes.io/managed-by'] = 'other'; },
  foreignNamespace: (b) => { b.metadata.namespace = 'other'; },
  foreignRepo: (b) => { b.spec.source.git.url = 'https://github.com/other/demo'; },
  foreignImage: (b) => { b.status.latestImage = `registry.test/apps/demo-other@${digest('c')}`; },
  mutableImage: (b) => { b.status.latestImage = 'registry.test/apps/demo:latest'; },
  malformedDigest: (b) => { b.status.latestImage = 'registry.test/apps/demo@sha256:bad'; },
  builderChanged: (b) => { b.spec.builder.image = `registry.test/builder@${digest('e')}`; },
  envChanged: (b) => { b.spec.env.push({ name: 'BP_NODE_RUN_SCRIPTS', value: 'build' }); },
  accountChanged: (b) => { b.spec.serviceAccountName = 'other'; },
  subpath: (b) => { b.spec.source.subPath = 'nested'; },
  binding: (b) => { b.spec.cnbBindings = [{}]; },
  services: (b) => { b.spec.services = [{}]; },
  descriptor: (b) => { b.spec.projectDescriptorPath = 'custom.toml'; },
  unknownCompletion: (b) => { delete b.status.conditions[0].lastTransitionTime; },
};
for (const [reason, change] of Object.entries(excluded)) {
  test(`ignores ${reason} previous build`, async () => {
    const b = previous(); change(b);
    const { body } = await build([{ items: [b] }]);
    assert.equal(body.spec.lastBuild, undefined);
  });
}

test('a partial or failed inventory falls back to a normal build', async () => {
  for (const pages of [[{ items: [previous()], metadata: { continue: 'missing' } }], [{}]]) {
    assert.equal((await build(pages)).body.spec.lastBuild, undefined);
  }
  assert.equal((await build([], { listError: new Error('forbidden') })).body.spec.lastBuild, undefined);
});

test('mutable builders skip previous-image lookup', async () => {
  const { body, lists } = await build([], { config: { kubernetes: { ...cfg.kubernetes, builderImage: 'builder:latest' } } });
  assert.equal(body.spec.lastBuild, undefined);
  assert.equal(lists.length, 0);
});


test('does not select its own existing immutable Build as a previous build', async () => {
  const cold = await build([{ items: [] }]);
  const existing = previous(cold.body.metadata.name);
  assert.equal((await build([{ items: [existing] }])).body.spec.lastBuild, undefined);
});

function exactBuild() {
  const b = previous('other-session');
  b.metadata.labels['social.usernode.io/session-id'] = '99';
  b.spec.source.git.revision = revision;
  for (const entry of b.spec.env) {
    if (['GIT_SHA', 'BPE_OVERRIDE_GIT_SHA'].includes(entry.name)) entry.value = revision;
  }
  return b;
}

test('reuses an exact completed image from another session without creating or changing a Build', async () => {
  const b = exactBuild();
  const before = structuredClone(b);
  const { body, result } = await build([{ items: [previous('newer', '2026-09-11T00:00:00Z'), b] }]);
  assert.equal(body, undefined, 'no new build job');
  assert.equal(result.imageRef, b.status.latestImage);
  assert.equal(result.buildRef, 'builds/other-session');
  assert.equal(result.reused, true);
  assert.deepEqual(result.phases, [], 'do not report the original build duration as current work');
  assert.deepEqual(b, before, 'the owning session keeps its Build unchanged');

});

for (const [reason, change] of Object.entries({
  ...excluded,
  revisionStamp: b => { b.spec.env.find(e => e.name === 'GIT_SHA').value = 'c'.repeat(40); },
  launchStamp: b => { b.spec.env.find(e => e.name === 'BPE_OVERRIDE_GIT_SHA').value = 'c'.repeat(40); },
})) {
  test(`does not skip the build for an exact revision with ${reason}`, async () => {
    const b = exactBuild(); change(b);
    const { body, result } = await build([{ items: [b] }]);
    assert.ok(body, 'a fresh build is required');
    assert.notEqual(result.reused, true);
  });
}


test('concurrent sessions independently reuse the same completed immutable image', async () => {
  const b = exactBuild();
  kubernetes._setClientsForTest({ custom: {
    async listNamespacedCustomObject() { return { items: [b] }; },
    async createNamespacedCustomObject() { assert.fail('must not create a Build'); },
    async deleteNamespacedCustomObject() { assert.fail('must not delete the shared Build'); },
  } });
  const results = await Promise.all([1, 2].map(sessionId => kubernetes.createBuild(cfg, {
    app, revision, environment: 'staging', sessionId,
  })));
  assert.ok(results.every(r => r.reused && r.imageRef === b.status.latestImage));
});
