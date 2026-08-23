// An origin that does not resolve is 'error', not 'failing' (#1381).
//
// These two states look the same on a check row and mean opposite things.
// 'failing' is a verdict ABOUT THE APP: it sticks to the commit, it stamps
// fail_count onto the check's history, it schedules no retry and escalates to
// nobody, because a failing test is the author's problem. 'error' is "we could
// not find out": it backs off, retries, records check_error_detail, escalates
// to the owner, and shows "⚠ Checks couldn't run" instead of a red X next to
// the author's name.
//
// WorkQuest's proposal got the first one for the second thing. Its staging
// container was Up and healthy and had logged exactly two lines — a seed
// message and "Listening on :3000" — with zero inbound requests across two
// full check runs, because its 66-byte container name is not a resolvable DNS
// label. Every check "failed", consecutive_check_failures stayed 0, no retry
// was ever scheduled, seven history rows were stamped 0 passes / 2 fails for
// checks that never executed, and the merge gate closed permanently on a
// proposal that had already won its vote.
//
// Run with: node --test tests/checks-unreachable-origin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { unreachableOriginDetail } = require('../src/services/visuals');

const ORIGIN = 'http://usernode-staging-workquest-escape-from-the-underclass-831ec5--3539:3000';

function row(name, { pass = false, errors = [] } = {}) {
  return { name, path: `/${name}`, status: pass ? 'pass' : 'fail', consoleErrors: errors };
}

// What Chrome actually reports when the hostname does not resolve.
const NXDOMAIN = [{ kind: 'load', message: 'net::ERR_NAME_NOT_RESOLVED', source: ORIGIN }];

test('every row failing to load at the origin is an error, with the origin named', () => {
  const detail = unreachableOriginDetail(
    [row('home', { errors: NXDOMAIN }), row('board', { errors: NXDOMAIN })],
    ORIGIN
  );
  assert.ok(detail, 'a whole-origin outage must be distinguishable from a failing suite');
  assert.match(detail, /unreachable/i);
  assert.ok(detail.includes(ORIGIN), 'the detail is what tells an owner WHERE to look');
  assert.ok(detail.includes('ERR_NAME_NOT_RESOLVED'));
});

test('the other origin-level failures count too', () => {
  for (const message of [
    'net::ERR_CONNECTION_REFUSED',
    'connect ECONNREFUSED 172.18.0.9:3000',
    'net::ERR_ADDRESS_UNREACHABLE',
  ]) {
    const detail = unreachableOriginDetail([row('home', { errors: [{ kind: 'load', message }] })], ORIGIN);
    assert.ok(detail, `${message} should read as an unreachable origin`);
  }
});

test('ONE unreachable route among passing ones stays the app\'s problem', () => {
  // This is a deep link the app itself got wrong — pointing at a host that
  // does not exist is exactly the bug a check is supposed to catch, and the
  // proof the origin is fine is that the other routes loaded.
  const detail = unreachableOriginDetail([
    row('home', { pass: true }),
    row('share', { errors: NXDOMAIN }),
  ], ORIGIN);
  assert.equal(detail, null);
});

test('an ordinary failing suite is never re-labelled', () => {
  assert.equal(unreachableOriginDetail([
    row('home', { errors: [{ kind: 'console', message: 'TypeError: x is not a function' }] }),
    row('board', { errors: [{ kind: 'console', message: 'TypeError: x is not a function' }] }),
  ], ORIGIN), null);

  // A failure with no console error at all (an expectSelector that did not
  // match) is a real assertion failure.
  assert.equal(unreachableOriginDetail([row('home')], ORIGIN), null);

  // A resolve error reported as a plain console message rather than a page
  // load failure is not evidence the origin is down.
  assert.equal(unreachableOriginDetail(
    [row('home', { errors: [{ kind: 'console', message: 'net::ERR_NAME_NOT_RESOLVED' }] })], ORIGIN
  ), null);
});

test('no rows at all is not an unreachable origin — that verdict is already error', () => {
  assert.equal(unreachableOriginDetail([], ORIGIN), null);
  assert.equal(unreachableOriginDetail(null, ORIGIN), null);
});

// ── The two consumers of the verdict ───────────────────────────────────

function visualsSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
}

test('the override runs against container rows only, before the result is stored', () => {
  const src = visualsSource();
  const override = src.indexOf('unreachableOriginDetail(containerRows');
  assert.ok(override > 0, 'the capture run must apply the override');
  // Synthesized rows (the over-ceiling guard, the unit suite) never load a
  // page, so counting them would veto the override for free.
  assert.match(src.slice(override - 400, override),
    /checksResult\.results\.filter\(\(r\) => !extraRows\.includes\(r\)\)/);
  assert.ok(override < src.indexOf('const stored = await storeChecks('),
    'storeChecks is what persists the backoff and check_error_detail — override first');
});

test('an error verdict records no check history', () => {
  // Recording it would stamp fail_count on checks that never ran, which is
  // how WorkQuest reached pass_count 0 / fail_count 2 on seven rows.
  const src = visualsSource();
  const gate = src.match(/if \(\(dispatched \|\| unitOutcome\)([^)]*)\) \{\n\s+const historyRows/);
  assert.ok(gate, 'the recordRun block must still be guarded here');
  assert.match(gate[1], /checksResult\.state !== 'error'/);
});
