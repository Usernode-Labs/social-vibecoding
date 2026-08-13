// Unit-suite check: the aggregate `npm test` row that rides a proposal's
// checks run (src/services/unit-suite.js) and the classifyTests plumbing
// that carries it.
//
// The rules pinned here:
//
//   * Only a REAL test script triggers a run. npm's scaffold placeholder
//     (`echo "Error: no test specified" && exit 1`) means "no suite", and
//     failing every app that never wrote tests would be a fleet-wide
//     false alarm, not a check.
//   * The verdict is the process EXIT CODE, so failureDetail only has to
//     explain, never to judge — but what it extracts must distinguish
//     "tests failed" (not ok lines), "suite setup failed" (no setup
//     sentinel: clone/npm ci died before npm test), and "timed out".
//   * extraRows reach the LEGACY classify shape too. An app with no
//     declared dapp.json checks still gets its unit-suite row, and an
//     advisory (ungraduated) failure shows without flipping the state to
//     failing — the #1019 stance applied to a synthetic row.
//
// Run with: node --test tests/unit-suite-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const unitSuite = require('../src/services/unit-suite');
const visuals = require('../src/services/visuals');

// ── hasRunnableTestScript ──────────────────────────────────────────────

test('no package.json content → no run', () => {
  assert.equal(unitSuite.hasRunnableTestScript(null), false);
  assert.equal(unitSuite.hasRunnableTestScript(''), false);
});

test('unparseable package.json → no run', () => {
  assert.equal(unitSuite.hasRunnableTestScript('{nope'), false);
});

test('missing or empty test script → no run', () => {
  assert.equal(unitSuite.hasRunnableTestScript('{}'), false);
  assert.equal(unitSuite.hasRunnableTestScript('{"scripts":{}}'), false);
  assert.equal(unitSuite.hasRunnableTestScript('{"scripts":{"test":"  "}}'), false);
  assert.equal(unitSuite.hasRunnableTestScript('{"scripts":{"test":42}}'), false);
});

test('npm scaffold placeholder → no run', () => {
  const raw = JSON.stringify({
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  });
  assert.equal(unitSuite.hasRunnableTestScript(raw), false);
});

test('real test script → run', () => {
  const raw = JSON.stringify({
    scripts: { test: 'node --require ./tests/lib/test-net.js --test --test-force-exit tests/*.test.js' },
  });
  assert.equal(unitSuite.hasRunnableTestScript(raw), true);
});

// ── failureDetail ──────────────────────────────────────────────────────

const SENTINEL = unitSuite.SETUP_DONE_SENTINEL;

test('TAP failure: not-ok lines and summary counters, nothing else', () => {
  const stdout = [
    SENTINEL,
    'ok 1 - fine',
    'not ok 2 - explodes',
    'ok 3 - fine too',
    'not ok 4 - also explodes',
    '# tests 4',
    '# pass 2',
    '# fail 2',
    '# cancelled 0',
  ].join('\n');
  const d = unitSuite.failureDetail(stdout, '');
  assert.match(d, /not ok 2 - explodes/);
  assert.match(d, /not ok 4 - also explodes/);
  assert.match(d, /# fail 2/);
  assert.match(d, /# cancelled 0/);
  assert.doesNotMatch(d, /ok 1 - fine/);
  assert.doesNotMatch(d, /setup failed/i);
});

test('TAP failure: not-ok flood is capped with a remainder count', () => {
  const notOks = Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} - t${i + 1}`);
  const d = unitSuite.failureDetail(`${SENTINEL}\n${notOks.join('\n')}`, '');
  assert.match(d, /\(\+22 more failing tests\)/);
  assert.ok(d.length <= 1600);
});

test('setup failure (no sentinel) says the tests never ran', () => {
  const d = unitSuite.failureDetail('npm error code E404\nnpm error 404 Not Found', '');
  assert.match(d, /Suite setup failed/);
  assert.match(d, /the tests never ran/);
  assert.match(d, /E404/);
});

test('sentinel present → not a setup failure', () => {
  const d = unitSuite.failureDetail(`${SENTINEL}\nsomething broke`, '');
  assert.doesNotMatch(d, /setup failed/i);
  assert.match(d, /something broke/);
});

test('timeout is named, with the budget in seconds', () => {
  const d = unitSuite.failureDetail('partial output', '', { timedOut: true });
  assert.match(d, /exceeded \d+s and was killed/);
});

test('non-TAP output falls back to the last lines', () => {
  const stdout = `${SENTINEL}\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')}`;
  const d = unitSuite.failureDetail(stdout, 'FAIL src/foo.test.js');
  assert.match(d, /line 40/);
  assert.match(d, /FAIL src\/foo\.test\.js/);
  assert.doesNotMatch(d, /line 1 \|/);
});

// ── kill switch ────────────────────────────────────────────────────────

test('UNIT_SUITE_CHECK_ENABLED gates the feature, default on', () => {
  const prev = process.env.UNIT_SUITE_CHECK_ENABLED;
  try {
    delete process.env.UNIT_SUITE_CHECK_ENABLED;
    assert.equal(unitSuite.isEnabled(), true);
    for (const off of ['0', 'false', 'off', ' FALSE ']) {
      process.env.UNIT_SUITE_CHECK_ENABLED = off;
      assert.equal(unitSuite.isEnabled(), false, `expected "${off}" to disable`);
    }
    process.env.UNIT_SUITE_CHECK_ENABLED = '1';
    assert.equal(unitSuite.isEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.UNIT_SUITE_CHECK_ENABLED;
    else process.env.UNIT_SUITE_CHECK_ENABLED = prev;
  }
});

// ── classifyTests carries the row (legacy shape) ───────────────────────

function baselineFrame(index, status) {
  return {
    index, status,
    name: `Loads /p${index}`, path: `/p${index}`,
    consoleErrors: [], failureReason: status === 'pass' ? '' : 'boom',
  };
}

function unitRow(status, advisory) {
  return {
    index: unitSuite.UNIT_CHECK_INDEX,
    name: unitSuite.UNIT_CHECK_NAME,
    path: unitSuite.UNIT_CHECK_PATH,
    status,
    advisory,
    consoleErrors: [],
    failureReason: status === 'pass' ? '' : 'not ok 2 - explodes | # fail 1',
  };
}

test('legacy shape: advisory unit-suite failure shows but does not gate', () => {
  const out = visuals.classifyTests(
    [baselineFrame(0, 'pass'), baselineFrame(1, 'pass')], 2,
    { extraRows: [unitRow('fail', true)] }
  );
  assert.equal(out.state, 'passing');
  const row = out.results.find((r) => r.index === unitSuite.UNIT_CHECK_INDEX);
  assert.ok(row, 'unit-suite row must be in the results');
  assert.equal(row.advisory, true);
});

test('legacy shape: graduated unit-suite failure fails the run', () => {
  const out = visuals.classifyTests(
    [baselineFrame(0, 'pass')], 1,
    { extraRows: [unitRow('fail', false)] }
  );
  assert.equal(out.state, 'failing');
});

test('legacy shape: passing unit-suite row leaves a green run green', () => {
  const out = visuals.classifyTests(
    [baselineFrame(0, 'pass')], 1,
    { extraRows: [unitRow('pass', false)] }
  );
  assert.equal(out.state, 'passing');
  assert.equal(out.results.length, 2);
});

test('legacy shape: container error still carries the unit-suite row', () => {
  // One frame short of expected → the run is an error, but the unit suite
  // DID run and its verdict must not be lost with it.
  const out = visuals.classifyTests(
    [baselineFrame(0, 'pass')], 2,
    { extraRows: [unitRow('fail', true)] }
  );
  assert.equal(out.state, 'error');
  assert.ok(out.results.some((r) => r.index === unitSuite.UNIT_CHECK_INDEX));
});

// ── classifyTests carries the row (earned-gating shape) ────────────────

test('earned gating: advisory unit-suite failure adds no blocking count', () => {
  const dispatched = [{ index: 0, checkKey: 'k0', name: 'check 0', path: '/p0', graduated: true }];
  const out = visuals.classifyTests(
    [baselineFrame(0, 'pass')], 1,
    { dispatched, sentinel: null, extraRows: [unitRow('fail', true)] }
  );
  assert.equal(out.state, 'passing');
  assert.equal(out.blockingCount, 0);
});

test('earned gating: graduated unit-suite failure blocks like the over-ceiling row', () => {
  const dispatched = [{ index: 0, checkKey: 'k0', name: 'check 0', path: '/p0', graduated: true }];
  const out = visuals.classifyTests(
    [baselineFrame(0, 'pass')], 1,
    { dispatched, sentinel: null, extraRows: [unitRow('fail', false)] }
  );
  assert.equal(out.state, 'failing');
  assert.equal(out.blockingCount, 1);
});
