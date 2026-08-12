// #1019: the resource and time budget that makes "run every declared check"
// actually finish.
//
// Running all 241 of this repo's declared checks instead of the first 12
// changes what the capture run costs, and three limits that were sized for a
// 12-check sequential suite would each turn "more coverage" into "no
// coverage" if they were left alone:
//
//   * the container run timeout — a suite that outlives it is KILLED, and a
//     killed run reports nothing rather than reporting less;
//   * the capture container's memory and CPU — eight concurrent Chromium
//     pages do not fit in the 1g/1cpu one-shot default, and an OOM-kill
//     loses the whole run;
//   * the staging preview's own CPU — it is now serving eight concurrent
//     page loads instead of one, and a preview pegged at 1 CPU makes every
//     check look slow enough to time out.
//
// These are cheap assertions about constants, which is exactly the point:
// the values are load-bearing and their relationships are not obvious from
// any single line, so a future edit to one of them should have to look here.
//
// Run with: node --test tests/checks-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docker = require('../src/services/docker');
const appManifest = require('../src/services/app-manifest');
const capture = require('../capture/capture');

const visualsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');

const constant = (name) => {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(visualsSrc);
  assert.ok(m, `${name} should exist in visuals.js`);
  return m[1].trim();
};
const numericConstant = (name) => {
  const raw = constant(name);
  const mul = /^(\d+)\s*\*\s*1000$/.exec(raw);
  if (mul) return Number(mul[1]) * 1000;
  const quoted = /^process\.env\.\w+ \|\| '(\d+)'$/.exec(raw);
  if (quoted) return Number(quoted[1]);
  return Number(raw);
};

test('the whole suite fits inside the container run timeout', () => {
  // Ordering, not absolute values: the suite must give up on its own terms
  // and emit its sentinel while the container is still alive. If the kill
  // came first, a run that was merely slow would be indistinguishable from
  // one that crashed, and the retry backoff would chase a phantom.
  const runTimeout = numericConstant('RUN_TIMEOUT_MS');
  const suiteDeadline = numericConstant('TESTS_DEADLINE_MS');
  const perCheck = numericConstant('TEST_TIMEOUT_MS');

  assert.ok(perCheck < suiteDeadline, 'one check cannot outlast the whole suite');
  assert.ok(suiteDeadline < runTimeout, 'the suite cannot outlast the container');
  assert.ok(runTimeout - suiteDeadline >= 120000,
    'and the media pass runs before the suite, so it needs room of its own');
});

test('the budget is big enough for a full manifest at measured speed', () => {
  // Production timing: ~3.9s marginal per check. A FULL manifest at the
  // ceiling — 400 since PR #1125, when this repo's own crossed 300 — is
  // ~195s of ideal work over a pool of 8; at the 55-70% efficiency a shared
  // preview actually delivers, ~280-355s. The budget has to clear that with
  // room, or the tail of a real manifest gets cut every single build and the
  // checks that were invisible before become "did not finish" instead.
  //
  // This is the assertion that makes raising MAX_DECLARED_TESTS cost
  // something: past ~430 checks the 420s deadline stops clearing 2x and the
  // deadline (and RUN_TIMEOUT_MS above it) has to move with the ceiling.
  const suiteDeadline = numericConstant('TESTS_DEADLINE_MS');
  const perCheckSeconds = 3.9;
  const pool = capture.poolSize({});
  const idealMs = (appManifest.MAX_DECLARED_TESTS * perCheckSeconds * 1000) / pool;
  assert.ok(suiteDeadline >= idealMs * 2,
    `budget ${suiteDeadline}ms should be at least 2x the ${Math.round(idealMs)}ms `
    + 'ideal run, to absorb a preview that is not giving us full parallelism');
});

test('the capture container is sized for a pool of pages, not one', () => {
  const memory = constant('CAPTURE_MEMORY');
  const cpus = constant('CAPTURE_CPUS');
  assert.match(memory, /process\.env\.CAPTURE_MEMORY \|\| '4g'/,
    'each Chromium page is ~50-80 MiB of renderer on top of the browser itself');
  assert.match(cpus, /process\.env\.CAPTURE_CPUS \|\| '4'/);
  // And they must actually reach the container — a limit computed and not
  // passed is the same as no limit.
  assert.match(visualsSrc, /memory: CAPTURE_MEMORY,\s*\n\s*cpus: CAPTURE_CPUS,/,
    'the limits must be handed to runOneShot');
});

test('the pool bounds are passed to the capture image', () => {
  // An older image during a rolling deploy ignores them and runs the suite
  // sequentially: slower, still correct. A newer image with no bounds passed
  // would fall back to its own defaults, which is also fine — but silently
  // dropping the platform's configured values would not be.
  assert.match(visualsSrc, /TEST_CONCURRENCY,\s*\n\s*TEST_TIMEOUT_MS,\s*\n\s*TESTS_DEADLINE_MS,/);
});

test('the staging preview can serve a parallel suite', () => {
  // The preview is the thing being hammered now. It was capped at 1 CPU when
  // exactly one page at a time talked to it.
  assert.equal(docker.STAGING_CPUS, '2');
  assert.equal(docker.STAGING_MEMORY, '256m',
    'memory was never the constraint — production previews sit at 28-57 MiB');
});

test('the container-side pool defaults agree with the platform-side ones', () => {
  // Two halves of one number, in two repos-worth of code that deploy
  // independently. If they drift, the platform thinks it configured a run
  // the image is not doing.
  assert.equal(capture.poolSize({}), Number(numericConstant('TEST_CONCURRENCY')));
  assert.equal(capture.testTimeoutMs({}), numericConstant('TEST_TIMEOUT_MS'));
  assert.equal(capture.testsDeadlineMs({}), numericConstant('TESTS_DEADLINE_MS'));
});

test('a per-check timeout is longer than a check that is merely slow', () => {
  // runTest itself spends SETTLE_MS + CONSOLE_ONLY_SETTLE_MS deliberately
  // idling, waiting for deferred console errors. A per-check timeout near
  // that floor would fail healthy checks under load.
  const captureSrc = fs.readFileSync(
    path.join(__dirname, '..', 'capture', 'capture.js'), 'utf8');
  const settle = Number(/const SETTLE_MS = (\d+);/.exec(captureSrc)[1]);
  const consoleSettle = Number(/const CONSOLE_ONLY_SETTLE_MS = (\d+);/.exec(captureSrc)[1]);
  assert.ok(capture.testTimeoutMs({}) > (settle + consoleSettle) * 3,
    'leave several times the deliberate idle before calling a check hung');
});

test('the declared-test ceiling clears this repo\'s own manifest', () => {
  // The regression that started #1019: the reader kept 12 of the 241 checks
  // declared here and dropped the rest without saying so.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const meta = appManifest.readTestsWithMeta(manifest);
  assert.ok(meta.rawCount > 200, 'this repo declares a genuinely large suite');
  assert.equal(meta.ceilingDropped, 0,
    `${meta.rawCount} declared checks must all survive the reader`);
  assert.equal(meta.tests.length, meta.rawCount,
    'every declared check is dispatched, none silently dropped');
});
