'use strict';

// Retrying a failed check before believing it.
//
// The debut runs that shipped with earned-gating only cover a check's FIRST
// appearance. This is the other half: an established check that starts
// failing intermittently — which is what the four checks that reddened this
// app's own merges actually were. It failed, it is asked again on its own
// cold document, and if it answers differently the merge is not blocked on
// a coin flip. It keeps every bit of its power to block; what it loses is
// its streak, and what it gains is a label.
//
// Run with: node --test tests/check-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const visuals = require('../src/services/visuals');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** One __USERNODE_TEST__ frame, exactly as the container writes it. */
function frame(index, status, payload = {}) {
  const json = Buffer.from(JSON.stringify({ name: `check ${index}`, path: '/', ...payload }), 'utf8')
    .toString('base64');
  return `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200\n${json}\n__USERNODE_TEST_END__`;
}
const dispatch = (n) => Array.from({ length: n }, (_, i) => ({
  index: i, checkKey: `k${i}`, name: `check ${i}`, path: '/', graduated: true,
}));

test('a failure that does not reproduce does not block the merge', () => {
  const stdout = [
    frame(0, 'pass'),
    frame(1, 'fail', { failureReason: '1 console error on load' }),
    // The container asked check 1 again, three times, on its own document.
    frame(1000000, 'fail', { retryOf: 1 }),
    frame(1000001, 'pass', { retryOf: 1 }),
    frame(1000002, 'pass', { retryOf: 1 }),
  ].join('\n');
  const out = visuals.classifyTests(visuals.parseTests(stdout), 2, { dispatched: dispatch(2) });
  assert.equal(out.state, 'passing', 'one reproducible pass is enough to unblock');
  const row = out.results.find((r) => r.index === 1);
  assert.equal(row.status, 'pass');
  assert.equal(row.passedOnRetry, true);
  assert.equal(row.flakyRun, true, 'and it is on the record as unreliable');
  assert.equal(row.runs, 4);
  assert.equal(row.passes, 2);
  assert.equal(row.fails, 2, 'every observation counted, including the ones that failed');
});

test('a failure that reproduces every time still blocks', () => {
  const stdout = [
    frame(0, 'pass'),
    frame(1, 'fail', { failureReason: 'Expected element "#x" was not found' }),
    frame(1000000, 'fail', { retryOf: 1 }),
    frame(1000001, 'fail', { retryOf: 1 }),
    frame(1000002, 'fail', { retryOf: 1 }),
  ].join('\n');
  const out = visuals.classifyTests(visuals.parseTests(stdout), 2, { dispatched: dispatch(2) });
  assert.equal(out.state, 'failing');
  const row = out.results.find((r) => r.index === 1);
  assert.equal(row.status, 'fail');
  assert.equal(row.passedOnRetry, false);
  assert.equal(row.flakyRun, false, 'four failures in a row is not flakiness, it is a bug');
});

test('a retry is not a check of its own', () => {
  const stdout = [frame(0, 'fail'), frame(1000000, 'pass', { retryOf: 0 })].join('\n');
  const out = visuals.classifyTests(visuals.parseTests(stdout), 1, { dispatched: dispatch(1) });
  assert.equal(out.results.length, 1, 'one declared check, one row');
  assert.equal(out.declaredCount, 1);
  assert.equal(out.results[0].index, 0);
});

test('a full manifest retains late retries without adding result rows', () => {
  const count = require('../src/services/app-manifest').MAX_DECLARED_TESTS;
  const primary = Array.from({ length: count }, (_, i) => frame(i, i < 10 ? 'fail' : 'pass'));
  const retries = Array.from({ length: 30 }, (_, i) => frame(1000000 + i,
    i % 3 === 2 ? 'pass' : 'fail', { retryOf: Math.floor(i / 3) }));
  // Runtime output is concurrent, and parseTests sorts retries after all
  // declarations. Every successful retry is therefore beyond the old cap.
  const parsed = visuals.parseTests([...retries, ...primary.reverse()].join('\n'));
  const out = visuals.classifyTests(parsed, count, { dispatched: dispatch(count) });
  assert.equal(out.state, 'passing');
  assert.equal(out.results.length, count);
  assert.equal(out.ranCount, count);
  for (const row of out.results.slice(0, 10)) {
    assert.equal(row.passedOnRetry, true);
    assert.equal(row.flakyRun, true);
    assert.equal(row.runs, 4);
    assert.equal(row.passes, 1);
    assert.equal(row.fails, 3);
  }
});

test('an unrelated retry cannot hide a missing declared result', () => {
  const parsed = visuals.parseTests([
    frame(0, 'pass'), frame(1000000, 'pass', { retryOf: 99 }),
    frame(1000001, 'pass', { retryOf: 1 }),
  ].join('\n'));
  const out = visuals.classifyTests(parsed, 2, { dispatched: dispatch(2) });
  assert.equal(out.state, 'error');
  assert.equal(out.ranCount, 1);
  assert.match(out.errorDetail, /check 1/);
});

test('the container asks again, on its own document, within its caps', () => {
  const src = read('capture/capture.js');
  assert.match(src, /const RETRY_INDEX_BASE = 1000000;/,
    'a retry that reused an index would be dropped by emitTest');
  assert.match(src, /const RETRY_RUNS = 3;/);
  assert.match(src, /const RETRY_MAX_CHECKS = 10;/);
  assert.match(src, /const RETRY_SKIP_FRACTION = 0\.25;/);
  assert.match(src, /const tooManyRed = failedPrimaries\.length > list\.length \* RETRY_SKIP_FRACTION;/,
    'a quarter of the suite red is the change, not flakiness');
  assert.match(src, /retryGroups\.push\(\[\{ \.\.\.t, index, solo: true \}\]\);/,
    'each retry is its own group and its own cold load, or it is a second '
    + 'assertion against a page somebody already loaded');
  assert.match(src, /await runOne\(group, \{ counts: false \}\);/,
    'a retry does not inflate the "did every check report?" arithmetic');
  assert.match(src, /if \(\(now\(\) - startedAt\) >= budgetMs\) \{ hitDeadline = true; return; \}[\s\S]{0,400}retryGroups\[rCursor\]/,
    'and it never runs past the run budget');
});

test('the row keeps its reason when it only passed because of a retry', () => {
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  assert.equal(
    AppView._checkReason({ runs: 4, fails: 2, passedOnRetry: true, failureReason: '1 console error on load' }),
    'Failed 2 of 4 runs on this build, then passed when re-run. 1 console error on load'
  );
  const v = AppView._checksVerdictView({
    check_state: 'passing',
    test_results: [{
      name: 'Workshop loads', path: '/workshop', status: 'pass',
      runs: 4, passes: 2, fails: 2, passedOnRetry: true, failureReason: '1 console error on load',
    }],
  });
  assert.equal(v.passes[0].keepReason, true, 'a green row that hid a failure would be a lie of omission');
  assert.match(v.passes[0].reason, /then passed when re-run/);
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /\{!r\.pass \|\| r\.keepReason \? \(/, 'and the renderer draws it');
});
