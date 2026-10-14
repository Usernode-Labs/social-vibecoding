'use strict';

// A preview build uploads the registry layer cache only when it rebuilt
// something a later build can reuse (src/services/kubernetes-buildkit.js,
// "The layer cache upload"). Pinned here: what the Job's script reads out
// of a real BuildKit trace, what it then does and reports, and how the
// platform turns the reports of an app's finished builds into the list of
// steps that need no upload. createBuild's side of it (reading that
// history, writing the report on the Job) is in
// tests/kubernetes-buildkit-build.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const buildkit = require('../src/services/kubernetes-buildkit');

const {
  BUILD_SCRIPT, STEPS_AWK, CACHE_CHANCES, CACHE_CHANCE_WINDOW_MS, CACHE_MAX_STEPS,
  cacheReport, cacheReportText, settledCacheSteps,
} = buildkit._forTest;

// A trace as `buildctl build --trace` wrote it (moby/buildkit v0.33.0,
// rootless): a build whose runtime-stage lockfile had changed, against a
// cache that held everything else. Its vertex lines are untouched; most of
// the byte-progress lines between them are left out.
const TRACE = path.join(__dirname, 'fixtures', 'buildkit-trace-lockfile-changed.jsonl');
const TRACE_SHA = '1be65c89d9000d382c8651cdcb3ba835f95de9bc';
const DIGEST = `sha256:${'d'.repeat(64)}`;

// The steps of that build as the script names them: stage, then the
// command as the trace spells it (JSON escapes and all), the commit id
// replaced. COPY, WORKDIR and FROM are not counted.
const STEPS = {
  runtimeDeps: 'stage-2 RUN sleep 2; mkdir -p node_modules; head -c 8000000 /dev/urandom \\u003e node_modules/blob; cp package-lock.json node_modules/lock',
  tools: 'stage-2 RUN sleep 1; echo tools \\u003e /tools',
  css: 'shell RUN sleep 1; cat public/*.css \\u003e public/tailwind.css; echo \\"GIT_SHA\\" \\u003e\\u003e public/tailwind.css',
  bundle: 'shell RUN --mount=type=bind,from=asset-deps,source=/build/frontend/node_modules,target=/build/frontend/node_modules,rw     sleep 1; mkdir -p public/shell; cat frontend/src/*.js \\u003e public/shell/shell.js; echo \\"GIT_SHA\\" \\u003e public/index.html',
  assetDeps: 'asset-deps RUN sleep 2; mkdir -p node_modules; head -c 12000000 /dev/urandom \\u003e node_modules/blob; cp package-lock.json node_modules/lock',
};
const token = (name) => crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
const RAN = [STEPS.runtimeDeps, STEPS.css, STEPS.bundle].map(token);
const SERVED = [STEPS.tools, STEPS.assetDeps].map(token);

// The script needs what the BuildKit image has. A machine without one of
// these (macOS has no sha256sum or timeout) skips the tests that run it.
const has = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;
const missing = ['awk', 'sha256sum', 'timeout', 'grep', 'sed', 'cut', 'wc', 'tail', 'head'].filter((tool) => !has(tool));
const skip = missing.length ? `needs ${missing.join(', ')}` : false;

test('the trace reader names the steps that ran and the steps the cache served', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-awk-'));
  fs.writeFileSync(path.join(dir, 'steps.awk'), STEPS_AWK);
  const out = spawnSync('awk', ['-f', path.join(dir, 'steps.awk'), TRACE], { encoding: 'utf8', env: { ...process.env, GIT_SHA: TRACE_SHA } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trimEnd().split('\n'), [
    `R ${STEPS.runtimeDeps}`,
    `S ${STEPS.tools}`,
    `R ${STEPS.css}`,
    `R ${STEPS.bundle}`,
    `S ${STEPS.assetDeps}`,
    'V 16',
  ]);
  // What the plain progress log could not say: the dependency step the
  // cache served goes on to report the download of its layers, and those
  // later updates no longer carry `cached`.
  const updates = fs.readFileSync(TRACE, 'utf8').split('\n').filter(Boolean)
    .flatMap((line) => JSON.parse(line).vertexes || [])
    .filter((vertex) => /^\[asset-deps 4\/4\] RUN/.test(vertex.name));
  assert.ok(updates.some((vertex) => vertex.cached === true));
  assert.notEqual(updates.at(-1).cached, true, 'the last word on a served step is not "cached"');
  assert.ok(updates.at(-1).completed);
});

// Runs BUILD_SCRIPT itself under sh, with buildctl and git replaced by
// stand-ins on PATH and its two absolute paths moved into a scratch
// directory. The stand-in buildctl records each call, writes the metadata
// file and the trace for the build, and succeeds or fails the cache upload
// as told.
function runScript({
  settled = [], cacheUpload, trace = TRACE, buildFails = false, uploadFails = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-script-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'buildctl-daemonless.sh'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$STUB_DIR/calls.log"',
    '[ "$1" = build ] || exit 0',
    'output=no; export=no; trace=; metadata=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in --output) output=yes ;; --export-cache) export=yes ;; --trace) trace=$2 ;; --metadata-file) metadata=$2 ;; esac',
    '  shift',
    'done',
    'if [ "$output" = no ]; then',
    '  [ "$STUB_UPLOAD_FAILS" = 1 ] && { echo "error: failed to solve: the cache registry refused"; exit 1; }',
    '  exit 0',
    'fi',
    '[ "$STUB_BUILD_FAILS" = 1 ] && { echo "error: failed to solve: process did not complete successfully"; exit 1; }',
    '[ -n "$STUB_TRACE" ] && cp "$STUB_TRACE" "$trace"',
    'printf \'{\\n  "containerimage.digest": "%s"\\n}\\n\' "$STUB_DIGEST" > "$metadata"',
  ].join('\n'), { mode: 0o755 });
  const termination = path.join(dir, 'termination-log');
  const script = BUILD_SCRIPT
    .replaceAll('/workspace', path.join(dir, 'workspace'))
    .replaceAll('/dev/termination-log', termination);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    REPO_URL: 'https://example.test/secret-clone-url', GIT_SHA: TRACE_SHA, DOCKERFILE: 'Dockerfile.kubernetes',
    IMAGE_TAG: 'registry.test/apps/demo:git-x', CACHE_REF: 'registry.test/cache/demo:buildkit-cache', REGISTRY_ATTRS: '',
    CACHE_SETTLED_STEPS: settled.join(' '),
    STUB_DIR: dir, STUB_DIGEST: DIGEST, STUB_TRACE: trace || '',
    STUB_BUILD_FAILS: buildFails ? '1' : '0', STUB_UPLOAD_FAILS: uploadFails ? '1' : '0',
  };
  if (cacheUpload) env.CACHE_UPLOAD = cacheUpload;
  const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env });
  const calls = fs.existsSync(path.join(dir, 'calls.log'))
    ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trimEnd().split('\n') : [];
  const message = fs.existsSync(termination) ? fs.readFileSync(termination, 'utf8') : null;
  return {
    status: run.status, log: run.stdout + run.stderr, message,
    builds: calls.filter((call) => call.startsWith('build ')),
    uploads: calls.filter((call) => call.startsWith('build ') && !call.includes('--output')),
  };
}

test('the script: with no history every step that ran is news, so the cache is uploaded, after the image', { skip }, () => {
  const run = runScript();
  assert.equal(run.status, 0, run.log);
  assert.equal(run.builds.length, 2);
  assert.match(run.builds[0], /--output type=image,name=registry\.test\/apps\/demo:git-x,push=true/);
  assert.doesNotMatch(run.builds[0], /--export-cache/);
  assert.match(run.builds[1], /--export-cache type=registry,ref=registry\.test\/cache\/demo:buildkit-cache,mode=max/);
  assert.match(run.builds[1], /--import-cache type=registry,ref=registry\.test\/cache\/demo:buildkit-cache/);
  assert.equal(run.message, `cache-upload=done\ncache-ran=${RAN.join(' ')}\ncache-served=${SERVED.join(' ')}\n${DIGEST}`);
  assert.deepEqual(cacheReport(run.message), { upload: 'done', known: true, ran: RAN, served: SERVED });
  assert.match(run.log, /\[buildkit\] uploading the layer cache\n/);
  assert.match(run.log, /\[buildkit\] pushed registry\.test\/apps\/demo:git-x@sha256:d{64}\n$/);
  assert.doesNotMatch(run.log, /secret-clone-url/);
});

test('the script: when every step that ran is known to run on every build, nothing is uploaded', { skip }, () => {
  const run = runScript({ settled: [token('some other step'), ...RAN] });
  assert.equal(run.status, 0, run.log);
  assert.equal(run.builds.length, 1, 'one buildctl run: the build');
  assert.equal(run.message, `cache-upload=skipped\ncache-ran=${RAN.join(' ')}\ncache-served=${SERVED.join(' ')}\n${DIGEST}`);
  assert.match(run.log, /\[buildkit\] layer cache not uploaded: nothing a later build can reuse was rebuilt\n/);
});

test('the script: one step outside that list is enough to upload (the lockfile changed, or the step is new)', { skip }, () => {
  for (const left of RAN) {
    const run = runScript({ settled: RAN.filter((t) => t !== left) });
    assert.equal(run.uploads.length, 1);
    assert.equal(cacheReport(run.message).upload, 'done');
  }
  // A step the cache served is not a reason: it is in the cache already.
  assert.equal(runScript({ settled: RAN }).uploads.length, 0);
});

test('the script: CACHE_UPLOAD=always uploads whatever the list says', { skip }, () => {
  const run = runScript({ settled: RAN, cacheUpload: 'always' });
  assert.equal(run.uploads.length, 1);
  assert.deepEqual(cacheReport(run.message), { upload: 'done', known: true, ran: RAN, served: SERVED });
});

test('the script: a trace it cannot read means upload, and a report that names no steps', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-trace-'));
  const noSteps = path.join(dir, 'no-steps.jsonl');
  fs.writeFileSync(noSteps, '{"vertexes":[{"digest":"sha256:' + 'a'.repeat(64) + '","name":"[internal] load build definition from Dockerfile"}]}\n');
  const otherShape = path.join(dir, 'other-shape.jsonl');
  fs.writeFileSync(otherShape, '{"Vertexes":[{"Digest":"sha256:' + 'a'.repeat(64) + '","Name":"[stage-0 1/2] RUN make"}]}\n');
  for (const trace of [null, noSteps, otherShape]) {
    const run = runScript({ settled: RAN, trace });
    assert.equal(run.status, 0, run.log);
    assert.equal(run.uploads.length, 1, 'cannot tell is not "nothing to upload"');
    assert.equal(run.message, `cache-upload=done\n${DIGEST}`);
    assert.deepEqual(cacheReport(run.message), { upload: 'done', known: false, ran: [], served: [] });
  }
});

test('the script: more steps than the report can hold is also "cannot tell"', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-many-'));
  const many = path.join(dir, 'many.jsonl');
  const vertex = (i) => JSON.stringify({ vertexes: [{
    digest: `sha256:${String(i).padStart(64, '0')}`, name: `[build ${i}/${CACHE_MAX_STEPS + 1}] RUN make part-${i}`,
    started: '2026-10-08T00:00:00Z', completed: '2026-10-08T00:00:01Z',
  }] });
  fs.writeFileSync(many, Array.from({ length: CACHE_MAX_STEPS + 1 }, (_, i) => vertex(i + 1)).join('\n') + '\n');
  const over = runScript({ trace: many });
  assert.equal(over.message, `cache-upload=done\n${DIGEST}`);
  assert.ok(Buffer.byteLength(over.message) < 4096);
  // At the limit the report still fits the termination message with room to spare.
  fs.writeFileSync(many, Array.from({ length: CACHE_MAX_STEPS }, (_, i) => vertex(i + 1)).join('\n') + '\n');
  const at = runScript({ trace: many });
  assert.equal(cacheReport(at.message).ran.length, CACHE_MAX_STEPS);
  assert.ok(Buffer.byteLength(at.message) < 4096, `${Buffer.byteLength(at.message)} bytes`);
  assert.ok(at.message.endsWith(DIGEST));
});

test('the script: a cache upload that fails does not fail the build; the image is pushed and its digest reported', { skip }, () => {
  const run = runScript({ uploadFails: true });
  assert.equal(run.status, 0, run.log);
  assert.equal(run.uploads.length, 1);
  assert.equal(run.message, `cache-upload=failed\ncache-ran=${RAN.join(' ')}\ncache-served=${SERVED.join(' ')}\n${DIGEST}`);
  assert.match(run.log, /\[buildkit\] the layer cache was not uploaded; the image is pushed and the build stands\n/);
  assert.match(run.log, /\[buildkit\] cache: error: failed to solve: the cache registry refused\n/, 'why, in the build log');
  assert.match(run.log, /\[buildkit\] pushed /);
});

test('the script: a build that fails is still a failed build, with no upload and no result', { skip }, () => {
  const run = runScript({ buildFails: true });
  assert.notEqual(run.status, 0);
  assert.equal(run.builds.length, 1);
  assert.equal(run.message, null);
  assert.doesNotMatch(run.log, /layer cache/);
});

test('cacheReport: reads the termination message and the copy on the Job, and nothing else', () => {
  assert.equal(cacheReport(DIGEST), null, 'a build from before the report existed');
  assert.equal(cacheReport(''), null);
  assert.equal(cacheReport(undefined), null);
  assert.equal(cacheReport(`cache-upload=perhaps\n${DIGEST}`), null);
  assert.deepEqual(cacheReport(`cache-upload=skipped\ncache-ran=aaaaaaaaaaaa bbbbbbbbbbbb\ncache-served=\n${DIGEST}`),
    { upload: 'skipped', known: true, ran: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], served: [] });
  assert.deepEqual(cacheReport(`cache-upload=failed\n${DIGEST}`), { upload: 'failed', known: false, ran: [], served: [] });
  // Only tokens survive: the lists end up in the next Job's environment.
  assert.deepEqual(cacheReport('cache-upload=done\ncache-ran=aaaaaaaaaaaa $(reboot) ../x AAAAAAAAAAAA aaaaaaaaaaaaa\ncache-served=cccccccccccc;x').ran, ['aaaaaaaaaaaa']);
  assert.deepEqual(cacheReport('cache-upload=done\ncache-ran=\ncache-served=cccccccccccc;x').served, []);
  const report = cacheReport(`cache-upload=done\ncache-ran=aaaaaaaaaaaa\ncache-served=cccccccccccc dddddddddddd\n${DIGEST}`);
  assert.equal(cacheReportText(report), 'cache-upload=done\ncache-ran=aaaaaaaaaaaa\ncache-served=cccccccccccc dddddddddddd');
  assert.deepEqual(cacheReport(cacheReportText(report)), report, 'the annotation reads back as the report');
  assert.equal(cacheReportText(cacheReport('cache-upload=done')), 'cache-upload=done');
});

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const built = (hoursAgo, upload, ran, served = []) => ({ at: NOW - hoursAgo * HOUR, upload, known: true, ran, served });
// Tokens, named for what the step would be.
const VITE = 'aaaaaaaaaaaa'; // bakes in the commit: runs on every build
const DEPS = 'bbbbbbbbbbbb'; // a dependency install: served unless the lockfile changed
const NEW = 'cccccccccccc';

test('settledCacheSteps: a step that keeps running gets two uploads, then stops causing them', () => {
  assert.equal(CACHE_CHANCES, 2);
  assert.equal(CACHE_CHANCE_WINDOW_MS, 24 * HOUR);
  assert.deepEqual(settledCacheSteps([], NOW), [], 'no history: nothing is settled, so whatever runs uploads');
  const first = [built(3, 'done', [VITE, DEPS])];
  assert.deepEqual(settledCacheSteps(first, NOW), [], 'one upload so far');
  const second = [...first, built(2, 'done', [VITE], [DEPS])];
  assert.deepEqual(settledCacheSteps(second, NOW), [VITE]);
  const later = [...second, built(1, 'skipped', [VITE], [DEPS]), built(0.5, 'skipped', [VITE], [DEPS])];
  assert.deepEqual(settledCacheSteps(later, NOW), [VITE]);
});

test('settledCacheSteps: a step the cache serves at least as often as it runs is never settled', () => {
  // The dependency install ran in both uploading builds (an empty cache,
  // then a changed lockfile) and was served in between: it is reusable, so
  // the next build in which it runs uploads.
  const history = [
    built(5, 'done', [VITE, DEPS]),
    built(4, 'done', [VITE], [DEPS]),
    built(3, 'skipped', [VITE], [DEPS]),
    built(2, 'done', [VITE, DEPS]),
    built(1, 'skipped', [VITE], [DEPS]),
  ];
  assert.deepEqual(settledCacheSteps(history, NOW), [VITE]);
  assert.deepEqual(settledCacheSteps([built(2, 'done', [DEPS]), built(1, 'done', [DEPS]), built(0.5, 'skipped', [], [DEPS]), built(0.2, 'skipped', [], [DEPS])], NOW), [],
    'served as often as it ran is enough');
});

test('settledCacheSteps: one build that was served everything does not make every step look reusable', () => {
  // Rebuilding the commit whose layers the cache holds serves even the step
  // that bakes in the commit. It ran in every other build.
  const history = [
    built(6, 'done', [VITE, DEPS]),
    built(5, 'done', [VITE], [DEPS]),
    built(4, 'skipped', [VITE], [DEPS]),
    built(3, 'skipped', [], [VITE, DEPS]),
    built(2, 'skipped', [VITE], [DEPS]),
  ];
  assert.deepEqual(settledCacheSteps(history, NOW), [VITE]);
});

test('settledCacheSteps: only uploads that happened count as chances, and they age out after a day', () => {
  assert.deepEqual(settledCacheSteps([built(3, 'failed', [VITE]), built(2, 'failed', [VITE]), built(1, 'skipped', [VITE])], NOW), [],
    'an upload that failed left nothing for the next build to be served');
  assert.deepEqual(settledCacheSteps([built(3, 'done', [VITE]), built(2, 'failed', [VITE])], NOW), []);
  const yesterday = [built(30, 'done', [VITE, DEPS]), built(29, 'done', [VITE], [DEPS]), built(28, 'skipped', [VITE], [DEPS])];
  assert.deepEqual(settledCacheSteps(yesterday, NOW), [], 'tried again: this is what keeps a reusable step from being written off for good');
  assert.deepEqual(settledCacheSteps(yesterday, NOW - 10 * HOUR), [VITE], 'the same history, ten hours earlier');
  assert.deepEqual(settledCacheSteps([...yesterday, built(1, 'done', [VITE], [DEPS])], NOW), [], 'one of today\'s two');
  assert.deepEqual(settledCacheSteps([...yesterday, built(1, 'done', [VITE], [DEPS]), built(0.5, 'done', [VITE], [DEPS])], NOW), [VITE]);
});

test('settledCacheSteps: a step nobody has reported is not in the list, and the list is sorted and without repeats', () => {
  const history = [built(2, 'done', [VITE, VITE, 'ffffffffffff']), built(1, 'done', ['ffffffffffff', VITE, VITE])];
  const settled = settledCacheSteps(history, NOW);
  assert.deepEqual(settled, [VITE, 'ffffffffffff']);
  assert.ok(!settled.includes(NEW));
});
