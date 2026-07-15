// Tests for the merge-window countdown formatter (app-view.js
// AppView._fmtCountdown). #627: labels are two-unit and floor-rounded so
// day-scale countdowns visibly tick down (~2d 5h) instead of sitting on a
// single coarse unit (~2d) for a whole day. Zero second units are omitted
// (~2d, ~5h) and the sub-hour floor of ~1m is preserved.
//
// Same vm-context harness as voting-help-text.test.js: load app-view.js
// into a sandbox, stub the globals it reaches, assert on the returned text.
//
// Run with: node --test tests/fmt-countdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'),
  'utf8'
);
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

const AppView = makeAppView();
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

test('days + hours: 2d 5h → "~2d 5h"', () => {
  assert.equal(AppView._fmtCountdown(2 * DAY + 5 * HOUR), '~2d 5h');
});

test('days + hours: 6d 23h → "~6d 23h"', () => {
  assert.equal(AppView._fmtCountdown(6 * DAY + 23 * HOUR), '~6d 23h');
});

test('exact days omit the zero hours term: 2d → "~2d"', () => {
  assert.equal(AppView._fmtCountdown(2 * DAY), '~2d');
});

test('sub-hour remainder floors away at day scale: 1d 0h 30m → "~1d"', () => {
  assert.equal(AppView._fmtCountdown(1 * DAY + 30 * MIN), '~1d');
});

test('hours + minutes: 90 min → "~1h 30m"', () => {
  assert.equal(AppView._fmtCountdown(90 * MIN), '~1h 30m');
});

test('exact hours omit the zero minutes term: 5h → "~5h"', () => {
  assert.equal(AppView._fmtCountdown(5 * HOUR), '~5h');
});

test('under an hour stays minutes-only: 40 min → "~40m"', () => {
  assert.equal(AppView._fmtCountdown(40 * MIN), '~40m');
});

test('sub-minute floors to the ~1m minimum: 30 s → "~1m"', () => {
  assert.equal(AppView._fmtCountdown(30 * 1000), '~1m');
});

test('zero and negative clamp to "~1m"', () => {
  assert.equal(AppView._fmtCountdown(0), '~1m');
  assert.equal(AppView._fmtCountdown(-5 * MIN), '~1m');
});
