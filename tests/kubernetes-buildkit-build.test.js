const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('stream');
const buildkit = require('../src/services/kubernetes-buildkit');
const kubernetes = require('../src/services/kubernetes');

const digest = (c) => `sha256:${c.repeat(64)}`;
const revision = 'b'.repeat(40);
const app = { id: 12, slug: 'demo', repo_url: 'https://github.com/example/demo' };

function config(overrides = {}) {
  return { kubernetes: {
    buildNamespace: 'builds', repositoryPrefix: 'registry.test/apps', cacheRepositoryPrefix: 'registry.test/cache',
    builderImage: `registry.test/builder@${digest('a')}`, buildServiceAccount: 'builder', nodeVersion: '22.*',
    activeDeadlineSeconds: 30,
    buildEngine: 'auto', buildkitNamespace: 'bk', buildkitServiceAccount: 'bk-builder',
    buildkitImage: `docker.io/moby/buildkit:v0.33.0-rootless@${digest('f')}`, buildkitMode: 'rootless',
    buildkitRegistrySecret: '', buildkitInsecureRegistry: false,
    buildkitDockerfiles: ['Dockerfile.kubernetes', 'Dockerfile'], buildkitSuccessRetentionHours: 48,
    ...overrides,
  } };
}

function sourceTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-src-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'FROM scratch\n');
  return dir;
}

// The helpers services/kubernetes.js injects, with fakes where a cluster
// would be. `clients` is what getClients() returns.
function runtimeWith(clients, { diagnostics } = {}) {
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
    collectPodDiagnostics: async () => diagnostics || { logs: 'npm ERR! missing script: build', details: 'Exit 1', deadlineExceeded: false },
    boundedText: (text) => String(text || '').slice(0, 65536),
    getCloneUrl: async (owner, name) => `https://github.com/${owner}/${name}.git`,
  };
}

// A batch/core pair that records what the platform does and plays back a
// Job that runs one poll then succeeds, its Pod carrying the digest in the
// termination message.
function fakeCluster({
  jobReads = null, podMessage = digest('d'), podExitCode = 0, logLines = [], existingJobs = [], createJobError = null,
} = {}) {
  const state = { secrets: [], jobs: [], patches: [], deleted: [], replacedSecrets: [], lists: [], logFollows: 0 };
  let reads = 0;
  const jobStatuses = jobReads || [{ active: 1 }, { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }];
  const pod = () => ({
    metadata: { name: 'bk-pod', creationTimestamp: '2026-09-14T10:00:00Z' },
    spec: { nodeName: 'worker-3' },
    status: { containerStatuses: [{ name: 'buildkit', state: { terminated: { exitCode: podExitCode, message: podMessage } } }] },
  });
  const batch = {
    async listNamespacedJob(request) { state.lists.push(request); return { items: existingJobs }; },
    async createNamespacedJob({ body }) {
      if (createJobError) throw createJobError;
      state.jobs.push(body);
      return { metadata: { ...body.metadata, uid: 'uid-1' } };
    },
    async readNamespacedJob({ name }) {
      const status = jobStatuses[Math.min(reads, jobStatuses.length - 1)];
      reads += 1;
      return { metadata: { name, namespace: 'bk' }, status };
    },
    async patchNamespacedJob(request, options) { state.patches.push({ request, options }); },
    async deleteNamespacedJob(request) { state.deleted.push(request); },
    async deleteCollectionNamespacedJob(request) { state.deleted.push(request); },
  };
  const core = {
    async createNamespacedSecret({ body }) { state.secrets.push(body); },
    async readNamespacedSecret({ name }) { return { metadata: { name }, stringData: {} }; },
    async replaceNamespacedSecret({ body }) { state.replacedSecrets.push(body); },
    async deleteNamespacedSecret(request) { state.deleted.push(request); },
    async listNamespacedPod() { return { items: [pod()] }; },
    async readNamespacedPod() { return pod(); },
  };
  const logs = {
    async log(_ns, _pod, _container, sink) {
      state.logFollows += 1;
      for (const line of logLines) sink.write(`${line}\n`);
      sink.end();
      return { abort() {} };
    },
  };
  return { clients: { batch, core, logs }, state };
}

test.afterEach(() => {
  kubernetes._setClientsForTest(null);
  buildkit._forTest.resetUnavailable();
});

test('engine selection: kpack stays the default, auto prefers Dockerfile.kubernetes, buildkit insists on a Dockerfile', () => {
  const both = sourceTree(['Dockerfile', 'Dockerfile.kubernetes']);
  const composeOnly = sourceTree(['Dockerfile']);
  const none = sourceTree([]);
  assert.deepEqual(buildkit.selectEngine(config({ buildEngine: 'kpack' }), both), { engine: 'kpack', dockerfile: null });
  assert.deepEqual(buildkit.selectEngine(config(), both), { engine: 'buildkit', dockerfile: 'Dockerfile.kubernetes' });
  assert.deepEqual(buildkit.selectEngine(config(), composeOnly), { engine: 'buildkit', dockerfile: 'Dockerfile' });
  assert.deepEqual(buildkit.selectEngine(config(), none), { engine: 'kpack', dockerfile: null });
  assert.deepEqual(buildkit.selectEngine(config(), null), { engine: 'kpack', dockerfile: null }, 'no checkout: kpack clones for itself');
  assert.throws(() => buildkit.selectEngine(config({ buildEngine: 'buildkit' }), none), (err) => {
    assert.equal(err.buildFailed, true);
    assert.match(err.message, /Dockerfile\.kubernetes, Dockerfile/);
    return true;
  });
  assert.throws(() => buildkit.selectEngine(config({ buildEngine: 'podman' }), none), /Unsupported BUILD_ENGINE=podman/);
});

test('the Job manifest: rootless daemon, per-app cache repository, source and identity through env, Job-owned retention', () => {
  const cfg = config().kubernetes;
  const body = buildkit._forTest.jobManifest(cfg, runtimeWith({}), {
    app, revision, environment: 'staging', sessionId: 42, dockerfile: 'Dockerfile.kubernetes',
    name: 'bk-12-s42-bbbbbbbbbbbb-abc', tag: 'registry.test/apps/demo:git-x-abc', cacheRef: 'registry.test/cache/demo:buildkit-cache',
    recipe: 'abc', inputSecretName: 'bk-12-s42-bbbbbbbbbbbb-abc-input',
  });
  assert.equal(body.kind, 'Job');
  assert.equal(body.metadata.namespace, 'bk');
  assert.equal(body.metadata.labels['social.usernode.io/build-engine'], 'buildkit');
  assert.equal(body.metadata.labels['social.usernode.io/revision'], revision);
  assert.equal(body.metadata.labels['social.usernode.io/app-id'], '12');
  assert.equal(body.metadata.labels['social.usernode.io/session-id'], '42');
  assert.equal(body.spec.backoffLimit, 0, 'a failed build is reported, not retried behind the platform\'s back');
  assert.equal(body.spec.activeDeadlineSeconds, 30);
  assert.equal(body.spec.ttlSecondsAfterFinished, 48 * 3600);
  const pod = body.spec.template.spec;
  assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.serviceAccountName, 'bk-builder');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, {
    runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,
    seccompProfile: { type: 'Unconfined' }, appArmorProfile: { type: 'Unconfined' },
  });
  const [container] = pod.containers;
  assert.equal(container.name, 'buildkit');
  assert.equal(container.image, cfg.buildkitImage);
  assert.deepEqual(container.securityContext, { runAsNonRoot: true });
  assert.equal(container.securityContext.privileged, undefined);
  assert.deepEqual(container.command.slice(0, 2), ['sh', '-c']);
  assert.equal(container.command[2], buildkit._forTest.BUILD_SCRIPT);
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value ?? e.valueFrom]));
  assert.deepEqual(env.REPO_URL, { secretKeyRef: { name: 'bk-12-s42-bbbbbbbbbbbb-abc-input', key: 'REPO_URL' } },
    'the clone URL travels in a Secret, never inline in the Pod spec');
  assert.equal(env.GIT_SHA, revision);
  assert.equal(env.DOCKERFILE, 'Dockerfile.kubernetes');
  assert.equal(env.IMAGE_TAG, 'registry.test/apps/demo:git-x-abc');
  assert.equal(env.CACHE_REF, 'registry.test/cache/demo:buildkit-cache');
  assert.equal(env.REGISTRY_ATTRS, '');
  assert.equal(env.BUILDKITD_FLAGS, '--oci-worker-no-process-sandbox');
  assert.equal(env.DOCKER_CONFIG, undefined, 'anonymous registry: no credential mount');
  assert.deepEqual(pod.volumes.map((v) => v.name).sort(), ['buildkitd', 'workspace']);
  assert.ok(container.volumeMounts.some((m) => m.mountPath === '/home/user/.local/share/buildkit'),
    'the daemon store is a real emptyDir, not the image VOLUME');
  assert.equal(container.resources.limits.cpu, '4');
});

test('the Job manifest: privileged mode, registry credentials and a plain-HTTP registry are opt-in switches', () => {
  const cfg = config({ buildkitMode: 'privileged', buildkitRegistrySecret: 'push-creds', buildkitInsecureRegistry: true }).kubernetes;
  const body = buildkit._forTest.jobManifest(cfg, runtimeWith({}), {
    app, revision, environment: 'staging', sessionId: 42, dockerfile: 'Dockerfile',
    name: 'bk', tag: 't', cacheRef: 'c', recipe: 'r', inputSecretName: 'bk-input',
  });
  const pod = body.spec.template.spec;
  // Root, so buildctl-daemonless.sh skips RootlessKit: this mode must not
  // depend on the user namespaces the rootless one exists to avoid needing.
  assert.deepEqual(pod.securityContext, { runAsUser: 0, runAsGroup: 0 });
  assert.deepEqual(pod.containers[0].securityContext, { privileged: true });
  const env = Object.fromEntries(pod.containers[0].env.map((e) => [e.name, e.value ?? e.valueFrom]));
  assert.equal(env.BUILDKITD_FLAGS, '', 'root keeps the process sandbox');
  assert.equal(pod.containers[0].volumeMounts.find((m) => m.name === 'buildkitd').mountPath, '/var/lib/buildkit');
  assert.equal(env.REGISTRY_ATTRS, ',registry.insecure=true');
  assert.equal(env.DOCKER_CONFIG, '/var/run/buildkit-registry');
  const mount = pod.containers[0].volumeMounts.find((m) => m.name === 'registry-auth');
  assert.deepEqual(mount, { name: 'registry-auth', mountPath: '/var/run/buildkit-registry', readOnly: true });
  const volume = pod.volumes.find((v) => v.name === 'registry-auth');
  assert.deepEqual(volume.secret, { secretName: 'push-creds', items: [{ key: '.dockerconfigjson', path: 'config.json' }] });
});

test('the build script: fetches by SHA, exports the tree without .git, never prints the clone URL, hands back only the digest', () => {
  const script = buildkit._forTest.BUILD_SCRIPT;
  assert.match(script, /^set -eu/m);
  assert.match(script, /git -c protocol\.version=2 fetch -q --depth 1 "\$REPO_URL" "\$GIT_SHA"/);
  assert.match(script, /git checkout-index -a -f --prefix=\/workspace\/src\//, 'the build context is an exported tree');
  assert.match(script, /rm -rf \/workspace\/repo/, 'repository metadata (and any credential in it) is gone before the build');
  assert.doesNotMatch(script, /say[^\n]*REPO_URL/, 'the clone URL is not echoed');
  assert.match(script, /--frontend dockerfile\.v0/);
  assert.match(script, /--opt "filename=\$DOCKERFILE"/);
  assert.match(script, /--output "type=image,name=\$IMAGE_TAG,push=true\$REGISTRY_ATTRS"/);
  assert.match(script, /--import-cache "type=registry,ref=\$CACHE_REF\$REGISTRY_ATTRS"/);
  assert.match(script, /--export-cache "type=registry,ref=\$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true\$REGISTRY_ATTRS"/);
  assert.match(script, /--progress plain/, 'line-oriented output is what the step parser reads');
  assert.match(script, /--metadata-file \/workspace\/metadata\.json/);
  assert.match(script, /printf '%s' "\$digest" > \/dev\/termination-log/);
  assert.match(script, /test -n "\$digest"/, 'no digest is a failed build, not an empty result');
  // The daemon preflight runs before any source is fetched and exits with
  // the code the platform reads as "the lane cannot run here".
  const preflight = script.indexOf('buildctl-daemonless.sh debug workers');
  assert.ok(preflight >= 0 && preflight < script.indexOf('git -c protocol.version=2 fetch'), 'preflight precedes the fetch');
  assert.match(script, /debug workers[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*exit 75/, 'a daemon that cannot start exits 75');
  assert.equal(buildkit._forTest.PREFLIGHT_EXIT, 75);
});

test('progress lines: BuildKit steps parse as the Docker builder\'s steps; the Job\'s own lines are the source phase', () => {
  const p = buildkit._forTest.progressFromLine;
  assert.deepEqual(p('#7 [shell 4/9] RUN npm ci'), { index: 4, total: 9, phase: 'shell', detail: 'RUN npm ci' });
  assert.deepEqual(p('[buildkit] fetching source ' + revision), { phase: 'source', index: null, total: null, detail: `fetching source ${revision}` });
  assert.equal(p('#7 0.512 added 412 packages'), null);
  assert.equal(p(''), null);
});

test('createBuild: Secret then Job, owner reference, digest from the termination message, annotation for reuse, step progress from the log', async () => {
  const { clients, state } = fakeCluster({ logLines: ['[buildkit] fetching source x', '#5 [shell 2/9] RUN npm ci', '#5 1.2 noise'] });
  const progress = [];
  const result = await buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile.kubernetes']),
    onProgress: (image) => progress.push(image),
  }, runtimeWith(clients));
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.equal(result.buildRef, `bk/${state.jobs[0].metadata.name}`);
  assert.equal(result.engine, 'buildkit');
  assert.equal(result.reused, undefined);
  assert.match(result.requestedTag, new RegExp(`^registry\\.test/apps/demo:git-${revision}-[a-f0-9]{12}$`));
  assert.match(state.jobs[0].metadata.name, /^bk-12-s42-bbbbbbbbbbbb-[a-f0-9]{12}$/);
  assert.ok(state.jobs[0].metadata.name.length <= 63);
  assert.equal(state.secrets.length, 1);
  assert.deepEqual(state.secrets[0].stringData, { REPO_URL: 'https://github.com/example/demo.git' });
  assert.equal(state.secrets[0].metadata.name, `${state.jobs[0].metadata.name}-input`);
  assert.equal(state.replacedSecrets.length, 1, 'the Secret is re-written with its owner reference');
  assert.deepEqual(state.replacedSecrets[0].metadata.ownerReferences, [{
    apiVersion: 'batch/v1', kind: 'Job', name: state.jobs[0].metadata.name, uid: 'uid-1',
  }]);
  assert.equal(state.patches.length, 1);
  assert.deepEqual(state.patches[0].request.body, { metadata: { annotations: { 'social.usernode.io/image-digest': digest('d') } } });
  assert.equal(state.logFollows, 1);
  assert.deepEqual(progress, [
    { phase: 'source', index: null, total: null, detail: 'fetching source x' },
    { index: 2, total: 9, phase: 'shell', detail: 'RUN npm ci' },
  ]);
  assert.equal(state.deleted.length, 0, 'a successful Job stays for reuse until its TTL');
});

test('createBuild: a previous successful Job for the same revision and recipe is reused without a build', async () => {
  const first = fakeCluster();
  const built = await buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(first.clients));
  const recipe = built.requestedTag.slice(-12);
  const previousJob = {
    metadata: { name: 'bk-12-s7-bbbbbbbbbbbb-' + recipe, namespace: 'bk',
      annotations: { 'social.usernode.io/image-digest': digest('e') },
      labels: { 'social.usernode.io/app-id': '12' } },
    status: { succeeded: 1, completionTime: '2026-09-14T09:00:00Z' },
  };
  const second = fakeCluster({ existingJobs: [previousJob] });
  const reused = await buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 43, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(second.clients));
  assert.equal(reused.reused, true);
  assert.equal(reused.imageRef, `registry.test/apps/demo@${digest('e')}`);
  assert.equal(reused.buildRef, `bk/${previousJob.metadata.name}`);
  assert.equal(reused.requestedTag, built.requestedTag, 'same source and recipe, same artifact address');
  assert.equal(second.state.jobs.length, 0);
  assert.equal(second.state.secrets.length, 0);
  assert.match(second.state.lists[0].labelSelector, new RegExp(`social.usernode.io/revision=${revision}`));
  assert.match(second.state.lists[0].labelSelector, new RegExp(`social.usernode.io/build-recipe=${recipe}`));
});

test('createBuild: a changed Dockerfile choice or BuildKit image is a different recipe, so no stale reuse', () => {
  const cfg = config().kubernetes;
  const base = buildkit._forTest.recipeOf(cfg, 'Dockerfile.kubernetes');
  assert.notEqual(buildkit._forTest.recipeOf(cfg, 'Dockerfile'), base);
  assert.notEqual(buildkit._forTest.recipeOf({ ...cfg, buildkitImage: `x@${digest('9')}` }, 'Dockerfile.kubernetes'), base);
  assert.notEqual(buildkit._forTest.recipeOf({ ...cfg, buildkitMode: 'privileged' }, 'Dockerfile.kubernetes'), base);
  assert.equal(buildkit._forTest.recipeOf(cfg, 'Dockerfile.kubernetes'), base);
});

test('createBuild: a failed Job reports through the buildFailed/buildLog contract and is removed', async () => {
  const { clients, state } = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }],
  });
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(clients)), (err) => {
    assert.equal(err.buildFailed, true);
    assert.match(err.message, /BuildKit Job bk-12-s42-\S+ failed: BackoffLimitExceeded/);
    assert.match(err.buildLog, /Exit 1/);
    assert.match(err.buildLog, /npm ERR! missing script: build/);
    assert.equal(err.buildRef, `bk/${state.jobs[0].metadata.name}`);
    assert.equal(err.killed, undefined);
    return true;
  });
  assert.equal(state.deleted.filter((d) => d.propagationPolicy === 'Background').length, 1, 'the failed Job is deleted after diagnostics');
});

test('createBuild: a Job whose daemon preflight failed is the lane being unavailable, not the build failing', async () => {
  const { clients, state } = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }],
    podExitCode: 75,
  });
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(clients)), (err) => {
    assert.equal(err.engineUnavailable, true);
    assert.match(err.message, /BuildKit lane unavailable: buildkitd cannot start on worker-3/);
    assert.equal(err.buildFailed, true, 'still a failed build for a caller that does not fall back');
    return true;
  });
  assert.equal(state.deleted.filter((d) => d.propagationPolicy === 'Background').length, 1, 'the doomed Job is removed');
  // Any other exit code is the Dockerfile's problem.
  const genuine = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }],
    podExitCode: 1,
  });
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(genuine.clients)), (err) => err.engineUnavailable === undefined && err.buildFailed === true);
});

test('createBuild: a namespace or RBAC the cluster does not have yet is the lane being unavailable', async () => {
  const forbidden = Object.assign(new Error('jobs.batch is forbidden: User "system:serviceaccount:social-platform:social-platform-runtime" cannot create resource "jobs" in the namespace "bk"'), { code: 403 });
  const { clients, state } = fakeCluster({ createJobError: forbidden });
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(clients)), (err) => {
    assert.equal(err.engineUnavailable, true);
    assert.match(err.message, /BuildKit lane unavailable: cannot create Jobs in bk/);
    return true;
  });
  assert.equal(state.deleted.filter((d) => /-input$/.test(d.name)).length, 1, 'the clone credential does not outlive the attempt');
});

test('kubernetes.createBuild under auto builds with kpack while the lane is unavailable, and remembers that for a while', async () => {
  const unavailable = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }],
    podExitCode: 75,
  });
  const kpackCreated = [];
  const custom = {
    async listNamespacedCustomObject() { return { items: [] }; },
    async createNamespacedCustomObject(request) { kpackCreated.push(request.body); },
    async getNamespacedCustomObject() {
      return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: `registry.test/apps/demo@${digest('c')}` } };
    },
  };
  kubernetes._setClientsForTest({ ...unavailable.clients, custom });
  const params = () => ({ app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']) });
  const first = await kubernetes.createBuild(config(), params());
  assert.equal(first.engine, undefined, 'a kpack image');
  assert.equal(first.imageRef, `registry.test/apps/demo@${digest('c')}`);
  assert.equal(unavailable.state.jobs.length, 1, 'the lane was tried once');
  assert.equal(kpackCreated.length, 1);
  assert.match(buildkit.unavailableReason(), /buildkitd cannot start on worker-3/);
  const second = await kubernetes.createBuild(config(), params());
  assert.equal(second.imageRef, `registry.test/apps/demo@${digest('c')}`);
  assert.equal(unavailable.state.jobs.length, 1, 'no second doomed Job while the verdict is fresh');
  assert.equal(kpackCreated.length, 2);
  // The verdict expires, and the lane is tried again.
  assert.equal(buildkit.unavailableReason(Date.now() + buildkit._forTest.UNAVAILABLE_MEMO_MS + 1), null);
  assert.equal(buildkit.unavailableReason(), null, 'an expired verdict is forgotten');
  await kubernetes.createBuild(config(), params());
  assert.equal(unavailable.state.jobs.length, 2);
});

test('kubernetes.createBuild under BUILD_ENGINE=buildkit surfaces an unavailable lane instead of hiding it in kpack', async () => {
  const unavailable = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }],
    podExitCode: 75,
  });
  const kpackCreated = [];
  kubernetes._setClientsForTest({ ...unavailable.clients, custom: {
    async listNamespacedCustomObject() { return { items: [] }; },
    async createNamespacedCustomObject(request) { kpackCreated.push(request.body); },
  } });
  await assert.rejects(kubernetes.createBuild(config({ buildEngine: 'buildkit' }), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }), (err) => err.engineUnavailable === true);
  assert.equal(kpackCreated.length, 0);
  // And a genuine build failure under auto is never a reason to rebuild with kpack.
  const broken = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }],
    podExitCode: 1,
  });
  kubernetes._setClientsForTest({ ...broken.clients, custom: {
    async listNamespacedCustomObject() { return { items: [] }; },
    async createNamespacedCustomObject(request) { kpackCreated.push(request.body); },
  } });
  await assert.rejects(kubernetes.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }), (err) => err.buildFailed === true && err.engineUnavailable === undefined);
  assert.equal(kpackCreated.length, 0);
  assert.equal(buildkit.unavailableReason(), null);
});

test('createBuild: a deadline-exceeded Job is a timeout, with the budget it hit', async () => {
  const { clients } = fakeCluster({
    jobReads: [{ failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] }],
  });
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(clients)), (err) => {
    assert.equal(err.killed, true);
    assert.equal(err.buildTimeoutSeconds, 30);
    assert.equal(err.buildFailed, true);
    return true;
  });
});

test('createBuild: a Job that succeeds without a digest is a failure, not an image', async () => {
  const { clients } = fakeCluster({ jobReads: [{ succeeded: 1 }], podMessage: '' });
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  }, runtimeWith(clients)), /finished without an image digest/);
});

test('createBuild: configuration must name a digest-pinned BuildKit image and a known mode', async () => {
  const tree = sourceTree(['Dockerfile']);
  const { clients } = fakeCluster();
  await assert.rejects(buildkit.createBuild(config({ buildkitImage: 'moby/buildkit:rootless' }), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: tree,
  }, runtimeWith(clients)), /BUILDKIT_IMAGE must be an immutable digest/);
  await assert.rejects(buildkit.createBuild(config({ buildkitMode: 'sudo' }), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: tree,
  }, runtimeWith(clients)), /Unsupported BUILDKIT_MODE=sudo/);
  await assert.rejects(buildkit.createBuild(config({ buildkitImage: '' }), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: tree,
  }, runtimeWith(clients)), /BuildKit build configuration missing: buildkitImage/);
  await assert.rejects(buildkit.createBuild(config(), {
    app, revision: 'abc', environment: 'staging', sessionId: 42, sourceDir: tree,
  }, runtimeWith(clients)), /full 40-character Git commit SHA/);
});

test('kubernetes.createBuild routes a Dockerfile tree to the BuildKit lane and a bare tree to kpack under BUILD_ENGINE=auto', async () => {
  const { clients, state } = fakeCluster();
  const kpackCreated = [];
  kubernetes._setClientsForTest({
    ...clients,
    custom: {
      async listNamespacedCustomObject() { return { items: [] }; },
      async createNamespacedCustomObject(request) { kpackCreated.push(request.body); },
      async getNamespacedCustomObject() {
        return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: `registry.test/apps/demo@${digest('c')}` } };
      },
    },
  });
  const viaBuildkit = await kubernetes.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile']),
  });
  assert.equal(viaBuildkit.engine, 'buildkit');
  assert.equal(state.jobs.length, 1);
  assert.equal(kpackCreated.length, 0);
  const viaKpack = await kubernetes.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree([]),
  });
  assert.equal(viaKpack.engine, undefined);
  assert.equal(viaKpack.imageRef, `registry.test/apps/demo@${digest('c')}`);
  assert.equal(kpackCreated.length, 1);
  assert.equal(kpackCreated[0].kind, 'Build');
});

test('deleteBuilds and deleteFailedBuilds cover the BuildKit Jobs as well as the kpack Builds', async () => {
  const failedJob = { metadata: { name: 'bk-old', namespace: 'bk' }, status: { conditions: [{ type: 'Failed', status: 'True' }] } };
  const liveJob = { metadata: { name: 'bk-live', namespace: 'bk' }, status: { active: 1 } };
  const { clients, state } = fakeCluster({ existingJobs: [failedJob, liveJob] });
  const customCalls = [];
  kubernetes._setClientsForTest({
    ...clients,
    custom: {
      async deleteCollectionNamespacedCustomObject(request) { customCalls.push(request); },
      async listNamespacedCustomObject() { return { items: [
        { metadata: { name: 'kp-failed' }, status: { conditions: [{ type: 'Succeeded', status: 'False' }] } },
        { metadata: { name: 'kp-ok' }, status: { conditions: [{ type: 'Succeeded', status: 'True' }] } },
      ] }; },
      async deleteNamespacedCustomObject(request) { customCalls.push(request); },
    },
  });
  await kubernetes.deleteBuilds(config(), 12);
  assert.equal(customCalls.length, 1);
  assert.equal(state.deleted.length, 1);
  assert.equal(state.deleted[0].namespace, 'bk');
  assert.match(state.deleted[0].labelSelector, /social.usernode.io\/app-id=12,social.usernode.io\/build-engine=buildkit/);
  const swept = await kubernetes.deleteFailedBuilds(config());
  assert.deepEqual(swept, { examined: 4, deleted: 2 });
  assert.deepEqual(state.deleted.slice(1).map((d) => d.name), ['bk-old']);

  // A cluster on the kpack-only default has no BuildKit namespace to look
  // in, and an app deletion there must not fail on the lane's absence.
  const before = state.deleted.length;
  await kubernetes.deleteBuilds(config({ buildEngine: 'kpack' }), 12);
  assert.deepEqual(await kubernetes.deleteFailedBuilds(config({ buildEngine: 'kpack' })), { examined: 2, deleted: 1 });
  assert.equal(state.deleted.length, before, 'no Job API call under BUILD_ENGINE=kpack');

  // And a lane that is configured but whose namespace is gone is a no-op,
  // not an error, for the collection delete.
  const gone = new Error('namespaces "bk" not found'); gone.code = 404;
  kubernetes._setClientsForTest({
    ...clients,
    batch: { ...clients.batch, async deleteCollectionNamespacedJob() { throw gone; } },
    custom: { async deleteCollectionNamespacedCustomObject() {} },
  });
  await kubernetes.deleteBuilds(config(), 12);
});

test('the deployed app container is seen ready within seconds of answering /health', async () => {
  // deployApplication's manifest is reached through the real function with
  // a recording apps client; only the probe cadence is under test here.
  const manifests = [];
  const deployment = (body) => ({ ...body, metadata: { ...body.metadata, generation: 1 }, status: {
    observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1,
  } });
  kubernetes._setClientsForTest({
    core: {
      async readNamespacedSecret() { const err = new Error('nf'); err.code = 404; throw err; },
      async createNamespacedSecret() {},
      async readNamespacedService() { const err = new Error('nf'); err.code = 404; throw err; },
      async createNamespacedService() {},
      async listNamespacedPod() { return { items: [] }; },
    },
    apps: {
      async readNamespacedDeployment({ name }) { const found = manifests.find((m) => m.metadata.name === name); if (!found) { const err = new Error('nf'); err.code = 404; throw err; } return deployment(found); },
      async createNamespacedDeployment({ body }) { manifests.push(body); return deployment(body); },
      async replaceNamespacedDeployment({ body }) { return deployment(body); },
    },
    networking: {
      async readNamespacedIngress() { const err = new Error('nf'); err.code = 404; throw err; },
      async createNamespacedIngress() {},
      async readNamespacedNetworkPolicy() { const err = new Error('nf'); err.code = 404; throw err; },
      async createNamespacedNetworkPolicy() {},
    },
  });
  const cfg = { ...config(), selfAppSlug: 'platform' };
  cfg.kubernetes.appNamespace = 'apps';
  cfg.kubernetes.generatedAppServiceAccount = 'app';
  cfg.kubernetes.appDomain = 'apps.test';
  cfg.kubernetes.platformDomain = 'apps.test';
  cfg.kubernetes.appTlsSecretName = 'tls';
  cfg.kubernetes.ingressClassName = 'cilium';
  cfg.kubernetes.platformNamespace = 'platform';
  cfg.kubernetes.workerNamespace = 'workers';
  try {
    await kubernetes.deployApplication(cfg, {
      app, environment: 'staging', sessionId: 42, imageRef: `registry.test/apps/demo@${digest('d')}`, env: { A: '1' },
    });
  } catch (err) {
    // Other parts of the deploy may need clients this fake does not carry;
    // the Deployment manifest is what this test reads, and it was created
    // before any of them.
    if (!manifests.length) throw err;
  }
  const [container] = manifests[0].spec.template.spec.containers;
  assert.equal(container.startupProbe.periodSeconds, 1);
  assert.equal(container.startupProbe.failureThreshold, 120, 'the boot budget stays at two minutes');
  assert.equal(container.readinessProbe.periodSeconds, 2);
  assert.equal(container.livenessProbe.periodSeconds, 15);
});
