'use strict';

// The platform's own waits around a BuildKit preview build
// (src/services/kubernetes-buildkit.js):
//
//   - the build is done when its container is: the Pod's own status, read
//     as soon as the log says the script ended, not the Job's, which lagged
//     it by about three seconds; and the digest still comes only from the
//     termination message of a container that exited 0, never from the log;
//   - every success path (the fast one and the Job's own) takes its result
//     only from this build's Job and that Job's own Pod, never while the Job
//     has failed or is failing;
//   - the digest annotation is written without the deploy waiting for it;
//   - the Job's daemon preflight runs beside its source fetch, its verdict
//     still decides first, and a TERM in any phase stops the fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stream = require('node:stream');
const { spawn } = require('node:child_process');
const buildkit = require('../src/services/kubernetes-buildkit');
const kubernetes = require('../src/services/kubernetes');
// Loaded once per process in production; loaded here so the first timed
// build does not pay for it.
require('@kubernetes/client-node');

const digest = (c) => `sha256:${c.repeat(64)}`;
const revision = 'b'.repeat(40);
const app = { id: 12, slug: 'demo', repo_url: 'https://github.com/example/demo' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-waits-src-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'FROM scratch\n');
  return dir;
}

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
    collectPodDiagnostics: async () => ({ logs: 'build output', details: 'Exit 1', deadlineExceeded: false }),
    boundedText: (text) => String(text || '').slice(0, 65536),
    getCloneUrl: async (owner, name) => `https://github.com/${owner}/${name}.git`,
  };
}

// A cluster on a timeline, in ms from the moment the Job is created: the
// log's lines at their times (and the stream's end), the container's exit,
// the Job's verdict. `null` for a time is never. The Pod belongs to the Job
// (its controller owner reference carries the Job's UID); `pod(p)` may
// change what the Pod says, `job(j)` what the Job says.
function timedCluster({
  lines = [], streamEndAt = null, podExitAt = 100, exitCode = 0, message = digest('d'),
  jobDoneAt = 3000, jobFailed = false, withLogs = true, patch = async () => {}, previousJobs = [],
  createConflict = false, pod: shapePod = (p) => p, job: shapeJob = (j) => j,
} = {}) {
  const state = {
    jobs: [], secrets: [], deleted: [], patches: [], jobReads: 0, podReads: 0, created: null,
    jobUid: createConflict ? 'uid-existing' : null, annotations: {},
  };
  const since = () => (state.created === null ? -1 : Date.now() - state.created);
  const pod = () => shapePod({
    metadata: {
      name: 'bk-pod', creationTimestamp: '2026-10-19T10:00:00Z', labels: { 'job-name': 'x' },
      ownerReferences: [{ kind: 'Job', controller: true, uid: state.jobUid, name: 'x' }],
    },
    spec: { nodeName: 'worker-3' },
    status: {
      phase: podExitAt !== null && since() >= podExitAt ? (exitCode === 0 ? 'Succeeded' : 'Failed') : 'Running',
      containerStatuses: [{
        name: 'buildkit',
        state: podExitAt !== null && since() >= podExitAt
          ? { terminated: { exitCode, message } }
          : { running: { startedAt: '2026-10-19T10:00:01Z' } },
      }],
    },
  }, since());
  const batch = {
    async listNamespacedJob(request) {
      if (/social\.usernode\.io\/revision=/.test(request.labelSelector || '')) return { items: [] };
      return { items: previousJobs };
    },
    async createNamespacedJob({ body }) {
      if (createConflict) throw Object.assign(new Error('exists'), { code: 409 });
      state.jobs.push(body);
      state.created = Date.now();
      state.jobUid = `uid-${state.jobs.length}`;
      state.annotations = { ...(body.metadata.annotations || {}) };
      return { metadata: { ...body.metadata, uid: state.jobUid } };
    },
    async readNamespacedJob({ name }) {
      state.jobReads += 1;
      if (createConflict && state.created === null) state.created = Date.now();
      const done = jobDoneAt !== null && since() >= jobDoneAt;
      const status = !done ? { active: 1 }
        : jobFailed ? { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }
          : { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] };
      return shapeJob({
        metadata: { name, namespace: 'bk', uid: state.jobUid, resourceVersion: String(state.jobReads), annotations: { ...state.annotations } },
        status,
      }, since());
    },
    async patchNamespacedJob(request) {
      state.patches.push(request);
      Object.assign(state.annotations, request.body?.metadata?.annotations || {});
      return patch(request);
    },
    async deleteNamespacedJob(request) { state.deleted.push({ kind: 'Job', ...request }); },
  };
  const core = {
    async createNamespacedSecret({ body }) { state.secrets.push(body); return { metadata: { ...body.metadata, uid: 'secret-uid-1' } }; },
    async readNamespacedSecret({ name }) { return { metadata: { name, uid: 'secret-uid-1' } }; },
    async replaceNamespacedSecret() {},
    async deleteNamespacedSecret(request) { state.deleted.push({ kind: 'Secret', ...request }); },
    async listNamespacedPod() { state.podReads += 1; return { items: [pod()] }; },
    async readNamespacedPod() { state.podReads += 1; return pod(); },
  };
  const logs = {
    async log(_ns, _pod, _container, sink) {
      const timers = [];
      for (const { at, line } of lines) timers.push(setTimeout(() => sink.write(`${line}\n`), Math.max(0, at - since())));
      if (streamEndAt !== null) timers.push(setTimeout(() => sink.end(), Math.max(0, streamEndAt - since())));
      return { abort() { for (const t of timers) clearTimeout(t); } };
    },
  };
  const clients = { batch, core, ...(withLogs ? { logs } : {}) };
  return { clients, state, since };
}

const build = (cluster, cfg = config(), extra = {}) => buildkit.createBuild(cfg, {
  app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile.kubernetes']), ...extra,
}, runtimeWith(cluster.clients));

test.afterEach(() => {
  kubernetes._setClientsForTest(null);
  buildkit._forTest.resetUnavailable();
});

test('the build is done when its container is: read from the Pod as soon as the log says so, not from the Job seconds later', async () => {
  const cluster = timedCluster({
    lines: [{ at: 20, line: '#9 [shell 3/9] RUN npm ci' }, { at: 80, line: `[buildkit] pushed registry.test/apps/demo:x@${digest('d')}` }],
    podExitAt: 150, jobDoneAt: 3000,
  });
  const result = await build(cluster);
  const at = cluster.since();
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.ok(at >= 150, 'not before the container has exited');
  assert.ok(at < 150 + buildkit._forTest.SETTLE_POLL_MS + 250, `within one settle poll of the exit (took ${at} ms)`);
  assert.ok(at < 3000, 'without waiting for the Job controller');
});

test('a "pushed" line is only a reason to look: the digest comes from the termination message of a container that exited 0', async () => {
  // A RUN step can print anything, this line included. It shares the stream
  // with the script's own output.
  const forged = `[buildkit] pushed registry.test/apps/demo:x@${digest('e')}`;
  const cluster = timedCluster({ lines: [{ at: 10, line: forged }], podExitAt: 600, jobDoneAt: null });
  const result = await build(cluster);
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`, 'the termination message, never the log line');
  assert.ok(cluster.since() >= 600, 'nothing was believed before the container itself had finished');
  assert.ok(cluster.state.podReads >= 2, 'the line made it look, and look again');
});

test('a forged "pushed" line in a build that then fails is a failed build', async () => {
  const forged = `[buildkit] pushed registry.test/apps/demo:x@${digest('e')}`;
  const cluster = timedCluster({ lines: [{ at: 10, line: forged }], podExitAt: 100, exitCode: 1, message: digest('e'), jobDoneAt: 500, jobFailed: true });
  await assert.rejects(build(cluster), (err) => {
    assert.equal(err.buildFailed, true);
    assert.match(err.message, /failed: BackoffLimitExceeded/);
    return true;
  });
  assert.equal(cluster.state.deleted.filter((d) => d.kind === 'Job').length, 1, 'and its Job is removed, as before');
});

test('a container that exited 0 without a digest is a failure, before the Job says anything', async () => {
  const cluster = timedCluster({ lines: [{ at: 10, line: '[buildkit] pushed x' }], podExitAt: 50, message: 'cache-upload=done\n', jobDoneAt: null });
  await assert.rejects(build(cluster), /finished without an image digest/);
});

test('a running container keeps the build waiting, and the Job\'s verdict still ends it as before', async () => {
  const cluster = timedCluster({ lines: [], podExitAt: null, jobDoneAt: 1200 });
  // The Job succeeded; its Pod read now (the fake keeps it "running") holds
  // no digest, which the Job path reports as before.
  await assert.rejects(build(cluster), /finished without an image digest/);
  assert.ok(cluster.since() >= 1200);
  assert.ok(cluster.state.podReads <= 2, `the Pod is looked up to follow its log and for the Job's result, not on every tick (${cluster.state.podReads})`);
});

test('with no log to follow, the Pod is read on every tick', async () => {
  const cluster = timedCluster({ withLogs: false, podExitAt: 100, jobDoneAt: 5000 });
  const result = await build(cluster);
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.ok(cluster.since() < buildkit._forTest.POLL_MS + 500, `one poll after the exit at most (took ${cluster.since()} ms)`);
});

test('a log stream that closes is a reason to look', async () => {
  const cluster = timedCluster({ lines: [], streamEndAt: 100, podExitAt: 120, jobDoneAt: 5000 });
  await build(cluster);
  assert.ok(cluster.since() < 120 + buildkit._forTest.SETTLE_POLL_MS + 250, `took ${cluster.since()} ms`);
});

test('the digest annotation is written, but the deploy does not wait for it', { timeout: 10000 }, async () => {
  let release;
  const cluster = timedCluster({
    lines: [{ at: 10, line: '[buildkit] pushed x' }], podExitAt: 20,
    patch: () => new Promise((resolve) => { release = resolve; }),
  });
  const result = await build(cluster);
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.equal(cluster.state.patches.length, 1);
  assert.deepEqual(cluster.state.patches[0].body.metadata.annotations['social.usernode.io/image-digest'], digest('d'));
  release();
  // A patch that fails is a warning, never a failed build.
  const failing = timedCluster({ lines: [{ at: 10, line: '[buildkit] pushed x' }], podExitAt: 20, patch: async () => { throw new Error('conflict'); } });
  await build(failing);
  await sleep(10);
});

// ── the build script: the preflight beside the fetch ────────────────────

// Runs BUILD_SCRIPT under sh with stand-ins for buildctl and git, each
// sleeping and exiting as told, its absolute paths moved into a scratch
// directory. Resolves with the exit code, the output, the stand-ins' calls
// and the wall time.
function runScript({ preflightMs = 0, preflightExit = 0, fetchMs = 0, fetchExit = 0, termAfterMs = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-waits-script-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const sleepFor = (ms) => `sleep ${(ms / 1000).toFixed(3)}`;
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'printf \'git %s\\n\' "$*" >> "$STUB_DIR/calls.log"',
    'case "$*" in *" fetch "*) ' + sleepFor(fetchMs) + '; printf \'git fetch done\\n\' >> "$STUB_DIR/calls.log"; exit $STUB_FETCH_EXIT ;; esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'buildctl-daemonless.sh'), [
    '#!/bin/sh',
    'printf \'buildctl %s\\n\' "$1" >> "$STUB_DIR/calls.log"',
    'if [ "$1" = debug ]; then ' + sleepFor(preflightMs) + '; exit $STUB_PREFLIGHT_EXIT; fi',
    'metadata=',
    'while [ $# -gt 0 ]; do case "$1" in --metadata-file) metadata=$2 ;; esac; shift; done',
    '[ -n "$metadata" ] && printf \'{\\n  "containerimage.digest": "%s"\\n}\\n\' "$STUB_DIGEST" > "$metadata"',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  const script = buildkit._forTest.BUILD_SCRIPT
    .replaceAll('/workspace', path.join(dir, 'workspace'))
    .replaceAll('/dev/termination-log', path.join(dir, 'termination-log'));
  const env = {
    PATH: `${bin}:${process.env.PATH}`, REPO_URL: 'https://example.test/clone', GIT_SHA: revision,
    DOCKERFILE: 'Dockerfile.kubernetes', IMAGE_TAG: 'registry.test/apps/demo:x', CACHE_REF: 'registry.test/cache/demo:c',
    REGISTRY_ATTRS: '', CACHE_UPLOAD: 'always', STUB_DIR: dir, STUB_DIGEST: digest('d'),
    STUB_PREFLIGHT_EXIT: String(preflightExit), STUB_FETCH_EXIT: String(fetchExit),
  };
  const started = Date.now();
  // `ms` is when the script itself exited; `calls` is read once the
  // stand-ins have had the whole fetch time to say they finished, so a
  // fetch the script stopped shows as one that never did.
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { env });
    if (termAfterMs !== null) setTimeout(() => child.kill('SIGTERM'), termAfterMs);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code, signal) => {
      const ms = Date.now() - started;
      setTimeout(() => {
        const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
        resolve({ code: code ?? signal, out, calls, ms });
      }, Math.max(50, fetchMs - ms + 300));
    });
  });
}

test('the script: the daemon preflight and the source fetch run side by side', async () => {
  const run = await runScript({ preflightMs: 700, fetchMs: 700 });
  assert.equal(run.code, 0, run.out);
  assert.ok(run.ms < 1250, `the two overlap (took ${run.ms} ms; one after the other is 1400 ms or more)`);
  assert.match(run.calls, /buildctl build/, 'and the build follows');
});

test('the script: a daemon that cannot start exits 75, whether or not the fetch worked, and builds nothing', async () => {
  for (const fetchExit of [0, 128]) {
    const run = await runScript({ preflightMs: 100, preflightExit: 1, fetchExit });
    assert.equal(run.code, buildkit._forTest.PREFLIGHT_EXIT, `fetch exit ${fetchExit}: ${run.out}`);
    assert.match(run.out, /buildkitd cannot run here/);
    assert.doesNotMatch(run.calls, /buildctl build/);
  }
  // Even when the fetch fails long before the preflight answers.
  const late = await runScript({ preflightMs: 400, preflightExit: 1, fetchExit: 128 });
  assert.equal(late.code, 75);
});

test('the script: a fetch that fails on a node that can build is the fetch\'s failure, and builds nothing', async () => {
  const run = await runScript({ fetchExit: 128 });
  assert.equal(run.code, 128, run.out);
  assert.match(run.out, /fetching source failed/);
  assert.doesNotMatch(run.calls, /buildctl build/);
  assert.doesNotMatch(run.out, /example\.test\/clone/, 'the clone URL is still never printed');
});

// ── review rounds 1 and 2: what the success paths and the script must not do ──

test('the script: a stalled fetch does not hold back exit 75; the fetch is stopped and reaped', async () => {
  const run = await runScript({ preflightMs: 20, preflightExit: 1, fetchMs: 2000 });
  assert.equal(run.code, buildkit._forTest.PREFLIGHT_EXIT, run.out);
  assert.ok(run.ms < 1000, `exits as soon as the preflight fails (took ${run.ms} ms)`);
  assert.doesNotMatch(run.calls, /git fetch done/, 'the fetch was stopped, not left to finish');
});

test('the script: a TERM during the fetch (the Job\'s deadline) stops the fetch too', async () => {
  const run = await runScript({ preflightMs: 3000, fetchMs: 2000, termAfterMs: 300 });
  assert.equal(run.code, 143, run.out);
  assert.ok(run.ms < 1000, `took ${run.ms} ms`);
  assert.doesNotMatch(run.calls, /git fetch done/);
  assert.doesNotMatch(run.calls, /buildctl build/);
});

const pushedSoon = { lines: [{ at: 10, line: '[buildkit] pushed x' }] };

test('a finished Pod of an older Job of the same name never completes this build', async () => {
  // The Job was deleted in the background and made again; its old Pod,
  // which succeeded, still carries the `job-name` label.
  const cluster = timedCluster({
    ...pushedSoon, podExitAt: 0, jobDoneAt: 400, jobFailed: true,
    pod: (p) => { p.metadata.ownerReferences[0].uid = 'uid-of-the-old-job'; return p; },
  });
  await assert.rejects(build(cluster), /failed: BackoffLimitExceeded/, 'the current Job\'s verdict decides');
});

test('a Job that is failing (FailureTarget) is never completed by its Pod, and still reports its deadline', async () => {
  const cluster = timedCluster({
    ...pushedSoon, podExitAt: 0, jobDoneAt: null,
    job: (j, t) => {
      j.status = t < 400
        ? { active: 1, conditions: [{ type: 'FailureTarget', status: 'True', reason: 'DeadlineExceeded' }] }
        : { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] };
      return j;
    },
  });
  await assert.rejects(build(cluster), (err) => {
    assert.match(err.message, /failed: DeadlineExceeded/);
    assert.equal(err.killed, true);
    return true;
  });
});

test('a failed or deleting Pod is no result, whatever its container says', async () => {
  for (const [why, shape] of [
    ['phase Failed', (p) => { p.status.phase = 'Failed'; return p; }],
    ['being deleted', (p) => { p.metadata.deletionTimestamp = '2026-10-19T10:00:02Z'; return p; }],
  ]) {
    const cluster = timedCluster({ ...pushedSoon, podExitAt: 0, jobDoneAt: 400, jobFailed: true, pod: shape });
    await assert.rejects(build(cluster), /failed: BackoffLimitExceeded/, why);
  }
});

test('a container\'s earlier termination (lastState) is history, not a result', async () => {
  const cluster = timedCluster({
    ...pushedSoon, podExitAt: null, jobDoneAt: 400, jobFailed: true,
    pod: (p) => { p.status.containerStatuses[0].lastState = { terminated: { exitCode: 0, message: digest('e') } }; return p; },
  });
  await assert.rejects(build(cluster), /failed: BackoffLimitExceeded/);
});

test('a Job made again under the same name is another build\'s: its result is not taken, and its cleanup cannot remove it', async () => {
  const cluster = timedCluster({ ...pushedSoon, podExitAt: 0, jobDoneAt: 0 });
  const handle = await buildkit._forTest.startBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, dockerfile: 'Dockerfile.kubernetes',
  }, runtimeWith(cluster.clients));
  cluster.state.jobUid = 'uid-of-a-newer-job'; // completed, and its Pod with it
  await assert.rejects(buildkit._forTest.finishBuild(handle, {}, runtimeWith(cluster.clients)), /no longer the Job this build started/);
  const failDelete = cluster.state.deleted.find((d) => d.kind === 'Job');
  assert.deepEqual(failDelete.body.preconditions, { uid: 'uid-1' }, 'the cleanup is fenced to the Job this build made');
});

test('finishedPod: a result only from a Pod of this Job that exited 0, never from another Job\'s, a failed or a deleting one', () => {
  const { finishedPod } = buildkit._forTest;
  const pod = (extra = {}) => ({
    metadata: { name: 'p', ownerReferences: [{ kind: 'Job', controller: true, uid: 'uid-1' }], ...(extra.metadata || {}) },
    status: { phase: 'Succeeded', containerStatuses: [{ name: 'buildkit', state: { terminated: { exitCode: 0, message: digest('d') } } }], ...(extra.status || {}) },
  });
  assert.equal(finishedPod(pod(), 'job', 'uid-1').digest, digest('d'));
  assert.equal(finishedPod(pod(), 'job', 'uid-2'), null, 'another Job\'s Pod');
  assert.equal(finishedPod(pod(), 'job', null), null, 'no Job to match it against');
  assert.equal(finishedPod(pod({ metadata: { ownerReferences: [{ kind: 'Job', controller: false, uid: 'uid-1' }] } }), 'job', 'uid-1'), null,
    'an owner that is not the controller');
  assert.equal(finishedPod(pod({ status: { phase: 'Failed' } }), 'job', 'uid-1'), null);
  // A container that exited non-zero before the kubelet has moved the Pod
  // to Failed: its message may still carry a digest from the build output.
  assert.equal(finishedPod(pod({ status: { phase: 'Running', containerStatuses: [{ name: 'buildkit',
    state: { terminated: { exitCode: 1, message: digest('e') } } }] } }), 'job', 'uid-1'), null);
  assert.equal(finishedPod(pod({ metadata: { deletionTimestamp: 'now' } }), 'job', 'uid-1'), null);
});

test('the Job\'s own success is checked as the fast path is: failure first, its own Pod, a build container that exited 0', async () => {
  // Succeeded Pods counted while the controller has already decided the Job
  // fails: failure wins, as the Job controller decides it.
  const failing = timedCluster({
    withLogs: false, podExitAt: 0, jobDoneAt: null,
    job: (j, t) => {
      j.status = t < 300
        ? { succeeded: 1, conditions: [{ type: 'FailureTarget', status: 'True', reason: 'DeadlineExceeded' }] }
        : { succeeded: 1, failed: 0, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] };
      return j;
    },
  });
  await assert.rejects(build(failing), (err) => /failed: DeadlineExceeded/.test(err.message) && err.killed === true);
  // A Job that says it succeeded, whose build container did not exit 0.
  const failedContainer = timedCluster({ withLogs: false, podExitAt: 0, exitCode: 1, message: digest('e'), jobDoneAt: 0 });
  failedContainer.clients.batch.readNamespacedJob = (orig => async (r) => {
    const j = await orig(r); j.status = { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }; return j;
  })(failedContainer.clients.batch.readNamespacedJob);
  await assert.rejects(build(failedContainer), /finished without an image digest/);
  // A completed Job whose Pod belongs to another Job.
  const otherPod = timedCluster({
    withLogs: false, podExitAt: 0, jobDoneAt: 0,
    pod: (p) => { p.metadata.ownerReferences[0].uid = 'uid-of-the-old-job'; return p; },
  });
  await assert.rejects(build(otherPod), /finished without an image digest/);
});

test('the fast path leaves a Pod with a container besides the build\'s to the Job\'s verdict', async () => {
  const cluster = timedCluster({
    ...pushedSoon, podExitAt: 0, jobDoneAt: 600,
    pod: (p) => { p.status.containerStatuses.push({ name: 'sidecar', state: { running: {} } }); return p; },
  });
  const result = await build(cluster);
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.ok(cluster.since() >= 600, 'only once the Job itself succeeded');
});

test('the script: a TERM after the preflight succeeded still stops the fetch and exits 143', async () => {
  const run = await runScript({ preflightMs: 50, fetchMs: 2000, termAfterMs: 400 });
  assert.equal(run.code, 143, run.out);
  assert.ok(run.ms < 1000, `took ${run.ms} ms`);
  assert.doesNotMatch(run.calls, /git fetch done/);
  assert.doesNotMatch(run.calls, /checkout-index|read-tree/, 'the checkout never runs');
  assert.doesNotMatch(run.calls, /buildctl build/);
});
