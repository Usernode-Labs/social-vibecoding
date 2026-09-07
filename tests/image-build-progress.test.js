'use strict';

// Image build progress. The "build image" step used to sit for minutes with
// nothing inside it. Now:
//   - on kubernetes the kpack Build's pod runs the buildpack lifecycle as
//     init containers, and their own start/finish stamps give each phase's
//     time; the running phase's log is followed for a detail line;
//   - on docker the builder's step counter is read off the build output;
//   - the staging build hands it on at most once a second, and keeps the
//     finished phases in the timings so the checks trace and the ledger can
//     say which phase a slow build spent its time in;
//   - the topic page draws the phases under the image step with the detail.
//
// Run with: node --test tests/image-build-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const kubernetes = require('../src/services/kubernetes');
const docker = require('../src/services/docker');
const visuals = require('../src/services/visuals');
const staging = require('../src/services/staging');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const T = (s) => `2026-09-07T09:00:${String(s).padStart(2, '0')}Z`;
function pod(states) {
  const names = ['prepare', 'analyze', 'detect', 'restore', 'build', 'export'];
  return {
    spec: { initContainers: names.map((name) => ({ name })) },
    status: {
      initContainerStatuses: names.map((name) => ({ name, state: states[name] || { waiting: {} } })),
      containerStatuses: [{ name: 'completion', state: states.completion || { waiting: {} } }],
    },
  };
}

test('buildPhasesFromPod reads the lifecycle off the pod: finished phases with their times, then the running one', () => {
  const p = kubernetes._buildPhasesFromPodForTest(pod({
    prepare: { terminated: { startedAt: T(0), finishedAt: T(4) } },
    analyze: { terminated: { startedAt: T(4), finishedAt: T(6) } },
    detect: { running: { startedAt: T(6) } },
  }));
  assert.equal(p.phase, 'detect');
  assert.deepEqual(p.phases, [{ name: 'prepare', ms: 4000 }, { name: 'analyze', ms: 2000 }]);
  assert.equal(p.runningSince, T(6));
  const scheduled = kubernetes._buildPhasesFromPodForTest(pod({}));
  assert.equal(scheduled.phase, 'prepare', 'nothing running yet reads as the first phase');
  assert.deepEqual(scheduled.phases, []);
  const all = {};
  for (const [i, n] of ['prepare', 'analyze', 'detect', 'restore', 'build', 'export'].entries()) all[n] = { terminated: { startedAt: T(i), finishedAt: T(i + 1) } };
  const done = kubernetes._buildPhasesFromPodForTest(pod({ ...all, completion: { running: { startedAt: T(9) } } }));
  assert.equal(done.phase, 'completion');
  assert.equal(done.phases.length, 6);
  assert.deepEqual(kubernetes._buildPhasesFromPodForTest(null), { phase: null, phases: [], runningSince: null, order: [] });
});

test('createBuild reports each phase as the pod advances, follows the running phase, and keeps the phases on the result', async () => {
  let reads = 0;
  const follows = [];
  const sinks = [];
  let aborted = 0;
  const pods = [
    pod({ prepare: { running: { startedAt: T(0) } } }),
    pod({ prepare: { terminated: { startedAt: T(0), finishedAt: T(3) } }, build: { running: { startedAt: T(5) } },
      analyze: { terminated: { startedAt: T(3), finishedAt: T(4) } }, detect: { terminated: { startedAt: T(4), finishedAt: T(4) } }, restore: { terminated: { startedAt: T(4), finishedAt: T(5) } } }),
  ];
  const finalPod = pod(Object.fromEntries(['prepare', 'analyze', 'detect', 'restore', 'build', 'export'].map((n, i) => [n, { terminated: { startedAt: T(i), finishedAt: T(i + 2) } }])));
  kubernetes._setClientsForTest({
    custom: {
      async createNamespacedCustomObject() {},
      async getNamespacedCustomObject() {
        reads += 1;
        if (reads >= 3) return { status: { podName: 'bp-pod', conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/x/demo@sha256:1' } };
        return { status: { podName: 'bp-pod', conditions: [] } };
      },
    },
    core: {
      async readNamespacedPod({ name, namespace }) {
        assert.equal(name, 'bp-pod'); assert.equal(namespace, 'social-builds');
        return reads >= 3 ? finalPod : pods[Math.min(reads - 1, pods.length - 1)];
      },
    },
    logs: {
      async log(ns, podName, container, sink) {
        follows.push(container); sinks.push(sink);
        return { abort() { aborted += 1; } };
      },
    },
  });
  const seen = [];
  const t = setTimeout;
  global.setTimeout = (fn, ms, ...rest) => t(fn, ms === 3000 ? 5 : ms, ...rest);
  try {
    const run = kubernetes.createBuild({ kubernetes: {
      buildNamespace: 'social-builds', buildServiceAccount: 'sa', repositoryPrefix: 'ghcr.io/x', cacheRepositoryPrefix: 'ghcr.io/c',
      builderImage: 'b@sha256:0', nodeVersion: '22.*', activeDeadlineSeconds: 30,
    } }, {
      app: { id: 1, slug: 'demo', repo_url: 'https://github.com/x/demo' }, revision: 'a'.repeat(40), environment: 'staging', sessionId: 9,
      onProgress: (img) => seen.push(img),
    });
    await new Promise((r) => t(r, 8));
    // The build phase's log is being followed by now; a line becomes the detail.
    const buildSink = sinks[follows.indexOf('build')];
    if (buildSink) buildSink.write("\x1b[36m  Running 'npm ci'\x1b[0m\n");
    const result = await run;
    assert.deepEqual(follows, ['prepare', 'build'], 'each running phase is followed once, in turn');
    assert.ok(seen.some((s) => s.phase === 'prepare' && s.phases.length === 0));
    assert.ok(seen.some((s) => s.phase === 'build' && s.phases.map((p) => p.name).join(',') === 'prepare,analyze,detect,restore'));
    assert.ok(seen.some((s) => s.detail === "Running 'npm ci'"), 'ANSI stripped, trimmed');
    assert.equal(result.phases.length, 6, 'the finished lifecycle with its times');
    assert.equal(result.phases[4].ms, 2000);
    assert.ok(aborted >= 1, 'the follow is closed');
  } finally {
    global.setTimeout = t;
    kubernetes._setClientsForTest(null);
  }
});

test('docker build lines: the classic step counter and BuildKit stage steps', () => {
  assert.deepEqual(docker.parseDockerBuildLine('Step 4/31 : RUN npm ci --production'), { index: 4, total: 31, phase: null, detail: 'RUN npm ci --production' });
  assert.deepEqual(docker.parseDockerBuildLine('#7 [shell 4/9] RUN npm ci --ignore-scripts'), { index: 4, total: 9, phase: 'shell', detail: 'RUN npm ci --ignore-scripts' });
  assert.deepEqual(docker.parseDockerBuildLine('#12 [stage-2 3/12] COPY . .'), { index: 3, total: 12, phase: 'stage-2', detail: 'COPY . .' });
  assert.deepEqual(docker.parseDockerBuildLine('#3 [internal] load metadata for docker.io/library/node:22-alpine'), { index: null, total: null, phase: 'internal', detail: 'load metadata for docker.io/library/node:22-alpine' });
  assert.equal(docker.parseDockerBuildLine(' ---> Using cache'), null);
  assert.equal(docker.parseDockerBuildLine(''), null);
  const src = read('src/services/docker.js');
  assert.match(src, /if \(promise\.child\.stdout\) attachLineObserver\(promise\.child\.stdout, observe\);\n\s+if \(promise\.child\.stderr\) attachLineObserver\(promise\.child\.stderr, observe\);/);
});

test('the staging build hands image progress on once a second, keeps the last one, and records the phases', async () => {
  const calls = [];
  const savedSet = visuals.setChecksBuildProgress;
  const savedNotify = visuals.notifyChecksBuildProgress;
  visuals.setChecksBuildProgress = async () => true;
  visuals.notifyChecksBuildProgress = (_id, build) => calls.push(build);
  const poolMod = require('../src/db/pool');
  const savedGetPool = poolMod.getPool;
  try {
    const timings = { sourceFetchMs: 1000 };
    const r = staging._makeImageProgressReporterForTest({}, { id: 5 }, timings, Date.now());
    r.report({ phase: 'prepare', phases: [], detail: null });
    r.report({ phase: 'prepare', phases: [], detail: 'Cloning' });
    r.report({ phase: 'analyze', phases: [{ name: 'prepare', ms: 3000 }], detail: null });
    assert.equal(calls.length, 1, 'inside the gap: one flush so far');
    assert.equal(calls[0].step, 'image_build');
    assert.equal(calls[0].image.phase, 'prepare');
    await new Promise((res) => setTimeout(res, 1100));
    assert.equal(calls.length, 2, 'the trailing report is delivered');
    assert.equal(calls[1].image.phase, 'analyze');
    assert.deepEqual(r.last().phases, [{ name: 'prepare', ms: 3000 }]);
    r.close();
  } finally {
    visuals.setChecksBuildProgress = savedSet;
    visuals.notifyChecksBuildProgress = savedNotify;
    poolMod.getPool = savedGetPool;
  }
  const src = read('src/services/staging.js');
  assert.match(src, /onProgress: imageProgress\.report,/);
  assert.match(src, /timings\.imagePhases = finalImage\.phases;/);
  assert.match(read('src/services/application-runtime.js'), /kubernetes\.createBuild\(config, \{ app, environment, sessionId, revision, sourceDir, onProgress \}\)|kubernetes\.createBuild\(config, \{ app, revision, environment, sessionId, sourceDir, onProgress \}\)/);
  const build = visuals.buildProgressFromTimings({ imageBuildMs: 184000, imagePhases: [{ name: 'restore', ms: 20000 }, { name: 'build', ms: 121000.4 }, { name: 'export', ms: 35000 }] });
  assert.deepEqual(build.steps[0], { key: 'image_build', ms: 184000, phases: [{ name: 'restore', ms: 20000 }, { name: 'build', ms: 121000 }, { name: 'export', ms: 35000 }] });
});

// ── the topic page ──────────────────────────────────────────────────────

const APP_VIEW_SRC = read('public/js/app-view.js');
function makeAppView() {
  const sandbox = {
    console, relTime: () => 'just now',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: { getElementById: () => null, querySelector: () => ({ innerHTML: '' }), querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), body: { appendChild() {} }, hidden: false },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('the image step shows its phases and the running phase\'s line while building', () => {
  const AppView = makeAppView();
  const view = AppView._checksProgressView({ checks_progress: { build: {
    step: 'image_build', startedAt: 'x', steps: [{ key: 'source_fetch', ms: 2000 }],
    image: { phase: 'build', phases: [{ name: 'prepare', ms: 3000 }, { name: 'analyze', ms: 1000 }, { name: 'detect', ms: 500 }, { name: 'restore', ms: 20000 }], detail: "Running 'npm ci'" },
  } } });
  assert.equal(view.build.sentence, "Preview build: branch fetched (2s), now building the preview image (running the buildpacks: Running 'npm ci').");
  assert.equal(view.sub, "build: building the preview image (running the buildpacks: Running 'npm ci')");
  const img = plain(view.bar.build[1]);
  assert.equal(img.key, 'image_build');
  assert.deepEqual(img.phases.map((p) => [p.name, p.state, p.ms]), [
    ['prepare', 'done', 3000], ['analyze', 'done', 1000], ['detect', 'done', 500], ['restore', 'done', 20000], ['build', 'now', null], ['export', 'todo', null],
  ]);
  assert.equal(img.detail, "Running 'npm ci'");
  // docker's counter reads as a step of N.
  const dk = AppView._imageProgressView({ phase: 'shell', index: 4, total: 9, detail: 'RUN npm ci' });
  assert.equal(dk.doing, 'step 4 of 9 in shell: RUN npm ci');
  assert.deepEqual(plain(dk.phases).map((p) => [p.name, p.state]), [['shell', 'now']], 'no invented lifecycle for a stage list it was not given');
});

test('the finished image step names its phases so a slow build says where the time went', () => {
  const AppView = makeAppView();
  const view = AppView._checksProgressView({ checks_progress: { ran: 1, passed: 1, failed: 0, expected: 5, build: {
    step: 'done', totalMs: 200000,
    steps: [{ key: 'source_fetch', ms: 2000 }, { key: 'image_build', ms: 184000, phases: [{ name: 'restore', ms: 20000 }, { name: 'build', ms: 121000 }, { name: 'export', ms: 35000 }] }, { key: 'clone', ms: 2000, via: 'template' }, { key: 'health', ms: 7000 }],
  } } });
  assert.equal(view.build.sentence, 'Preview built in 3m 20s: branch fetched (2s), image built (3m 4s: restore 20s, build 2m 1s, export 35s), database cloned from template (2s), preview started (7s).');
  const img = plain(view.bar.build[1]);
  assert.deepEqual(img.phases.map((p) => [p.name, p.state, p.ms]), [['restore', 'done', 20000], ['build', 'done', 121000], ['export', 'done', 35000]]);
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /className="dev-ledger-build-phases" data-image-phase=\{nowPhase \? nowPhase\.name : 'done'\}/);
  assert.match(tsx, /\{withPhases\.detail \? <span className="dev-ledger-build-detail">\{withPhases\.detail\}<\/span> : null\}/);
  assert.match(read('frontend/src/features/dev-board/topic/model.ts'), /phases\?: LedgerBuildPhase\[\] \| null;/);
  assert.match(read('public/css/app.css'), /\.dev-ledger-build-detail \{/);
});
