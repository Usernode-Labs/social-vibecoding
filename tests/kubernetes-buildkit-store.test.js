'use strict';

// The kept store for preview image builds (src/services/kubernetes-buildkit.js,
// BUILDKIT_PREVIEW_STORES): which builds may use it, what their Job carries,
// what the platform does when a store Job's Pod cannot start, and the Pod's
// script itself, run here with a stand-in for the BuildKit daemon.
//
// What these cannot cover is the cluster: a real claim, the kubelet's fsGroup
// handling, scheduling against a node-local volume. docs/kubernetes-operations.md
// ("Kept store for preview image builds") says what an operator checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const buildkit = require('../src/services/kubernetes-buildkit');
const kubernetes = require('../src/services/kubernetes');

const {
  BUILD_SCRIPT, STORE_BUILD_SCRIPT, STORE_LABEL, STORE_UNAVAILABLE_MEMO_MS, storeLimits,
  jobManifest, recipeOf, parsePreviewStores, previewStore, storeStartVerdict,
} = buildkit._forTest;

const digest = (c) => `sha256:${c.repeat(64)}`;
const revision = 'b'.repeat(40);
const app = { id: 12, slug: 'demo', repo_url: 'https://github.com/example/demo' };
const STORES = 'demo=bk-store-demo';

function config(overrides = {}) {
  return { kubernetes: {
    repositoryPrefix: 'registry.test/apps', cacheRepositoryPrefix: 'registry.test/cache',
    activeDeadlineSeconds: 30,
    buildEngine: 'auto', buildkitNamespace: 'bk', buildkitServiceAccount: 'bk-builder',
    buildkitImage: `docker.io/moby/buildkit:v0.33.0-rootless@${digest('f')}`, buildkitMode: 'rootless',
    buildkitRegistrySecret: '', buildkitInsecureRegistry: false,
    buildkitDockerfiles: ['Dockerfile.kubernetes', 'Dockerfile'], buildkitSuccessRetentionHours: 48,
    ...overrides,
  } };
}

const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-store-src-'));
fs.writeFileSync(path.join(sourceDir, 'Dockerfile.kubernetes'), 'FROM scratch\n');
test.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));

function runtimeWith(clients) {
  return {
    getClients: () => clients,
    clientsLogApi: (c) => c.logs || null,
    attachLineObserver: kubernetes._attachLineObserverForTest,
    labels: kubernetes.labels,
    dnsName: kubernetes.dnsName,
    withSuffix: kubernetes.withSuffix,
    isNotFound: (err) => err?.code === 404,
    deleteIfPresent: async (api, method, name, namespace, options = {}) => {
      try { await api[method]({ name, namespace, ...options }); } catch (err) { if (err?.code !== 404) throw err; }
    },
    collectPodDiagnostics: async () => ({ logs: 'step failed', details: 'Exit 1', deadlineExceeded: false }),
    boundedText: (text) => String(text || '').slice(0, 65536),
    getCloneUrl: async (owner, name) => `https://github.com/${owner}/${name}.git`,
  };
}

const startedPod = () => ({
  metadata: { name: 'bk-pod', creationTimestamp: '2026-10-08T10:00:00Z' },
  spec: { nodeName: 'worker-3' },
  status: { containerStatuses: [{ name: 'buildkit', state: { terminated: { exitCode: 0, message: digest('d') } } }] },
});
const unschedulablePod = (message = '0/4 nodes are available: persistentvolumeclaim "bk-store-demo" not found.') => ({
  metadata: { name: 'bk-pod', creationTimestamp: '2026-10-08T10:00:00Z' },
  spec: {},
  status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message }] },
});

// A batch/core pair that keeps the Jobs it is given and filters lists by the
// equality terms of the selector, as the API server does. `podFor(job)` says
// what that Job's Pod looks like; `statusFor(job, reads)` what the Job reports.
function fakeCluster({ existingJobs = [], podFor = () => startedPod(), statusFor = null } = {}) {
  const state = { jobs: [], secrets: [], deleted: [], lists: [], patches: [] };
  const reads = new Map();
  const matches = (job, selector) => String(selector || '').split(',').filter(Boolean).every((term) => {
    const [key, value] = term.split('=');
    return String(job.metadata?.labels?.[key]) === value;
  });
  const done = { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] };
  const batch = {
    async listNamespacedJob(request) {
      state.lists.push(request.labelSelector);
      return { items: [...existingJobs, ...state.jobs.filter((j) => !state.deleted.includes(j.metadata.name))].filter((job) => matches(job, request.labelSelector)) };
    },
    async createNamespacedJob({ body }) {
      state.jobs.push(body);
      return { metadata: { ...body.metadata, uid: `uid-${state.jobs.length}` } };
    },
    async readNamespacedJob({ name }) {
      const job = state.jobs.find((j) => j.metadata.name === name);
      const n = reads.get(name) || 0;
      reads.set(name, n + 1);
      const status = statusFor ? statusFor(job, n) : (n === 0 ? { active: 1 } : done);
      return { metadata: { name, namespace: 'bk' }, status };
    },
    async patchNamespacedJob(request) { state.patches.push(request); },
    async deleteNamespacedJob({ name }) { state.deleted.push(name); },
  };
  const jobOfPodQuery = (labelSelector) => state.jobs.find((j) => `job-name=${j.metadata.name}` === labelSelector);
  const core = {
    async createNamespacedSecret({ body }) { state.secrets.push(body); },
    async readNamespacedSecret({ name }) { return { metadata: { name }, stringData: {} }; },
    async replaceNamespacedSecret() {},
    async deleteNamespacedSecret() {},
    async listNamespacedPod({ labelSelector }) { return { items: [podFor(jobOfPodQuery(labelSelector))] }; },
  };
  const logs = { async log(_ns, _pod, _container, sink) { sink.end(); return { abort() {} }; } };
  return { clients: { batch, core, logs }, state };
}

const claimOf = (job) => job.spec.template.spec.volumes.find((v) => v.persistentVolumeClaim)?.persistentVolumeClaim.claimName || null;
const preview = { app, revision, environment: 'staging', sessionId: 42, sourceDir };
const savedLimits = { ...storeLimits };

test.afterEach(() => {
  buildkit._forTest.resetUnavailable();
  Object.assign(storeLimits, savedLimits);
});

test('the setting: slug=claim pairs, and anything that is not one is dropped', () => {
  assert.deepEqual(parsePreviewStores('demo=bk-store-demo'), { demo: 'bk-store-demo' });
  assert.deepEqual(parsePreviewStores(' demo = bk-store-demo , other-app=s2 '), { demo: 'bk-store-demo', 'other-app': 's2' });
  assert.deepEqual(parsePreviewStores(''), {});
  assert.deepEqual(parsePreviewStores(undefined), {});
  // Not a claim name Kubernetes would take, or one a label value could not hold.
  assert.deepEqual(parsePreviewStores('demo=Bad_Claim,x=-lead,y=trail-,z=,=c,plain,demo2=a.b'), {});
  assert.deepEqual(parsePreviewStores(`demo=${'c'.repeat(64)}`), {}, 'longer than a DNS label');
  assert.deepEqual(parsePreviewStores(`demo=${'c'.repeat(63)}`), { demo: 'c'.repeat(63) });
});

test('who may use a store: a preview of a named app, never an app\'s main, never when unset', () => {
  const on = config({ buildkitPreviewStores: STORES }).kubernetes;
  const store = previewStore(on, { app, sessionId: 42, environment: 'staging' });
  assert.equal(store.claim, 'bk-store-demo');
  assert.match(store.key, /^[a-f0-9]{12}$/);
  assert.equal(previewStore(on, { app, sessionId: undefined, environment: 'production' }), null, 'a deploy of main');
  assert.equal(previewStore(on, { app, sessionId: null, environment: 'staging' }), null, 'no session');
  assert.equal(previewStore(on, { app, sessionId: 42, environment: 'production' }), null, 'a session id does not make a deploy a preview');
  assert.equal(previewStore(on, { app: { ...app, slug: 'someone-else' }, sessionId: 42, environment: 'staging' }), null);
  for (const unset of [undefined, '', '   ']) {
    assert.equal(previewStore(config({ buildkitPreviewStores: unset }).kubernetes, { app, sessionId: 42, environment: 'staging' }), null);
  }
  // A store written by one daemon is not opened by another.
  const keyOf = (overrides) => previewStore(config({ buildkitPreviewStores: STORES, ...overrides }).kubernetes, { app, sessionId: 42, environment: 'staging' }).key;
  assert.equal(keyOf({}), store.key);
  assert.equal(keyOf({ buildkitPreviewStoreEpoch: '1' }), store.key, 'the default epoch');
  assert.notEqual(keyOf({ buildkitPreviewStoreEpoch: '2' }), store.key);
  assert.notEqual(keyOf({ buildkitImage: `x@${digest('9')}` }), store.key);
  assert.notEqual(keyOf({ buildkitMode: 'privileged' }), store.key);
});

test('off is exactly what it was: same Job, same script, same recipe, same calls', async () => {
  for (const stores of [undefined, '', 'someone-else=bk-store-x']) {
    const { clients, state } = fakeCluster();
    const result = await buildkit.createBuild(config({ buildkitPreviewStores: stores }), preview, runtimeWith(clients));
    assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
    assert.equal(state.jobs.length, 1);
    const job = state.jobs[0];
    const plainRecipe = recipeOf(config().kubernetes, 'Dockerfile.kubernetes');
    assert.equal(job.metadata.name, `bk-12-s42-${revision.slice(0, 12)}-${plainRecipe}`);
    // The manifest the module built before it knew about stores, key for key.
    assert.deepEqual(job, jobManifest(config().kubernetes, runtimeWith(clients), {
      app, revision, environment: 'staging', sessionId: 42, dockerfile: 'Dockerfile.kubernetes',
      name: job.metadata.name, tag: `registry.test/apps/demo:git-${revision}-${plainRecipe}`,
      cacheRef: 'registry.test/cache/demo:buildkit-cache', recipe: plainRecipe, inputSecretName: `${job.metadata.name}-input`,
    }));
    const pod = job.spec.template.spec;
    assert.equal(pod.containers[0].command[2], BUILD_SCRIPT);
    assert.deepEqual(pod.volumes.map((v) => v.name), ['workspace', 'buildkitd']);
    assert.deepEqual(pod.containers[0].env.map((e) => e.name), ['REPO_URL', 'GIT_SHA', 'DOCKERFILE', 'IMAGE_TAG', 'CACHE_REF', 'REGISTRY_ATTRS', 'BUILDKITD_FLAGS']);
    assert.equal('fsGroupChangePolicy' in pod.securityContext, false);
    assert.equal(STORE_LABEL in job.metadata.labels, false);
    assert.equal(state.lists.length, 1, 'one lookup, for a reusable image, as before');
  }
  // The recipe of every image built so far must not move, or none is reused.
  const cfg = config().kubernetes;
  assert.equal(recipeOf(cfg, 'Dockerfile.kubernetes', null), recipeOf(cfg, 'Dockerfile.kubernetes'));
  assert.equal(recipeOf({ buildkitImage: 'img@sha256:1', buildkitMode: 'rootless', buildkitInsecureRegistry: false }, 'Dockerfile'), 'f4cab8715fad');
});

test('a store build\'s Job: the claim beside both emptyDirs, the store script, its own recipe and label', async () => {
  const { clients, state } = fakeCluster();
  const cfg = config({ buildkitPreviewStores: STORES });
  const result = await buildkit.createBuild(cfg, preview, runtimeWith(clients));
  const store = previewStore(cfg.kubernetes, preview);
  const storeRecipe = recipeOf(cfg.kubernetes, 'Dockerfile.kubernetes', store);
  assert.notEqual(storeRecipe, recipeOf(cfg.kubernetes, 'Dockerfile.kubernetes'), 'a deploy looks for the plain recipe and never finds this image');
  assert.equal(state.jobs.length, 1);
  const job = state.jobs[0];
  assert.equal(job.metadata.name, `bk-12-s42-${revision.slice(0, 12)}-${storeRecipe}`);
  assert.equal(job.metadata.labels[STORE_LABEL], 'bk-store-demo');
  assert.equal(job.metadata.labels['social.usernode.io/build-recipe'], storeRecipe);
  assert.equal(result.requestedTag, `registry.test/apps/demo:git-${revision}-${storeRecipe}`);
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  const pod = job.spec.template.spec;
  assert.deepEqual(pod.volumes, [
    { name: 'workspace', emptyDir: {} },
    { name: 'buildkitd', emptyDir: {} },
    { name: 'store', persistentVolumeClaim: { claimName: 'bk-store-demo' } },
  ]);
  const container = pod.containers[0];
  assert.deepEqual(container.volumeMounts.find((m) => m.name === 'store'), { name: 'store', mountPath: '/store' });
  assert.equal(container.volumeMounts.find((m) => m.name === 'buildkitd').mountPath, '/home/user/.local/share/buildkit', 'the plain build keeps its own empty store');
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
  assert.equal(env.STORE_DIR, '/store');
  assert.equal(env.STORE_KEY, store.key);
  assert.equal(container.command[2], STORE_BUILD_SCRIPT);
  // The kubelet would otherwise re-own every file in the store on every mount.
  assert.equal(pod.securityContext.fsGroup, 1000);
  assert.equal(pod.securityContext.fsGroupChangePolicy, 'OnRootMismatch');
  // Privileged mode: root needs no fsGroup, and the store is still the claim.
  const privileged = jobManifest({ ...cfg.kubernetes, buildkitMode: 'privileged' }, runtimeWith(clients), {
    app, revision, environment: 'staging', sessionId: 42, dockerfile: 'Dockerfile', name: 'n', tag: 't', cacheRef: 'c', recipe: 'r', inputSecretName: 'i', store,
  });
  assert.deepEqual(privileged.spec.template.spec.securityContext, { runAsUser: 0, runAsGroup: 0 });
  assert.equal(claimOf(privileged), 'bk-store-demo');
});

test('an app\'s main is built without the store even when the app has one', async () => {
  const { clients, state } = fakeCluster();
  await buildkit.createBuild(config({ buildkitPreviewStores: STORES }), { app, revision, environment: 'production', sourceDir }, runtimeWith(clients));
  assert.equal(claimOf(state.jobs[0]), null);
  assert.equal(state.jobs[0].spec.template.spec.containers[0].command[2], BUILD_SCRIPT);
  assert.equal(state.lists.length, 1);
});

test('a second preview of the app, while one holds the store, gets the plain Job and no claim', async () => {
  const cfg = config({ buildkitPreviewStores: STORES });
  const running = {
    metadata: { name: 'bk-12-s41-other', labels: { ...kubernetes.labels({ appId: 12, sessionId: 41, environment: 'staging' }), 'social.usernode.io/build-engine': 'buildkit', [STORE_LABEL]: 'bk-store-demo' } },
    status: { active: 1 },
  };
  const { clients, state } = fakeCluster({ existingJobs: [running] });
  await buildkit.createBuild(cfg, preview, runtimeWith(clients));
  assert.equal(claimOf(state.jobs[0]), null, 'not pinned to the claim\'s node for a lock it would not get');
  assert.equal(state.jobs[0].spec.template.spec.containers[0].command[2], BUILD_SCRIPT);
  // A finished or failed store Job does not hold anything.
  for (const status of [{ succeeded: 1 }, { failed: 1 }]) {
    const idle = fakeCluster({ existingJobs: [{ ...running, status }] });
    await buildkit.createBuild(cfg, preview, runtimeWith(idle.clients));
    assert.equal(claimOf(idle.state.jobs[0]), 'bk-store-demo');
  }
  // Nor does this build's own Job, still running after a platform restart:
  // the build asks for the store again and so finds that Job by name,
  // instead of starting a second, plain build of the same commit beside it.
  const store = previewStore(cfg.kubernetes, preview);
  const ownName = `bk-12-s42-${revision.slice(0, 12)}-${recipeOf(cfg.kubernetes, 'Dockerfile.kubernetes', store)}`;
  const own = fakeCluster({ existingJobs: [{ ...running, metadata: { ...running.metadata, name: ownName } }] });
  await buildkit.createBuild(cfg, preview, runtimeWith(own.clients));
  assert.equal(own.state.jobs[0].metadata.name, ownName);
  assert.equal(claimOf(own.state.jobs[0]), 'bk-store-demo');
});

test('image reuse: a preview takes a finished image of either recipe, a deploy only a plain one', async () => {
  const cfg = config({ buildkitPreviewStores: STORES });
  const store = previewStore(cfg.kubernetes, preview);
  const finished = (name, recipe, hex) => ({
    metadata: {
      name, namespace: 'bk', annotations: { 'social.usernode.io/image-digest': digest(hex) },
      labels: { ...kubernetes.labels({ appId: 12, sessionId: 7, environment: 'staging' }), 'social.usernode.io/build-engine': 'buildkit', 'social.usernode.io/revision': revision, 'social.usernode.io/build-recipe': recipe },
    },
    status: { succeeded: 1, completionTime: '2026-10-08T09:00:00Z' },
  });
  const storeBuilt = finished('store-built', recipeOf(cfg.kubernetes, 'Dockerfile.kubernetes', store), '1');
  const plainBuilt = finished('plain-built', recipeOf(cfg.kubernetes, 'Dockerfile.kubernetes'), '2');

  const both = fakeCluster({ existingJobs: [storeBuilt, plainBuilt] });
  assert.equal((await buildkit.createBuild(cfg, preview, runtimeWith(both.clients))).imageRef, `registry.test/apps/demo@${digest('1')}`);
  const onlyPlain = fakeCluster({ existingJobs: [plainBuilt] });
  const reused = await buildkit.createBuild(cfg, preview, runtimeWith(onlyPlain.clients));
  assert.equal(reused.reused, true);
  assert.equal(reused.imageRef, `registry.test/apps/demo@${digest('2')}`);
  assert.equal(onlyPlain.state.jobs.length, 0);

  // A deploy of the same commit: the store-built image is not a candidate.
  const deploy = fakeCluster({ existingJobs: [storeBuilt] });
  const built = await buildkit.createBuild(cfg, { app, revision, environment: 'production', sourceDir }, runtimeWith(deploy.clients));
  assert.equal(built.reused, undefined);
  assert.equal(deploy.state.jobs.length, 1);
  assert.equal(claimOf(deploy.state.jobs[0]), null);
});

test('whether a store Job\'s Pod is on its way', () => {
  const limits = { unschedulableMs: 10000, startMs: 45000 };
  assert.deepEqual(storeStartVerdict(startedPod(), 0, limits), { started: true });
  const running = { status: { containerStatuses: [{ name: 'buildkit', state: { running: { startedAt: 'now' } } }] } };
  assert.deepEqual(storeStartVerdict(running, 999999, limits), { started: true });
  assert.deepEqual(storeStartVerdict(null, 2000, limits), { wait: true }, 'no Pod yet');
  assert.deepEqual(storeStartVerdict(unschedulablePod(), 9999, limits), { wait: true }, 'the scheduler may still place it');
  assert.match(storeStartVerdict(unschedulablePod(), 10000, limits).reason, /cannot be scheduled \(0\/4 nodes are available: persistentvolumeclaim "bk-store-demo" not found\.\)/);
  const creating = { status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }], containerStatuses: [{ name: 'buildkit', state: { waiting: { reason: 'ContainerCreating' } } }] } };
  assert.deepEqual(storeStartVerdict(creating, 44999, limits), { wait: true });
  assert.match(storeStartVerdict(creating, 45000, limits).reason, /had not started after 45s \(ContainerCreating\)/);
  assert.match(storeStartVerdict(null, 45000, limits).reason, /no Pod yet/);
});

test('a store Job whose Pod cannot start: removed, the same build runs without the store, and the app stays off it for a while', async () => {
  storeLimits.unschedulableMs = 0;
  const cfg = config({ buildkitPreviewStores: STORES });
  const { clients, state } = fakeCluster({
    podFor: (job) => (claimOf(job) ? unschedulablePod() : startedPod()),
    statusFor: (job, n) => (claimOf(job) || n === 0 ? { active: 1 } : { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }),
  });
  const result = await buildkit.createBuild(cfg, preview, runtimeWith(clients));
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`, 'the preview still gets its image');
  assert.equal(state.jobs.length, 2);
  assert.equal(claimOf(state.jobs[0]), 'bk-store-demo');
  assert.equal(claimOf(state.jobs[1]), null);
  assert.equal(state.jobs[1].spec.template.spec.containers[0].command[2], BUILD_SCRIPT);
  assert.notEqual(state.jobs[1].metadata.name, state.jobs[0].metadata.name);
  assert.deepEqual(state.deleted, [state.jobs[0].metadata.name], 'the stuck Job does not wait out its deadline');
  assert.equal(result.buildRef, `bk/${state.jobs[1].metadata.name}`);

  // The next preview of that app does not pay for the same wait.
  const next = fakeCluster();
  await buildkit.createBuild(cfg, { ...preview, revision: 'c'.repeat(40) }, runtimeWith(next.clients));
  assert.equal(next.state.jobs.length, 1);
  assert.equal(claimOf(next.state.jobs[0]), null);
  // Another app's store is not affected by this one's.
  const other = fakeCluster();
  await buildkit.createBuild(config({ buildkitPreviewStores: 'demo=bk-store-demo,other=bk-store-other' }),
    { ...preview, app: { id: 13, slug: 'other', repo_url: 'https://github.com/example/other' } }, runtimeWith(other.clients));
  assert.equal(claimOf(other.state.jobs[0]), 'bk-store-other');
  assert.ok(STORE_UNAVAILABLE_MEMO_MS >= 60 * 1000 && STORE_UNAVAILABLE_MEMO_MS <= 30 * 60 * 1000);
});

test('a store Job whose build fails is a failed build: reported once, not rebuilt by the platform', async () => {
  const cfg = config({ buildkitPreviewStores: STORES });
  const { clients, state } = fakeCluster({
    podFor: () => ({ ...startedPod(), status: { containerStatuses: [{ name: 'buildkit', state: { terminated: { exitCode: 1, message: '' } } }] } }),
    statusFor: (_job, n) => (n === 0 ? { active: 1 } : { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }),
  });
  await assert.rejects(buildkit.createBuild(cfg, preview, runtimeWith(clients)), (err) => {
    assert.equal(err.buildFailed, true);
    assert.equal(err.storeUnavailable, undefined);
    assert.match(err.buildLog, /step failed/);
    return true;
  });
  assert.equal(state.jobs.length, 1, 'the Pod already built once more without the store; the platform does not add a third');
  // And the store is not blamed for it.
  const next = fakeCluster();
  await buildkit.createBuild(cfg, { ...preview, revision: 'c'.repeat(40) }, runtimeWith(next.clients));
  assert.equal(claimOf(next.state.jobs[0]), 'bk-store-demo');
});

test('the store script: one attempt on the store, then the plain script, verbatim', () => {
  assert.ok(STORE_BUILD_SCRIPT.endsWith(`\n${BUILD_SCRIPT}`), 'the build without the store is the same text, not a copy to keep in step');
  const prelude = STORE_BUILD_SCRIPT.slice(0, STORE_BUILD_SCRIPT.length - BUILD_SCRIPT.length);
  // The lock comes before anything touches the store, and never waits.
  assert.ok(prelude.indexOf('flock -n 9') > 0 && prelude.indexOf('flock -n 9') < prelude.indexOf('$STORE_KEY"'));
  assert.doesNotMatch(prelude, /flock (?!-n )/);
  // The store is the cache: nothing is uploaded, and the registry cache is read only until the store has built once.
  assert.doesNotMatch(prelude, /--export-cache/);
  assert.match(prelude, /\[ -e "\$home\/warm" \] \|\| set -- --import-cache "type=registry,ref=\$CACHE_REF\$REGISTRY_ATTRS"/);
  // Same build as the plain script: frontend, context, Dockerfile, the one build argument, the pushed tag.
  for (const flag of ['--frontend dockerfile.v0', '--local context=/workspace/src', '--local dockerfile=/workspace/src',
    '--opt "filename=$DOCKERFILE"', '--opt "build-arg:GIT_SHA=$GIT_SHA"', '--output "type=image,name=$IMAGE_TAG,push=true$REGISTRY_ATTRS"']) {
    assert.ok(prelude.includes(flag) && BUILD_SCRIPT.includes(flag), flag);
  }
  assert.equal((prelude.match(/--opt /g) || []).length, (BUILD_SCRIPT.match(/--opt /g) || []).length, 'no build option the plain build does not pass');
  // What the daemon keeps is bounded, and build steps' cache mounts do not carry over.
  assert.match(prelude, /prune --filter type==exec\.cachemount/);
  assert.match(prelude, /prune --keep-storage "\$keep_mb"/);
  assert.match(prelude, /keep_mb=\$\(\(total_kb \* 6 \/ 10 \/ 1024\)\)/);
  // The mirror offers the last commit, and keeps no record of the clone URL.
  assert.match(prelude, /update-ref refs\/kept\/last "\$GIT_SHA"/);
  assert.match(prelude, /rm -f "\$mirror\/\.git\/FETCH_HEAD"/);
  assert.doesNotMatch(prelude.replace(/fetch -q --depth 1 "\$REPO_URL" "\$GIT_SHA"/, ''), /REPO_URL/, 'the clone URL is used for the fetch and nothing else');
  // A store-only failure ends in the plain build, and marks the store if that build passes.
  assert.match(prelude, /if store_build; then exit 0; fi/);
  assert.match(prelude, /trap 'if \[ "\$\?" = 0 \]; then : >"\$STORE_DIR\/\$STORE_KEY\/reset"; fi' EXIT/);
});

// ── The script itself, with a stand-in for the daemon ──────────────────────
//
// buildctl-daemonless.sh is replaced by a script that records how it was
// called and answers as told; git, flock and the rest are the real ones. The
// two paths the Pod provides (/workspace, /dev/termination-log) point into a
// temporary directory.

const haveTools = ['sh', 'git', 'flock'].every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0);

function scriptRig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-store-rig-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name) => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const bin = dir('bin'); const store = dir('store'); const origin = dir('origin');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const commit = (content) => {
    fs.writeFileSync(path.join(origin, 'Dockerfile'), content);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', content.trim());
    return git(origin, 'rev-parse', 'HEAD');
  };
  // Records `<root flag or plain> <subcommand> <args>`; fails where FAKE_FAIL names the call.
  fs.writeFileSync(path.join(bin, 'buildctl-daemonless.sh'), [
    '#!/bin/sh',
    'case "${BUILDKITD_FLAGS:-}" in *--root*) where=store; root=${BUILDKITD_FLAGS##*--root }; mkdir -p "$root" ;; *) where=plain ;; esac',
    'echo "$where $*" >> "$RIG_CALLS"',
    'case " ${FAKE_FAIL:-} " in *" $where:$1 "*) echo "error: simulated $where $1 failure" >&2; exit 1 ;; esac',
    'if [ "$1" = build ]; then',
    '  while [ $# -gt 0 ]; do if [ "$1" = --metadata-file ]; then meta=$2; fi; shift; done',
    '  [ "$where" = store ] && digest=$FAKE_STORE_DIGEST || digest=$FAKE_PLAIN_DIGEST',
    '  printf \'{\\n  "containerimage.digest": "%s"\\n}\\n\' "$digest" > "$meta"',
    'fi',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rootlesskit'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  let runs = 0;
  const start = (sha, env = {}) => {
    runs += 1;
    const work = dir(`work-${runs}`);
    const calls = path.join(work, 'calls.log');
    const script = STORE_BUILD_SCRIPT.split('/workspace').join(path.join(work, 'ws')).split('/dev/termination-log').join(path.join(work, 'termination-log'));
    fs.mkdirSync(path.join(work, 'ws'), { recursive: true });
    const child = spawn('sh', ['-c', script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        REPO_URL: `file://${origin}`, GIT_SHA: sha, DOCKERFILE: 'Dockerfile', IMAGE_TAG: 'registry.test/apps/demo:git-x',
        CACHE_REF: 'registry.test/cache/demo:buildkit-cache', REGISTRY_ATTRS: '', BUILDKITD_FLAGS: '--oci-worker-no-process-sandbox',
        STORE_DIR: store, STORE_KEY: 'key1', RIG_CALLS: calls,
        FAKE_STORE_DIGEST: digest('5'), FAKE_PLAIN_DIGEST: digest('9'), ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const finished = new Promise((resolve) => child.on('close', (code) => resolve({
      code, out,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
      digest: fs.existsSync(path.join(work, 'termination-log')) ? fs.readFileSync(path.join(work, 'termination-log'), 'utf8') : '',
      source: fs.existsSync(path.join(work, 'ws', 'src', 'Dockerfile')) ? fs.readFileSync(path.join(work, 'ws', 'src', 'Dockerfile'), 'utf8') : null,
    })));
    return { child, finished };
  };
  return { root, store, origin, commit, git, home: path.join(store, 'key1'), run: (sha, env) => start(sha, env).finished, start };
}

test('the script on a store: prunes, fetches into the mirror, builds without a cache upload; the next build skips the import', { skip: !haveTools && 'sh, git or flock is not installed' }, async (t) => {
  const rig = scriptRig(t);
  const first = rig.commit('FROM scratch\n# one\n');
  const cold = await rig.run(first);
  assert.equal(cold.code, 0, cold.out);
  assert.equal(cold.digest, digest('5'), 'the digest of the store build is what the Pod hands back');
  assert.equal(cold.source, 'FROM scratch\n# one\n');
  assert.deepEqual(cold.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['store prune', 'store prune', 'store build'], 'no plain preflight and no second build');
  assert.match(cold.calls[0], /prune --filter type==exec\.cachemount/);
  assert.match(cold.calls[1], /prune --keep-storage \d+$/);
  assert.match(cold.calls[2], /--import-cache type=registry,ref=registry\.test\/cache\/demo:buildkit-cache/, 'an empty store still reads the registry cache');
  assert.doesNotMatch(cold.calls[2], /--export-cache/);
  assert.match(cold.out, /\[buildkit\] pushed registry\.test\/apps\/demo:git-x@sha256:5{64}/);
  assert.ok(fs.existsSync(path.join(rig.home, 'warm')));
  assert.equal(fs.existsSync(path.join(rig.home, 'git', '.git', 'FETCH_HEAD')), false, 'nothing on the volume names the clone URL');
  assert.equal(rig.git(path.join(rig.home, 'git'), 'rev-parse', 'refs/kept/last'), first);

  const second = rig.commit('FROM scratch\n# two\n');
  const warm = await rig.run(second);
  assert.equal(warm.code, 0, warm.out);
  assert.equal(warm.source, 'FROM scratch\n# two\n');
  assert.doesNotMatch(warm.calls[2], /--import-cache/, 'a store that has built once is the cache');
  assert.equal(rig.git(path.join(rig.home, 'git'), 'rev-parse', 'refs/kept/last'), second);
  assert.doesNotMatch(`${cold.out}${warm.out}`, new RegExp(rig.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the clone URL is never printed');
});

test('the script when another build holds the store: the plain build, at once', { skip: !haveTools && 'sh, git or flock is not installed' }, async (t) => {
  const rig = scriptRig(t);
  const sha = rig.commit('FROM scratch\n');
  fs.writeFileSync(path.join(rig.store, '.lock'), '');
  // Holds the lock for as long as its stdin is open.
  const holder = spawn('flock', ['-n', path.join(rig.store, '.lock'), 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => holder.stdin.end());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await rig.run(sha);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /the kept store is in use by another build; building without it/);
  assert.equal(result.digest, digest('9'));
  assert.deepEqual(result.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['plain debug', 'plain build'], 'exactly the plain script\'s two calls');
  assert.match(result.calls[1], /--export-cache type=registry/, 'which uploads its cache as it always did');
  assert.equal(fs.existsSync(rig.home), false, 'nothing was written to a store it did not hold');
});

test('the script when the build fails on the store: built once more without it; the store is marked only if that passes', { skip: !haveTools && 'sh, git or flock is not installed' }, async (t) => {
  const rig = scriptRig(t);
  const sha = rig.commit('FROM scratch\n');
  // The Dockerfile's own failure: both builds fail, the Pod fails, the store is left alone.
  const broken = await rig.run(sha, { FAKE_FAIL: 'store:build plain:build' });
  assert.notEqual(broken.code, 0);
  assert.equal(broken.digest, '');
  assert.deepEqual(broken.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['store prune', 'store prune', 'store build', 'plain debug', 'plain build']);
  assert.equal(fs.existsSync(path.join(rig.home, 'reset')), false);
  assert.equal(fs.existsSync(path.join(rig.home, 'warm')), false, 'a store that has not built is still cold');

  // Fails on the store, passes without it: the image is pushed, and the store starts empty next time.
  const storeOnly = await rig.run(sha, { FAKE_FAIL: 'store:build' });
  assert.equal(storeOnly.code, 0, storeOnly.out);
  assert.match(storeOnly.out, /the build on the kept store failed; building once more without it/);
  assert.equal(storeOnly.digest, digest('9'));
  assert.ok(fs.existsSync(path.join(rig.home, 'reset')));
  fs.writeFileSync(path.join(rig.home, 'left-by-the-faulty-store'), 'x');
  const after = await rig.run(sha);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /starting it empty/);
  assert.equal(after.digest, digest('5'));
  assert.equal(fs.existsSync(path.join(rig.home, 'left-by-the-faulty-store')), false);
  assert.equal(fs.existsSync(path.join(rig.home, 'reset')), false);
  assert.match(after.calls[2], /--import-cache/, 'and is cold again');
});

test('the script when the daemon cannot open the store: started empty if the node is fine, left alone if the node is not', { skip: !haveTools && 'sh, git or flock is not installed' }, async (t) => {
  const rig = scriptRig(t);
  const sha = rig.commit('FROM scratch\n');
  assert.equal((await rig.run(sha)).code, 0);
  fs.writeFileSync(path.join(rig.home, 'marker-of-the-old-store'), 'x');

  // The node cannot run the daemon at all: nothing about the store is touched, and the plain script reports the node.
  const node = await rig.run(sha, { FAKE_FAIL: 'store:prune plain:debug' });
  assert.equal(node.code, buildkit._forTest.PREFLIGHT_EXIT);
  assert.match(node.out, /buildkitd cannot run here/);
  assert.ok(fs.existsSync(path.join(rig.home, 'marker-of-the-old-store')));
  assert.ok(fs.existsSync(path.join(rig.home, 'warm')));

  // The daemon runs, but not on this store: moved aside, started empty, built on.
  const damaged = await rig.run(sha, { FAKE_FAIL: 'store:prune' });
  assert.equal(damaged.code, 0, damaged.out);
  assert.match(damaged.out, /buildkitd cannot open the kept store; starting it empty/);
  assert.equal(damaged.digest, digest('5'));
  assert.equal(fs.existsSync(path.join(rig.home, 'marker-of-the-old-store')), false);
  assert.deepEqual(damaged.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['store prune', 'plain debug', 'store debug', 'store build']);
  assert.match(damaged.calls[3], /--import-cache/);
});

test('the script on a new generation: what the old one left on the claim is removed', { skip: !haveTools && 'sh, git or flock is not installed' }, async (t) => {
  const rig = scriptRig(t);
  const sha = rig.commit('FROM scratch\n');
  fs.mkdirSync(path.join(rig.store, 'oldkey', 'buildkit'), { recursive: true });
  fs.writeFileSync(path.join(rig.store, 'oldkey', 'buildkit', 'layer'), 'x');
  fs.mkdirSync(path.join(rig.store, 'lost+found'));
  const result = await rig.run(sha);
  assert.equal(result.code, 0, result.out);
  // Removed in the background while the build runs.
  for (let i = 0; i < 50 && fs.existsSync(path.join(rig.store, 'oldkey')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(path.join(rig.store, 'oldkey')), false);
  assert.ok(fs.existsSync(path.join(rig.store, 'lost+found')), 'the filesystem\'s own directory stays');
  assert.ok(fs.existsSync(path.join(rig.home, 'warm')));
});
