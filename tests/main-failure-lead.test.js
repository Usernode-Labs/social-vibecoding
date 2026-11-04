'use strict';

// #6288 — whose failing tests are these?
//
// While main is red, every change built on it fails the same test whatever
// it changes, and the Testing card blamed the change: "One of this change's
// tests failed." The card, the board's "Checks failing" tooltip and the
// Checks step now compare the change's unit-suite failures with the tests
// main watch says main is failing. All of them main's: the card says so and
// points at the request that fixes main. Some of them: it names both sets.
// Main green (or a partial list of its failures): the old words return.
//
// Run with: node --test tests/main-failure-lead.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');

function appView() {
  const c = {
    console,
    App: { user: { id: 42, username: 'Builder' }, currentApp: 'example' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = englishPlatformI18n();
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example' };
  return c.av;
}

const SHARED = { file: 'tests/shared.test.js', test: 'a test main already fails', excerpt: 'location: /tmp/tests/shared.test.js:2:1' };
const OWN = { file: 'tests/own.test.js', test: 'a test only this change breaks', excerpt: 'location: /tmp/tests/own.test.js:3:1' };
const unitRow = (details) => ({
  index: -3, name: 'Repo unit suite (npm test) passes', path: 'package.json', status: 'fail',
  failureReason: `suite output | # tests ${details.length} | # pass 0 | # fail ${details.length}`,
  failureDetails: details,
});
const pr = (details) => ({
  id: 4090, check_state: 'failing', checks_checked_at: '2026-11-04T13:00:00Z',
  test_results: [unitRow(details)], test_results_omitted: 0,
});
const main = (over = {}) => ({
  state: 'failing', paused: true, sha: 'a'.repeat(40), pausedSha: 'a'.repeat(40),
  requestNumber: 6283,
  detail: { failingTests: [{ file: SHARED.file, test: SHARED.test }], failingTestsComplete: true },
  ...over,
});

test('a change failing only main\'s test says so, and names the request', () => {
  const av = appView();
  av._proposalsCtx = { mainCheck: main() };
  const v = av._checksVerdictView(pr([SHARED]));
  assert.equal(av._failedLead(v), message('changes:page.testing.lead.mainAll', { count: 1 }));
  assert.equal(av._failedLead(v), 'Main is failing this test too, so it isn’t this change. Merges are paused until main’s fix lands, and this change’s checks run again by themselves then.');
  const link = av._mainFailureLink(v);
  assert.equal(link.href, '#app/example/dev/issues/6283');
  assert.equal(link.label, message('changes:page.testing.mainFix.link', { number: 6283 }));
  assert.equal(link.mixed, false);
  // The Checks step gets the same words, above the failure's own.
  assert.equal(av._checksExplainView({ id: 4090, check_state: 'failing', checks_checked_at: '2026-11-04T13:00:00Z' }, v).mainLead,
    av._failedLead(v));
});

test('a change failing main\'s test and one of its own names both', () => {
  const av = appView();
  av._proposalsCtx = { mainCheck: main() };
  const v = av._checksVerdictView(pr([SHARED, OWN]));
  const lead = av._failedLead(v);
  assert.equal(lead, message('changes:page.testing.lead.mainSome', {
    main: 'a test main already fails',
    own: 'a test only this change breaks',
  }));
  assert.match(lead, /a test main already fails/);
  assert.match(lead, /a test only this change breaks/);
  assert.equal(av._mainFailureLink(v).mixed, true);
});

test('main green, or a list it could not name in full, returns the old words', () => {
  const av = appView();
  const v = av._checksVerdictView(pr([SHARED]));
  av._proposalsCtx = { mainCheck: { state: 'passing', paused: false, detail: {} } };
  assert.equal(av._failedLead(v), message('changes:page.testing.lead.tests', { count: 1 }));
  assert.equal(av._mainFailureLink(v), null);
  // A partial list may not call a test main's.
  av._proposalsCtx = { mainCheck: main({ detail: { failingTests: [{ file: SHARED.file, test: SHARED.test }], failingTestsComplete: false } }) };
  assert.equal(av._failedLead(v), message('changes:page.testing.lead.tests', { count: 1 }));
  // Nor may a red main whose merges an admin resumed.
  av._proposalsCtx = { mainCheck: main({ paused: false }) };
  assert.equal(av._failedLead(v), message('changes:page.testing.lead.tests', { count: 1 }));
  // The test must still fail on main by name.
  av._proposalsCtx = { mainCheck: main({ detail: { failingTests: [{ file: 'tests/x.test.js', test: 'another test' }], failingTestsComplete: true } }) };
  assert.equal(av._failedLead(v), message('changes:page.testing.lead.tests', { count: 1 }));
});
