'use strict';

// The platform's own waits around a BuildKit preview build
// (src/services/kubernetes-buildkit.js, src/services/kubernetes.js):
//
//   - the build is done when its container is: the Pod's own status, read
//     as soon as the log says the script ended, not the Job's, which lagged
//     it by about three seconds; and the digest still comes only from the
//     termination message of a container that exited 0, never from the log;
//   - the digest annotation is written without the deploy waiting for it;
//   - the Job's daemon preflight runs beside its source fetch, and its
//     verdict still decides first;
//   - a build started before the caller has the tree (startEarlyBuild) is
//     waited on only when the tree is what it was started for, and is
//     cancelled otherwise; only a Job the start made is ever removed.

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
// the Job's verdict. `null` for a time is never.
function timedCluster({
  lines = [], streamEndAt = null, podExitAt = 100, exitCode = 0, message = digest('d'),
  jobDoneAt = 3000, jobFailed = false, withLogs = true, patch = async () => {}, previousJobs = [],
  createConflict = false,
} = {}) {
  const state = { jobs: [], secrets: [], deleted: [], patches: [], jobReads: 0, podReads: 0, created: null };
  const since = () => (state.created === null ? -1 : Date.now() - state.created);
  const pod = () => ({
    metadata: { name: 'bk-pod', creationTimestamp: '2026-10-19T10:00:00Z' },
    spec: { nodeName: 'worker-3' },
    status: {
      containerStatuses: [{
        name: 'buildkit',
        state: podExitAt !== null && since() >= podExitAt
          ? { terminated: { exitCode, message } }
          : { running: { startedAt: '2026-10-19T10:00:01Z' } },
      }],
    },
  });
  const batch = {
    async listNamespacedJob(request) {
      if (/social\.usernode\.io\/revision=/.test(request.labelSelector || '')) return { items: [] };
      return { items: previousJobs };
    },
    async createNamespacedJob({ body }) {
      if (createConflict) throw Object.assign(new Error('exists'), { code: 409 });
      state.jobs.push(body);
      state.created = Date.now();
      return { metadata: { ...body.metadata, uid: `uid-${state.jobs.length}` } };
    },
    async readNamespacedJob({ name }) {
      state.jobReads += 1;
      if (createConflict && state.created === null) state.created = Date.now();
      const done = jobDoneAt !== null && since() >= jobDoneAt;
      const status = !done ? { active: 1 }
        : jobFailed ? { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] }
          : { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] };
      return { metadata: { name, namespace: 'bk' }, status };
    },
    async patchNamespacedJob(request) { state.patches.push(request); return patch(request); },
    async deleteNamespacedJob(request) { state.deleted.push({ kind: 'Job', ...request }); },
  };
  const core = {
    async createNamespacedSecret({ body }) { state.secrets.push(body); },
    async readNamespacedSecret({ name }) { return { metadata: { name } }; },
    async replaceNamespacedSecret() {},
    async deleteNamespacedSecret(request) { state.deleted.push({ kind: 'Secret', ...request }); },
    async listNamespacedPod() { return { items: [pod()] }; },
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
  assert.equal(cluster.state.podReads, 0, 'a followed log that has not ended costs no Pod reads');
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
function runScript({ preflightMs = 0, preflightExit = 0, fetchMs = 0, fetchExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-waits-script-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const sleepFor = (ms) => `sleep ${(ms / 1000).toFixed(3)}`;
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'printf \'git %s\\n\' "$*" >> "$STUB_DIR/calls.log"',
    'case "$*" in *" fetch "*) ' + sleepFor(fetchMs) + '; exit $STUB_FETCH_EXIT ;; esac',
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
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
      resolve({ code, out, calls, ms: Date.now() - started });
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

// ── a build started before the tree is in hand ──────────────────────────

const previousJob = (dockerfile, created = '2026-10-19T09:00:00Z') => ({
  metadata: { name: `bk-12-old-${dockerfile}`, creationTimestamp: created },
  spec: { template: { spec: { containers: [{ name: 'buildkit', env: [{ name: 'DOCKERFILE', value: dockerfile }] }] } } },
  status: { succeeded: 1 },
});

test('previousDockerfile: the newest build\'s Dockerfile, when it is one this platform would pick', async () => {
  const run = (jobs) => buildkit.previousDockerfile(config(), 12, runtimeWith(timedCluster({ previousJobs: jobs }).clients));
  assert.equal(await run([]), null, 'no history, no guess');
  assert.equal(await run([previousJob('Dockerfile', '2026-10-18T00:00:00Z'), previousJob('Dockerfile.kubernetes', '2026-10-19T00:00:00Z')]),
    'Dockerfile.kubernetes');
  assert.equal(await run([previousJob('deploy/Dockerfile')]), null, 'not a candidate here any more');
});

test('startEarlyBuild: nothing under kpack, while the lane is remembered unavailable, without a full SHA or without history', async () => {
  const cluster = timedCluster({ previousJobs: [previousJob('Dockerfile.kubernetes')] });
  kubernetes._setClientsForTest(cluster.clients);
  const params = { app, revision, environment: 'staging', sessionId: 42 };
  assert.equal(await kubernetes.startEarlyBuild(config({ buildEngine: 'kpack' }), params), null);
  assert.equal(await kubernetes.startEarlyBuild(config(), { ...params, revision: 'abc' }), null);
  buildkit.noteUnavailable(new Error('no user namespaces'));
  assert.equal(await kubernetes.startEarlyBuild(config(), params), null);
  buildkit._forTest.resetUnavailable();
  kubernetes._setClientsForTest(timedCluster().clients);
  assert.equal(await kubernetes.startEarlyBuild(config(), params), null, 'no build to guess the Dockerfile from');
  assert.equal(cluster.state.jobs.length, 0);
});

test('an early build that fits the tree is the build: no second Job, and the result says it started early', async () => {
  const cluster = timedCluster({ previousJobs: [previousJob('Dockerfile.kubernetes')], lines: [{ at: 10, line: '[buildkit] pushed x' }], podExitAt: 20 });
  kubernetes._setClientsForTest(cluster.clients);
  const early = await kubernetes.startEarlyBuild(config(), { app, revision: revision.toUpperCase(), environment: 'staging', sessionId: 42 });
  assert.equal(early.dockerfile, 'Dockerfile.kubernetes');
  assert.equal(early.revision, revision, 'the commit as git spells it');
  assert.equal(cluster.state.jobs.length, 1, 'the Job exists before the tree does');
  const env = Object.fromEntries(cluster.state.jobs[0].spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
  assert.equal(env.DOCKERFILE, 'Dockerfile.kubernetes');
  assert.equal(env.GIT_SHA, revision);
  const result = await kubernetes.createBuild(config(), {
    app, revision, environment: 'staging', sessionId: 42, sourceDir: sourceTree(['Dockerfile.kubernetes', 'Dockerfile']), early,
  });
  assert.equal(result.imageRef, `registry.test/apps/demo@${digest('d')}`);
  assert.equal(result.earlyStart, true);
  assert.equal(cluster.state.jobs.length, 1, 'no second Job');
  assert.equal(cluster.state.deleted.length, 0);
});

test('an early build the tree does not fit is cancelled (its Job and its Secret), and the tree is built as before', async () => {
  const cases = [
    { why: 'another Dockerfile', tree: ['Dockerfile'], rev: revision, jobs: 2 },
    { why: 'another commit', tree: ['Dockerfile.kubernetes'], rev: 'c'.repeat(40), jobs: 2 },
    { why: 'no Dockerfile at all (kpack)', tree: [], rev: revision, jobs: 1 },
  ];
  for (const c of cases) {
    const cluster = timedCluster({ previousJobs: [previousJob('Dockerfile.kubernetes')], lines: [{ at: 10, line: '[buildkit] pushed x' }], podExitAt: 20 });
    kubernetes._setClientsForTest({
      ...cluster.clients,
      custom: {
        async listNamespacedCustomObject() { return { items: [] }; },
        async createNamespacedCustomObject() {},
        async getNamespacedCustomObject() {
          return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: `registry.test/apps/demo@${digest('c')}` } };
        },
      },
    });
    const early = await kubernetes.startEarlyBuild(config(), { app, revision, environment: 'staging', sessionId: 42 });
    const result = await kubernetes.createBuild(config(), {
      app, revision: c.rev, environment: 'staging', sessionId: 42, sourceDir: sourceTree(c.tree), early,
    });
    assert.equal(result.earlyStart, undefined, c.why);
    const earlyName = cluster.state.jobs[0].metadata.name;
    assert.ok(cluster.state.deleted.some((d) => d.kind === 'Job' && d.name === earlyName && d.propagationPolicy === 'Background'), `${c.why}: the early Job goes`);
    assert.ok(cluster.state.deleted.some((d) => d.kind === 'Secret' && d.name === `${earlyName}-input`), `${c.why}: and its clone credential`);
    assert.equal(cluster.state.jobs.length, c.jobs, `${c.why}: the tree is built by its own builder`);
  }
});

test('cancelling removes only a Job the start made: one it found under the same name may be another attempt\'s', async () => {
  const cluster = timedCluster({ previousJobs: [previousJob('Dockerfile.kubernetes')], createConflict: true, podExitAt: null, jobDoneAt: null });
  kubernetes._setClientsForTest(cluster.clients);
  const early = await kubernetes.startEarlyBuild(config(), { app, revision, environment: 'staging', sessionId: 42 });
  assert.equal(early.createdHere, false);
  assert.equal(await kubernetes.cancelEarlyBuild(config(), early), false);
  assert.equal(cluster.state.deleted.length, 0);
  // A start that made its Job removes it.
  const own = timedCluster({ previousJobs: [previousJob('Dockerfile.kubernetes')] });
  kubernetes._setClientsForTest(own.clients);
  const made = await kubernetes.startEarlyBuild(config(), { app, revision, environment: 'staging', sessionId: 42 });
  assert.equal(await kubernetes.cancelEarlyBuild(config(), made), true);
  assert.deepEqual(own.state.deleted.map((d) => d.kind).sort(), ['Job', 'Secret']);
});

test('an early start the lane refuses is remembered under auto, and the build goes to kpack', async () => {
  const forbidden = Object.assign(new Error('jobs.batch is forbidden'), { code: 403 });
  const cluster = timedCluster({ previousJobs: [previousJob('Dockerfile.kubernetes')] });
  cluster.clients.batch.createNamespacedJob = async () => { throw forbidden; };
  kubernetes._setClientsForTest(cluster.clients);
  await assert.rejects(kubernetes.startEarlyBuild(config(), { app, revision, environment: 'staging', sessionId: 42 }), /lane unavailable/);
  assert.ok(buildkit.unavailableReason(), 'the next build does not try the lane again at once');
  assert.ok(cluster.state.deleted.some((d) => d.kind === 'Secret'), 'the clone credential does not outlive the refusal');
});
