'use strict';

// services/unit-suite — a red run names every failing test, even when the
// log the cluster kept has lost its start, and a build that broke before
// any test ran names the line that broke it.
//
// Two pauses of main in October 2026 named no culprit:
//
//   * 9 October: about 22,700 tests ran and the row said "N tests failed,
//     but the saved output does not name them". The `not ok` lines had
//     scrolled out of the log the cluster kept. The container script now
//     keeps a copy of npm test's output and, when it fails, prints every
//     failing test's `not ok` line and block again at the end
//     (RECAP_SENTINEL), where the log always ends.
//
//   * 8 October: the pretest build stopped at a bundler's
//     `ERROR: Multiple exports with the same name …`; the reason kept only
//     a stack tail and npm's complaint. The error line now leads.
//
// main-watch also needs to know whether the names it got are ALL of them
// (its known-flake rule): `named.complete`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const unitSuite = require('../src/services/unit-suite');

const WS = '/tmp/tmp.Rc12Ap34Xy';
const tapFail = (n, name, file) => [
  `# Subtest: ${name}`,
  `not ok ${n} - ${name}`,
  '  ---',
  '  duration_ms: 1.25',
  "  type: 'test'",
  `  location: '${WS}/${file}:10:1'`,
  "  failureType: 'testCodeFailure'",
  `  error: 'boom in ${name}'`,
  '  ...',
];
const tapOk = (n, name) => [`# Subtest: ${name}`, `ok ${n} - ${name}`, '  ---', '  duration_ms: 0.5', '  ...'];
const summary = (tests, fail) => [`1..${tests}`, `# tests ${tests}`, `# pass ${tests - fail}`, `# fail ${fail}`, '# cancelled 0'];

// What the container script prints after a red npm test, built the way its
// awk builds it: the workspace again, the count, then each failure's block.
const recap = (count, ...blocks) => [
  `${unitSuite.ROOT_SENTINEL}=${WS}`,
  `${unitSuite.RECAP_SENTINEL}=${count}`,
  ...blocks.flat().filter((l) => !l.startsWith('# Subtest')),
];

const fullRun = () => [
  `${unitSuite.ROOT_SENTINEL}=${WS}`,
  unitSuite.SETUP_DONE_SENTINEL,
  'stdout before the first failure',
  ...tapFail(1, 'first breaks', 'tests/a.test.js'),
  ...tapOk(2, 'fine'),
  'stdout before the second failure',
  ...tapFail(3, 'second breaks', 'tests/b.test.js'),
  ...summary(3, 2),
];

test('a full log with its recap names each failure once, and reads as it did without the recap', () => {
  const plain = fullRun().join('\n');
  const withRecap = [...fullRun(), ...recap(2, tapFail(1, 'first breaks', 'tests/a.test.js'), tapFail(3, 'second breaks', 'tests/b.test.js'))].join('\n');
  const a = unitSuite.failureOutcomeParts(plain, '');
  const b = unitSuite.failureOutcomeParts(withRecap, '');
  assert.equal(b.reason, a.reason, 'the reason is byte-for-byte the same');
  assert.equal(b.reason, 'tests/a.test.js (1): first breaks | tests/b.test.js (1): second breaks | # tests 3 | # pass 1 | # fail 2 | # cancelled 0');
  assert.deepEqual(b.named.tests, [
    { file: 'tests/a.test.js', test: 'first breaks' },
    { file: 'tests/b.test.js', test: 'second breaks' },
  ]);
  assert.equal(b.named.complete, true);
  // The excerpts are the original lines', not doubled by the recap's.
  assert.deepEqual(b.details, a.details);
  assert.equal(b.details.length, 2);
});

test('a log that lost its start still names every failure from the recap', () => {
  // What the cluster kept of a long run: the tail, from somewhere after the
  // last `not ok`, then the recap.
  const tail = [...tapOk(9000, 'late test'), ...summary(9000, 2)];
  const lost = [...tail, ...recap(2, tapFail(1, 'first breaks', 'tests/a.test.js'), tapFail(3, 'second breaks', 'tests/b.test.js'))].join('\n');
  const before = unitSuite.failureOutcomeParts(tail.join('\n'), '');
  assert.match(before.reason, /^2 tests failed, but the saved output does not name them\./, 'what 9 October read');
  assert.equal(before.named.complete, false);
  const after = unitSuite.failureOutcomeParts(lost, '');
  assert.match(after.reason, /^tests\/a\.test\.js \(1\): first breaks \| tests\/b\.test\.js \(1\): second breaks \| # tests 9000/);
  assert.equal(after.named.complete, true, 'the recap counted two and both were read');
  // The recap's blocks have no stdout of their own to excerpt.
  assert.doesNotMatch(after.details[0].excerpt, /stdout just before/);
});

test('names are complete only when the recap could print them all', () => {
  const blocks = Array.from({ length: 3 }, (_, i) => tapFail(i + 1, `t${i}`, 'tests/c.test.js'));
  const capped = [...summary(500, 80), ...recap(unitSuite.RECAP_MAX_TESTS + 30, ...blocks)].join('\n');
  assert.equal(unitSuite.failureOutcomeParts(capped, '').named.complete, false, 'more failures than the recap printed');
  const short = [...summary(500, 4), ...recap(4, ...blocks)].join('\n');
  assert.equal(unitSuite.failureOutcomeParts(short, '').named.complete, false, 'the recap counted one the list lacks');
  // No recap (an older script): whole only when the log kept its start and end.
  assert.equal(unitSuite.failureOutcomeParts(fullRun().join('\n'), '').named.complete, true);
  assert.equal(unitSuite.failureOutcomeParts(fullRun().slice(1).join('\n'), '').named.complete, false, 'no workspace line');
  assert.equal(unitSuite.failureOutcomeParts(fullRun().slice(0, -5).join('\n'), '').named.complete, false, 'no summary');
  assert.equal(unitSuite.failureOutcomeParts(fullRun().join('\n'), '', { timedOut: true }).named.complete, false, 'killed mid-run');
});

test('a build that broke before any test ran names its error line first', () => {
  // The shape of 8 October's run: the pretest build's bundler error, its
  // stack, then npm's own lines. The last eight lines alone never said why.
  const out = [
    `${unitSuite.ROOT_SENTINEL}=${WS}`,
    unitSuite.SETUP_DONE_SENTINEL,
    '> social-vibecoding@1.0.0 pretest',
    '> node scripts/ensure-shell-artifacts.js --html-only',
    'vite v5.4.0 building for production...',
    'transforming...',
    `${WS}/frontend/@/components/ui/icons.tsx:812:16: ERROR: Multiple exports with the same name "PersonSilhouetteIcon"`,
    'error during build:',
    'Error: Transform failed with 1 error:',
    `${WS}/frontend/@/components/ui/icons.tsx:812:16: ERROR: Multiple exports with the same name "PersonSilhouetteIcon"`,
    ...Array.from({ length: 9 }, (_, i) => `    at frame${i} (node_modules/esbuild/lib/main.js:${1000 + i}:5)`),
    'npm error Lifecycle script `pretest` failed with error:',
    'npm error code 1',
  ].join('\n');
  const reason = unitSuite.failureDetail(out, '');
  assert.match(reason, /^\/tmp\/tmp\.Rc12Ap34Xy\/frontend\/@\/components\/ui\/icons\.tsx:812:16: ERROR: Multiple exports with the same name "PersonSilhouetteIcon" \| /);
  assert.match(reason, /npm error code 1$/, 'the tail still follows');
  // Already in the tail: not said twice.
  const short = [unitSuite.SETUP_DONE_SENTINEL, 'TypeError: x is not a function', 'npm error code 1'].join('\n');
  assert.equal(unitSuite.failureDetail(short, ''), 'TypeError: x is not a function | npm error code 1');
  // TypeScript's own form, and no headline when nothing reads like one.
  assert.match(unitSuite.failureDetail([unitSuite.SETUP_DONE_SENTINEL, 'src/a.ts(3,1): error TS2304: Cannot find name', ...Array.from({ length: 10 }, (_, i) => `noise ${i}`)].join('\n'), ''),
    /^src\/a\.ts\(3,1\): error TS2304: Cannot find name \| noise 2/);
  assert.equal(unitSuite.failureDetail([unitSuite.SETUP_DONE_SENTINEL, 'something broke'].join('\n'), ''), 'something broke');
});

test('the live tracker does not count the recap\'s repeats', () => {
  const t = unitSuite.makeUnitSuiteTracker();
  for (const l of [unitSuite.SETUP_DONE_SENTINEL, 'not ok 1 - a', 'ok 2 - b', `${unitSuite.RECAP_SENTINEL}=1`, 'not ok 1 - a']) t.feed(l);
  const snap = t.snapshot();
  assert.equal(snap.failed, 1);
  assert.equal(snap.passed, 1);
});

test('the failing tests ride beside the row, never in it', async () => {
  const stdout = [...fullRun(), ...recap(2, tapFail(1, 'first breaks', 'tests/a.test.js'), tapFail(3, 'second breaks', 'tests/b.test.js'))].join('\n');
  const out = await unitSuite.outcomeFromLog({ pool: null, appId: 9, sessionId: 1, succeeded: false, stdout, graduated: true });
  assert.deepEqual(out.failingTests, {
    tests: [{ file: 'tests/a.test.js', test: 'first breaks' }, { file: 'tests/b.test.js', test: 'second breaks' }],
    complete: true,
  });
  assert.equal(out.row.failingTests, undefined, 'every proposal stores the row; its shape does not move');
  const green = await unitSuite.outcomeFromLog({ pool: null, appId: 9, sessionId: 1, succeeded: true, stdout: summary(3, 0).join('\n'), graduated: true });
  assert.equal(green.failingTests, undefined);
});

// ── The container script itself ──────────────────────────────────────────
//
// Its tail runs here under bash with `npm` stubbed: the part after setup
// is what changed, and it is plain shell.

function runScriptTail(npmBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-suite-recap-'));
  const tail = unitSuite.RUN_SCRIPT.slice(unitSuite.RUN_SCRIPT.indexOf('TEST_LOG='));
  const script = `set -eu\nWS="${dir}"\ncd "${dir}"\nnpm() {\n${npmBody}\n}\n${tail}`;
  try {
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

test('a red npm test is followed by its failures again, and keeps its exit code', { skip: !hasBash && 'no bash' }, () => {
  const tap = [
    ...tapFail(1, 'first breaks', 'tests/a.test.js'),
    ...tapOk(2, 'fine'),
    'not ok 3 - not yet # TODO',
    ...tapFail(4, 'second breaks', 'tests/b.test.js'),
    ...summary(4, 2),
  ];
  const r = runScriptTail(`cat <<'TAP'\n${tap.join('\n')}\nTAP\nreturn 7`);
  assert.equal(r.status, 7, 'npm test\'s own exit code, not tee\'s');
  const lines = r.stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${unitSuite.RECAP_SENTINEL}=`));
  assert.ok(at > 0, 'the recap is printed');
  assert.equal(lines[at], `${unitSuite.RECAP_SENTINEL}=2`, 'a TODO is not a failure');
  assert.match(lines[at - 1], new RegExp(`^${unitSuite.ROOT_SENTINEL}=`), 'the workspace again, for the relative paths');
  const repeated = lines.slice(at + 1).filter((l) => l.startsWith('not ok'));
  assert.deepEqual(repeated, ['not ok 1 - first breaks', 'not ok 4 - second breaks']);
  assert.ok(lines.slice(at + 1).includes(`  location: '${WS}/tests/b.test.js:10:1'`), 'with their blocks');
});

test('a green npm test prints no recap and exits 0', { skip: !hasBash && 'no bash' }, () => {
  const r = runScriptTail(`printf 'ok 1 - fine\\n# tests 1\\n# fail 0\\n'`);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, new RegExp(unitSuite.RECAP_SENTINEL));
  assert.match(r.stdout, /ok 1 - fine/);
});

test('the recap holds at most RECAP_MAX_TESTS failures but counts them all', { skip: !hasBash && 'no bash' }, () => {
  const total = unitSuite.RECAP_MAX_TESTS + 5;
  const tap = Array.from({ length: total }, (_, i) => tapFail(i + 1, `t${i}`, 'tests/many.test.js')).flat();
  const r = runScriptTail(`cat <<'TAP'\n${tap.join('\n')}\nTAP\nreturn 1`);
  const lines = r.stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${unitSuite.RECAP_SENTINEL}=`));
  assert.equal(lines[at], `${unitSuite.RECAP_SENTINEL}=${total}`);
  assert.equal(lines.slice(at + 1).filter((l) => l.startsWith('not ok')).length, unitSuite.RECAP_MAX_TESTS);
  assert.equal(unitSuite.failureOutcomeParts(r.stdout, '').named.complete, false);
});
