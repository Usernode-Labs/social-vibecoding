// #1019 "run every declared check": the orchestrator side of the change —
// visuals.classifyTests under earned gating, the completion sentinel, and
// the serialised-results cap.
//
// The rule this file exists to pin down: a check BLOCKS a merge only once it
// has been observed passing at least once (its `first_passed_at` in
// app_check_history is set). Until then it is ADVISORY — it renders, it is
// counted, it does not gate. That is what makes it safe to go from running
// 12 of this repo's 241 declared checks to running all 241: the 229 that
// were never running cannot suddenly block every open proposal.
//
// Two failure modes are easy to write by accident and both are tested here:
//
//   * POSITIONAL matching. Frames arrive out of order from a parallel pool
//     and a check that produced no frame leaves a hole. Zipping frames to
//     the dispatch list by position shifts every later row onto the wrong
//     check — and with it, the wrong graduated flag, which is a merge gate
//     attached to the wrong assertion.
//   * FAILING OPEN on a missing graduated check. "We ran out of budget" is
//     not a pass. If the deadline could silently drop a check that has
//     earned gating, the deadline is a merge bypass.
//
// Run with: node --test tests/checks-classification.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');
const appManifest = require('../src/services/app-manifest');

function frame(index, status, extra = {}) {
  return {
    index,
    status,
    name: extra.name || `check ${index}`,
    path: extra.path || `/p${index}`,
    consoleErrors: extra.consoleErrors || [],
    failureReason: extra.failureReason || (status === 'pass' ? '' : 'boom'),
  };
}

function dispatch(specs) {
  return specs.map((s, i) => ({
    index: typeof s.index === 'number' ? s.index : i,
    name: s.name || `check ${typeof s.index === 'number' ? s.index : i}`,
    path: s.path || `/p${typeof s.index === 'number' ? s.index : i}`,
    graduated: !!s.graduated,
  }));
}

// ── the sentinel ───────────────────────────────────────────────────────

test('parseTestsDone reads the completion sentinel', () => {
  const out = visuals.parseTestsDone(
    'noise\n__USERNODE_TESTS_DONE__ ran=238 expected=241 deadline=1\nmore noise\n');
  assert.deepEqual(out, { ran: 238, expected: 241, deadline: true });
});

test('parseTestsDone returns null when the run never finished', () => {
  // No sentinel means the container died mid-suite — distinct from a suite
  // that finished and reported partial coverage, and the caller must be able
  // to tell those apart.
  assert.equal(visuals.parseTestsDone('__USERNODE_TEST__ index=0 status=pass loadStatus=200'), null);
  assert.equal(visuals.parseTestsDone(''), null);
  assert.equal(visuals.parseTestsDone(null), null);
});

test('parseTestsDone keeps the last sentinel when stdout has more than one', () => {
  const out = visuals.parseTestsDone(
    '__USERNODE_TESTS_DONE__ ran=1 expected=2 deadline=0\n'
    + '__USERNODE_TESTS_DONE__ ran=2 expected=2 deadline=0\n');
  assert.equal(out.ran, 2);
  assert.equal(out.deadline, false);
});

// ── earned gating ──────────────────────────────────────────────────────

test('an advisory failure does not block; a graduated failure does', () => {
  const dispatched = dispatch([
    { graduated: true }, { graduated: true }, { graduated: false },
  ]);
  const clean = visuals.classifyTests(
    [frame(0, 'pass'), frame(1, 'pass'), frame(2, 'fail')], 3, { dispatched });
  assert.equal(clean.state, 'passing', 'a never-passed check failing is not a merge gate');
  assert.equal(clean.blockingCount, 0);
  assert.equal(clean.advisoryCount, 1);
  assert.equal(clean.passingCount, 2);
  assert.equal(clean.results.find((r) => r.index === 2).advisory, true);

  const gated = visuals.classifyTests(
    [frame(0, 'pass'), frame(1, 'fail'), frame(2, 'pass')], 3, { dispatched });
  assert.equal(gated.state, 'failing');
  assert.equal(gated.blockingCount, 1);
  assert.equal(gated.results.find((r) => r.index === 1).advisory, false);
});

test('a passing row is never marked advisory', () => {
  // The chip means "this failure will not stop you". On a green row it would
  // read as "this pass does not count", which is the opposite of the truth.
  const out = visuals.classifyTests([frame(0, 'pass')], 1, {
    dispatched: dispatch([{ graduated: false }]),
  });
  assert.equal(out.results[0].advisory, false);
});

test('frames are matched to checks by index, not by position', () => {
  // The pool finishes out of order and check 1 produced nothing. Positional
  // zipping would put check 2's frame on check 1 — attaching check 1's
  // merge gate to check 2's assertion.
  const dispatched = dispatch([
    { graduated: false, name: 'alpha' },
    { graduated: false, name: 'bravo' },
    { graduated: true, name: 'charlie' },
  ]);
  const out = visuals.classifyTests([
    frame(2, 'fail', { name: 'charlie', path: '/c' }),
    frame(0, 'pass', { name: 'alpha', path: '/a' }),
  ], 3, { dispatched });

  const charlie = out.results.find((r) => r.name === 'charlie');
  assert.equal(charlie.status, 'fail');
  assert.equal(charlie.advisory, false, 'charlie is the graduated one and it really failed');
  assert.equal(out.state, 'failing');
  assert.equal(out.blockingCount, 1);
  const alpha = out.results.find((r) => r.name === 'alpha');
  assert.equal(alpha.status, 'pass');
});

test('a graduated check with no result fails closed', () => {
  const dispatched = dispatch([
    { graduated: true, name: 'login works' },
    { graduated: false },
  ]);
  const out = visuals.classifyTests([frame(1, 'pass')], 2, { dispatched });
  assert.equal(out.state, 'error',
    'a merge-blocking check that produced no verdict is not a pass');
  assert.match(out.errorDetail, /login works/,
    'and the detail names it, so the fix is obvious');
  assert.match(out.errorDetail, /1 merge-blocking check produced no result/);
});

test('the fail-closed detail summarises rather than listing everything', () => {
  const dispatched = dispatch(Array.from({ length: 9 }, () => ({ graduated: true })));
  const out = visuals.classifyTests([frame(0, 'pass')], 9, { dispatched });
  assert.equal(out.state, 'error');
  assert.match(out.errorDetail, /8 merge-blocking checks produced no result/,
    'nine dispatched, one reported');
  assert.match(out.errorDetail, /\+5 more/, 'three named, the rest counted');
});

test('advisory checks with no result collapse into one honest row', () => {
  const dispatched = dispatch([
    { graduated: true }, { graduated: false }, { graduated: false }, { graduated: false },
  ]);
  const out = visuals.classifyTests([frame(0, 'pass')], 4, {
    dispatched,
    sentinel: { ran: 1, expected: 4, deadline: true },
  });
  assert.equal(out.state, 'passing', 'never-passed checks going missing is not a gate');
  const collapsed = out.results.filter((r) => r.index === -1);
  assert.equal(collapsed.length, 1, 'one row, not three indistinguishable "no result" lines');
  assert.match(collapsed[0].name, /3 checks did not finish in the run budget/);
  assert.equal(collapsed[0].advisory, true);
  assert.equal(collapsed[0].count, 3,
    'the row carries what it stands for, so the card can count checks rather '
    + 'than rows and avoid under-reporting the suite');
  assert.equal(out.advisoryCount, 3);
});

test('the collapsed row says "produced no result" when the budget was not the cause', () => {
  const out = visuals.classifyTests([frame(0, 'pass')], 2, {
    dispatched: dispatch([{ graduated: true }, { graduated: false }]),
    sentinel: { ran: 2, expected: 2, deadline: false },
  });
  const collapsed = out.results.find((r) => r.index === -1);
  assert.match(collapsed.name, /1 check produced no result/,
    'blaming the budget for something else would send people to the wrong knob');
});

test('no frames at all is an error, never a verdict', () => {
  // The container crashed, staging never booted, stdout was lost. Reporting
  // "passing" here would merge on the strength of nothing having run.
  const out = visuals.classifyTests([], 5, {
    dispatched: dispatch(Array.from({ length: 5 }, () => ({ graduated: false }))),
  });
  assert.equal(out.state, 'error');
  assert.equal(out.ranCount, 0);
  assert.equal(out.declaredCount, 5);
});

test('counts describe the whole run, not just what fit on screen', () => {
  const dispatched = dispatch([
    { graduated: true }, { graduated: true }, { graduated: true },
    { graduated: false }, { graduated: false },
  ]);
  const out = visuals.classifyTests([
    frame(0, 'pass'), frame(1, 'pass'), frame(2, 'fail'),
    frame(3, 'fail'), frame(4, 'pass'),
  ], 5, { dispatched });
  assert.equal(out.passingCount, 3);
  assert.equal(out.blockingCount, 1);
  assert.equal(out.advisoryCount, 1);
  assert.equal(out.ranCount, 5);
  assert.equal(out.declaredCount, 5);
});

test('an extra row can block even when every declared check passed', () => {
  // The over-ceiling guard rides in as an extraRow. It has to be able to
  // turn the whole card red on its own, or a manifest that outgrew the
  // ceiling would merge with a green tick and silently-unrun checks.
  const extra = {
    index: -2,
    name: `Manifest declares more than ${appManifest.MAX_DECLARED_TESTS} checks`,
    path: appManifest.MANIFEST_FILENAME,
    status: 'fail',
    advisory: false,
    consoleErrors: [],
    failureReason: 'too many',
  };
  const out = visuals.classifyTests([frame(0, 'pass')], 1, {
    dispatched: dispatch([{ graduated: true }]),
    extraRows: [extra],
  });
  assert.equal(out.state, 'failing');
  assert.equal(out.blockingCount, 1);
  assert.ok(out.results.some((r) => r.index === -2), 'and it is visible in the card');
});

test('the over-ceiling guard stays quiet when nothing was dropped', () => {
  // Guarded before any base-manifest lookup, so this needs no network.
  return visuals.overCeilingCheckRow('o', 'r', 0).then((row) => {
    assert.equal(row, null);
  });
});

// ── legacy shape (no dispatch list) ────────────────────────────────────

test('without a dispatch list every check still blocks, as before', () => {
  // Baseline suites synthesised for an app with no declared tests have no
  // history to consult. They keep the old all-blocking semantics; if they
  // dropped to advisory, removing the cap would have opened a gate rather
  // than left it where it was.
  const legacy = visuals.classifyTests([frame(0, 'fail')], 1);
  assert.equal(legacy.state, 'failing');
  assert.equal(legacy.results[0].status, 'fail');
  assert.equal(legacy.results[0].advisory, undefined, 'no advisory field in the legacy shape');

  const short = visuals.classifyTests([frame(0, 'pass')], 2);
  assert.equal(short.state, 'error', 'a missing frame is still fail-closed');

  const green = visuals.classifyTests([frame(0, 'pass'), frame(1, 'pass')], 2);
  assert.equal(green.state, 'passing');
});

// ── payload cap ────────────────────────────────────────────────────────

test('serializeTestResults keeps small payloads byte-identical', () => {
  const rows = [{ name: 'a', path: '/a', status: 'pass', consoleErrors: [], failureReason: '' }];
  assert.equal(visuals.serializeTestResults(rows), JSON.stringify(rows));
});

test('an oversized payload sheds passing rows before failures', () => {
  // test_results rides along in every proposal payload the API serves. When
  // it has to be trimmed, the failures are the reason anyone opened the card
  // — a passing row's information is already in the summary count.
  const fat = 'x'.repeat(4000);
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push({
      name: `pass ${i}`, path: `/p${i}`, status: 'pass',
      consoleErrors: [{ type: 'log', message: fat }], failureReason: '',
    });
  }
  rows.push({
    name: 'the real failure', path: '/boom', status: 'fail', advisory: false,
    consoleErrors: [{ type: 'error', message: 'TypeError: undefined is not a function' }],
    failureReason: 'Expected element ".board" was not found',
  });
  const json = visuals.serializeTestResults(rows);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 256 * 1024, 'the cap is respected');
  const kept = JSON.parse(json);
  assert.ok(kept.some((r) => r.name === 'the real failure'),
    'the failure survives the trim');
  assert.ok(kept.length < rows.length, 'and passing rows were what got dropped');
  assert.ok(kept.filter((r) => r.status === 'pass').length < 120);
});

test('the result ceiling is at least the manifest ceiling', () => {
  // classifyTests slices frames to TEST_MAX_RESULTS. If that were below
  // MAX_DECLARED_TESTS, the reader's cap would just have moved downstream —
  // the tail checks would run and then be thrown away, which is the exact
  // bug #1019 set out to remove.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  assert.match(src, /const TEST_MAX_RESULTS = appManifest\.MAX_DECLARED_TESTS;/,
    'TEST_MAX_RESULTS must track the manifest ceiling rather than drift from it');
});
