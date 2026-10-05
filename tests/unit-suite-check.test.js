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

test('TAP failure: failing tests and summary counters, nothing else', () => {
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
  // No YAML under either line, so no file to group them by — they still
  // show, under a group that says the runner did not report one.
  assert.match(d, /^\(file not reported\) \(2\): explodes; also explodes \| /);
  assert.match(d, /# fail 2/);
  assert.match(d, /# cancelled 0/);
  assert.doesNotMatch(d, /fine/);
  assert.doesNotMatch(d, /setup failed/i);
});

// ── failureDetail: grouped by file (change 4868) ───────────────────────
//
// 15 tests failed on change 4868. The summary named the first 8 `not ok`
// lines — all in one file, with no file named — then "(+7 more failing
// tests)". The fix turn searched for the named tests to find their file,
// fixed them, and ran the whole suite (~11 minutes) to find the other
// seven, which were in three other files. The file each test is in lives
// in the YAML block under its `not ok` line (`location:`); the summary
// reads it and groups by it, and the FILE LIST is what survives every cut.

const WS = '/tmp/tmp.Ab12Cd34Ef';
// One failing top-level test the way node:test prints it.
const tapFail = (n, name, file, line = 10) => [
  `# Subtest: ${name}`,
  `not ok ${n} - ${name}`,
  '  ---',
  '  duration_ms: 1.25',
  "  type: 'test'",
  ...(file ? [`  location: '${WS}/${file}:${line}:1'`] : []),
  "  failureType: 'testCodeFailure'",
  "  error: 'boom'",
  "  code: 'ERR_ASSERTION'",
  '  stack: |-',
  `    TestContext.<anonymous> (${WS}/${file || 'x.js'}:${line + 2}:5)`,
  '  ...',
].join('\n');
const tapRun = (blocks, { fail = blocks.length, root = true } = {}) => [
  ...(root ? [`${unitSuite.ROOT_SENTINEL}=${WS}`] : []),
  unitSuite.CLONED_SENTINEL,
  SENTINEL,
  'TAP version 13',
  ...blocks,
  `1..${blocks.length}`,
  `# tests ${13000 + fail}`,
  '# suites 0',
  '# pass 13000',
  `# fail ${fail}`,
  '# cancelled 0',
  '# duration_ms 660123.4',
].join('\n');

// Change 4868's shape: eight in one file, then the check-cap guards.
const CHANGE_4868 = [
  ...Array.from({ length: 8 }, (_, i) => ['tests/agent-sessions-postgres.test.js', `agent session postgres case ${i + 1}`]),
  ['tests/dev-board-fold.test.js', 'the manifest declares exactly the checks this file accounts for'],
  ['tests/improve-session-spinner.test.js', 'the busy spinner is one check, retargeted rather than added'],
  ['tests/proposal-tests-manifest.test.js', "this repo's own manifest fits under the ceiling, with room to grow"],
  ...Array.from({ length: 4 }, (_, i) => ['tests/agent-sessions-postgres.test.js', `agent session postgres late case ${i + 1}`]),
];

test('more than 8 failures over several files: every file, with its count', () => {
  const d = unitSuite.failureDetail(tapRun(CHANGE_4868.map(([f, n], i) => tapFail(i + 1, n, f))), '');
  assert.match(d, /^tests\/agent-sessions-postgres\.test\.js \(12\): agent session postgres case 1; /);
  assert.match(d, / \| tests\/dev-board-fold\.test\.js \(1\): the manifest declares exactly/);
  assert.match(d, / \| tests\/improve-session-spinner\.test\.js \(1\): the busy spinner/);
  assert.match(d, / \| tests\/proposal-tests-manifest\.test\.js \(1\): this repo's own manifest/);
  // Repo-relative, so a fix turn can pass the paths straight to node --test.
  assert.doesNotMatch(d, /\/tmp\/tmp\./);
  assert.doesNotMatch(d, /:\d+:\d+/, 'the line:col of location: is dropped');
  // Everything fits at this size: all twelve names, in order, and no `…`.
  assert.match(d, /postgres case 8; agent session postgres late case 1;/);
  assert.doesNotMatch(d, /…/);
  assert.match(d, /\| # tests 13015 \| # pass 13000 \| # fail 15 \| # cancelled 0$/);
  assert.doesNotMatch(d, /# suites|# duration_ms|not ok|ERR_ASSERTION|stack/);
});

test('a failure with no location: groups as "file not reported", and the files still list', () => {
  const d = unitSuite.failureDetail(tapRun([
    tapFail(1, 'located one', 'tests/a.test.js'),
    tapFail(2, 'a runner that printed no location', null),
    tapFail(3, 'located two', 'tests/b.test.js'),
  ]), '');
  assert.match(d, /^tests\/a\.test\.js \(1\): located one \| \(file not reported\) \(1\): a runner that printed no location \| tests\/b\.test\.js \(1\): located two \| # tests/);
});

test('at the size limit, names give way and every file and count survives', () => {
  const long = (i) => `a very long descriptive test name number ${i} `.padEnd(190, 'x');
  const blocks = [];
  let n = 0;
  const files = Array.from({ length: 9 }, (_, i) => `tests/suite-${i + 1}.test.js`);
  for (const [i, f] of files.entries()) {
    for (let k = 0; k < (i === 0 ? 40 : 3); k += 1) blocks.push(tapFail(++n, long(n), f));
  }
  const d = unitSuite.failureDetail(tapRun(blocks), '');
  assert.ok(d.length <= unitSuite.FAILURE_DETAIL_MAX, `${d.length} > ${unitSuite.FAILURE_DETAIL_MAX}`);
  assert.match(d, /^tests\/suite-1\.test\.js \(40\)/);
  for (const f of files.slice(1)) assert.ok(d.includes(`${f} (3)`), `${f} and its count are listed`);
  assert.match(d, /…/, 'a file whose names did not all fit says so');
  // Names are dealt one per file per round: the 40-failure file cannot take
  // the budget before the second file gets its first name.
  assert.ok(d.includes(`tests/suite-2.test.js (3): ${long(41)}`), 'the second file keeps its first name');
  assert.match(d, /\| # tests 13064 \| # pass 13000 \| # fail 64 \| # cancelled 0$/, 'the counters survive the cut');
});

test('when the file list alone overflows, it says how many files it left out', () => {
  const blocks = Array.from({ length: 80 }, (_, i) =>
    tapFail(i + 1, `t${i + 1}`, `tests/a-rather-long-directory-name/file-number-${String(i + 1).padStart(3, '0')}.test.js`));
  const d = unitSuite.failureDetail(tapRun(blocks), '');
  assert.ok(d.length <= unitSuite.FAILURE_DETAIL_MAX, `${d.length} > ${unitSuite.FAILURE_DETAIL_MAX}`);
  const listed = (d.match(/file-number-\d+\.test\.js \(1\)/g) || []).length;
  assert.ok(listed > 10 && listed < 80, `${listed} files listed`);
  assert.ok(d.includes(`(+${80 - listed} more files, ${80 - listed} failing tests)`));
  assert.match(d, /# fail 80 \| # cancelled 0$/);
});

test('without the workspace line the location stays absolute — still the right file', () => {
  const d = unitSuite.failureDetail(tapRun([tapFail(1, 'old log', 'tests/a.test.js')], { root: false }), '');
  assert.match(d, /^\/tmp\/tmp\.Ab12Cd34Ef\/tests\/a\.test\.js \(1\): old log \| /);
});

test('only top-level failures count, TODO and SKIP are not failures', () => {
  const stdout = tapRun([
    [
      '# Subtest: a parent',
      '    # Subtest: a child',
      '    not ok 1 - a child',
      '      ---',
      `      location: '${WS}/tests/nested.test.js:5:3'`,
      '      ...',
      '    1..1',
      'not ok 1 - a parent',
      '  ---',
      `  location: '${WS}/tests/nested.test.js:4:1'`,
      "  failureType: 'subtestsFailed'",
      '  ...',
    ].join('\n'),
    'not ok 2 - not finished yet # TODO',
    'not ok 3 - skipped here # SKIP',
    tapFail(4, 'real', 'tests/real.test.js'),
  ], { fail: 2 });
  const d = unitSuite.failureDetail(stdout, '');
  assert.match(d, /^tests\/nested\.test\.js \(1\): a parent \| tests\/real\.test\.js \(1\): real \| # tests/);
  assert.doesNotMatch(d, /a child|not finished|skipped here/);
});

test('the container script prints the workspace failureDetail strips', async (t) => {
  const github = require('../src/services/github');
  const docker = require('../src/services/docker');
  const history = require('../src/services/check-history');
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getFileContent', async () => '{"scripts":{"test":"node --test"}}');
  t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
  t.mock.method(history, 'loadGraduated', async () => new Set());
  let script = '';
  t.mock.method(docker, 'runOneShot', async (_name, options) => {
    script = options.cmd[2];
    throw Object.assign(new Error('exit 1'), {
      stdout: tapRun([tapFail(1, 'regression', 'tests/x.test.js')]), code: 1,
    });
  });
  const out = await unitSuite.maybeRunUnitSuite({ config: {}, pool: { query: async () => ({ rows: [] }) }, appId: 10, sessionId: 7, repoOwner: 'example', repoName: 'repo', ref: 'a'.repeat(40) });
  assert.ok(script.includes(`echo "${unitSuite.ROOT_SENTINEL}=$(pwd -P)"`), 'printed from the workspace');
  assert.ok(script.indexOf(unitSuite.ROOT_SENTINEL) < script.indexOf('npm ci'), 'before anything can fail');
  assert.match(out.row.failureReason, /^tests\/x\.test\.js \(1\): regression \| /);
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

test('the non-TAP tail leaves the script\'s own marker lines out', () => {
  const stdout = [`${unitSuite.ROOT_SENTINEL}=${WS}`, unitSuite.CLONED_SENTINEL, 'npm error code E404'].join('\n');
  const d = unitSuite.failureDetail(stdout, '');
  assert.equal(d, 'Suite setup failed (clone / npm ci), so the tests never ran. | npm error code E404');
});

// ── failingTestDetails: each failing test's own error (#3978) ──────────

const rowCaps = require('../src/services/unit-suite-row');

test('each failing test keeps its YAML diagnostic fields, its stack and its nearby output', () => {
  const stdout = [
    `${unitSuite.ROOT_SENTINEL}=${WS}`,
    unitSuite.CLONED_SENTINEL,
    SENTINEL,
    'TAP version 13',
    'ok 1 - fine',
    'console.log from the test',
    'second printed line',
    tapFail(2, 'explodes', 'tests/a.test.js'),
    '1..2',
    '# tests 2',
    '# pass 1',
    '# fail 1',
    '# cancelled 0',
  ].join('\n');
  const got = unitSuite.failingTestDetails(stdout.split('\n'));
  assert.ok(got, 'a failing run records details');
  assert.equal(got.details.length, 1);
  assert.equal(got.detailsOmitted, undefined, 'nothing was left out at this size');
  const d = got.details[0];
  assert.equal(d.file, 'tests/a.test.js', 'repo-relative, like the reason names it');
  assert.equal(d.name, 'explodes');
  assert.match(d.excerpt, /^error: 'boom'$/m);
  assert.match(d.excerpt, /^code: 'ERR_ASSERTION'$/m);
  assert.match(d.excerpt, /^failureType: 'testCodeFailure'$/m);
  assert.match(d.excerpt, /^stack:\n {4}TestContext\.<anonymous>/m, 'the first stack lines');
  assert.doesNotMatch(d.excerpt, /duration_ms|type: 'test'/, 'plumbing keys are not kept');
  assert.match(d.excerpt, /^output:\n {4}console\.log from the test\n {4}second printed line$/m,
    'the test\'s own printed output, in order');
  assert.doesNotMatch(d.excerpt, /fine|# tests|TAP version/,
    'other tests, counters and plumbing are not the failing test\'s output');
});

test('a passing run, and SKIP and TODO, record no details', () => {
  const passing = unitSuite.failingTestDetails([
    SENTINEL,
    'ok 1 - fine',
    tapFail(2, 'todo one', 'tests/a.test.js').replace('\nnot ok 2', '\nnot ok 2 # TODO'),
    tapFail(3, 'skipped one', 'tests/b.test.js').replace('\nnot ok 3', '\nnot ok 3 # SKIP'),
    '# tests 3',
    '# pass 1',
  ].join('\n').split('\n'));
  assert.equal(passing, null);
});

test('a run that failed without failing tests (timeout, setup) records no details', () => {
  assert.equal(unitSuite.failingTestDetails(['npm error code E404', 'npm error 404 Not Found'].join('\n').split('\n')), null);
  assert.equal(unitSuite.failingTestDetails([].join('\n').split('\n')), null);
});

test('one excerpt is clipped to TEST_EXCERPT_MAX', () => {
  const stdout = [
    `${unitSuite.ROOT_SENTINEL}=${WS}`,
    SENTINEL,
    'not ok 1 - huge',
    '  ---',
    `  error: '${'x'.repeat(6000)}'`,
    '  ...',
  ].join('\n');
  const got = unitSuite.failingTestDetails(stdout.split('\n'));
  assert.equal(got.details.length, 1);
  const ex = got.details[0].excerpt;
  assert.equal(ex.length, rowCaps.TEST_EXCERPT_MAX);
  assert.match(ex, /…$/, 'the clip is marked');
});

test('the row keeps what fits its budget and counts what it left out', () => {
  const big = 'y'.repeat(1500);
  const blocks = Array.from({ length: 30 }, (_, i) => [
    `not ok ${i + 1} - oversized case ${i + 1}`,
    '  ---',
    `  location: '${WS}/tests/f${i + 1}.test.js:10:1'`,
    `  error: '${big}'`,
    '  ...',
  ].join('\n'));
  const stdout = [
    `${unitSuite.ROOT_SENTINEL}=${WS}`,
    SENTINEL,
    ...blocks,
    '# tests 30',
    '# fail 30',
  ].join('\n');
  const got = unitSuite.failingTestDetails(stdout.split('\n'));
  assert.ok(got.details.length < 30, 'the row budget is not bottomless');
  assert.equal(got.details.length + got.detailsOmitted, 30, 'the tests left out are counted, not lost');
  assert.ok(got.details.length > 1, 'more than one fits');
  assert.equal(got.details[0].name, 'oversized case 1', 'filled in output order');
  for (const d of got.details) assert.ok(d.excerpt.length <= rowCaps.TEST_EXCERPT_MAX);
  const bytes = JSON.stringify(got.details).length;
  assert.ok(bytes <= rowCaps.UNIT_DETAILS_ROW_MAX, `${bytes} bytes > ${rowCaps.UNIT_DETAILS_ROW_MAX}`);
});

test('excerpts are redacted with the check logs\' own rules before they are stored', () => {
  const stdout = [
    `${unitSuite.ROOT_SENTINEL}=${WS}`,
    SENTINEL,
    'postgres://user:secret@host:5432/db refused a connection',
    'SENDGRID_API_KEY=sg-live-token-value',
    tapFail(1, 'leaky', 'tests/a.test.js'),
  ].join('\n');
  const got = unitSuite.failingTestDetails(stdout.split('\n'));
  const ex = got.details[0].excerpt;
  assert.doesNotMatch(ex, /secret@/);
  assert.match(ex, /postgres:\/\/user:\*\*\*\*@/, 'the DSN keeps its shape, loses its password');
  assert.doesNotMatch(ex, /sg-live-token-value/);
  assert.match(ex, /SENDGRID_API_KEY=\*\*\*\*/, 'the variable name survives, the value does not');
});

test('the live run attaches the details to the row; a setup failure does not', async (t) => {
  const github = require('../src/services/github');
  const docker = require('../src/services/docker');
  const history = require('../src/services/check-history');
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getFileContent', async () => '{"scripts":{"test":"node --test"}}');
  t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
  t.mock.method(history, 'loadGraduated', async () => new Set());
  const withFailure = t.mock.method(docker, 'runOneShot', async () => {
    throw Object.assign(new Error('exit 1'), {
      stdout: tapRun([tapFail(1, 'regression', 'tests/x.test.js')]), code: 1,
    });
  });
  const base = { config: {}, pool: { query: async () => ({ rows: [] }) }, appId: 10, sessionId: 7, repoOwner: 'example', repoName: 'repo', ref: 'a'.repeat(40) };
  const out = await unitSuite.maybeRunUnitSuite(base);
  assert.equal(out.row.status, 'fail');
  assert.equal(out.row.details.length, 1);
  assert.equal(out.row.details[0].name, 'regression');
  withFailure.mock.mockImplementation(async () => {
    throw Object.assign(new Error('exit 1'), { stdout: 'npm error code E404\nnpm error 404 Not Found', code: 1 });
  });
  const setup = await unitSuite.maybeRunUnitSuite(base);
  assert.match(setup.row.failureReason, /Suite setup failed/);
  assert.ok(!('details' in setup.row), 'no failing tests, no details');
});

test('the harvest path records the same details from the finished Job\'s output', async () => {
  const out = await unitSuite.outcomeFromLog({
    pool: { query: async () => ({ rows: [] }) }, appId: 10, sessionId: 9,
    succeeded: false, graduated: true,
    stdout: tapRun([tapFail(1, 'regression', 'tests/x.test.js')]),
  });
  assert.equal(out.row.status, 'fail');
  assert.ok(Array.isArray(out.row.details));
  assert.equal(out.row.details[0].name, 'regression');
  assert.equal(out.row.details[0].file, 'tests/x.test.js');
  assert.match(out.row.failureReason, /^tests\/x\.test\.js \(1\): regression \| /, 'the reason is unchanged by the details');
});

test('a passing harvest records no details', async () => {
  const out = await unitSuite.outcomeFromLog({
    pool: { query: async () => ({ rows: [] }) }, appId: 10, sessionId: 9,
    succeeded: true, graduated: true,
    stdout: tapRun([tapFail(1, 'regression', 'tests/x.test.js')], { fail: 0 }),
  });
  assert.equal(out.row.status, 'pass');
  assert.ok(!('details' in out.row));
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


for (const failed of [false, true]) {
  test(`Kubernetes unit-suite dispatch ${failed ? 'fails closed with TAP details' : 'uses the pinned runtime and records final TAP summary'}`, async (t) => {
    const github = require('../src/services/github');
    const kubernetes = require('../src/services/kubernetes');
    const docker = require('../src/services/docker');
    const history = require('../src/services/check-history');
    t.mock.method(github, 'isEnabled', () => true);
    t.mock.method(github, 'getFileContent', async () => '{"scripts":{"test":"node --test"}}');
    t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
    t.mock.method(history, 'loadGraduated', async () => new Set());
    t.mock.method(docker, 'runOneShot', async () => { assert.fail('Docker must not run'); });
    t.mock.method(kubernetes, 'runUnitSuiteJob', async (config, options) => {
      assert.equal(config.workerRuntime, 'kubernetes');
      assert.equal(options.sessionId, 3994);
      assert.equal(options.env.GIT_REF, 'a'.repeat(40));
      assert.equal(typeof options.onStdoutLine, 'function');
      const stdout = `${SENTINEL}\n# tests 2\n# pass ${failed ? 1 : 2}\n# fail ${failed ? 1 : 0}\n`;
      if (failed) throw Object.assign(new Error('exit 1'), { stdout: stdout + 'not ok 2 - regression\n', code: 1 });
      return { stdout };
    });
    const out = await unitSuite.maybeRunUnitSuite({ config: { workerRuntime: 'kubernetes' }, pool: { query: async () => ({ rows: [] }) }, appId: 10, sessionId: 3994, repoOwner: 'example', repoName: 'repo', ref: 'a'.repeat(40) });
    assert.equal(out.row.status, failed ? 'fail' : 'pass');
    assert.equal(out.row.summary.tests, 2);
    assert.equal(out.row.summary.fail, failed ? 1 : 0);
    if (failed) assert.match(out.row.failureReason, /^\(file not reported\) \(1\): regression \| # tests 2/);
  });
}
