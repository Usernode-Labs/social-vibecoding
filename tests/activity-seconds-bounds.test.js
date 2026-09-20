'use strict';

// #2524: POST /api/apps/:slug/activity accepted an unbounded `seconds`.
//
// Two things were wrong, and the ranking query is why they matter: the home
// screen orders apps by `SUM(seconds_spent)` over the last 7 days
// (routes/apps.js), so whatever lands in that column is whatever decides
// which apps the directory shows first.
//
//   1. NO CEILING. The guard was `if (!seconds || seconds < 0)`, so any
//      positive number passed. `seconds_spent` is INTEGER, so a couple of
//      posts near 2^31 also overflow the column and turn the next write
//      into a 500.
//   2. NO TYPE CHECK. `"abc"` is truthy and `"abc" < 0` is false, so it
//      reached `Math.round("abc")` → NaN → an integer column rejecting NaN,
//      i.e. a 500 where a 400 was the honest answer. `Infinity` took the
//      same path.
//
// The real defence is the DAILY CAP, not the per-request one: a per-request
// ceiling alone is defeated by posting repeatedly, whereas a day genuinely
// cannot contain more than 86400 seconds. The SQL clamps the accumulated
// total with LEAST(...), so the column is bounded however many requests
// arrive, and overflow stops being reachable at all.
//
// The client (AppView.startActivityTracking) counts one second at a time and
// flushes at 30, so a legitimate body is 1..30. The per-request ceiling is
// deliberately far above that rather than tight to it — a batching caller is
// not an attacker, and the daily cap is what actually holds the line.
//
// Run with: node --test tests/activity-seconds-bounds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { activitySeconds, ACTIVITY_MAX_PER_POST, ACTIVITY_MAX_PER_DAY } = require('../src/routes/apps');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/routes/apps.js'), 'utf8');

test('a legitimate heartbeat passes through untouched', () => {
  assert.equal(activitySeconds(1), 1);
  assert.equal(activitySeconds(30), 30);
  assert.equal(activitySeconds(29.6), 30, 'rounded, as it always was');
});

test('anything that is not a finite number is rejected, not coerced', () => {
  for (const bad of ['abc', '30', {}, [], true, null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(activitySeconds(bad), null, `${String(bad)} should be refused`);
  }
});

test('zero and negatives are still refused', () => {
  assert.equal(activitySeconds(0), null);
  assert.equal(activitySeconds(-1), null);
  assert.equal(activitySeconds(-0.4), null, 'rounds to 0, which is not activity');
});

test('a huge value is clamped rather than stored', () => {
  assert.equal(activitySeconds(2_000_000_000), ACTIVITY_MAX_PER_POST);
  assert.equal(activitySeconds(ACTIVITY_MAX_PER_POST + 1), ACTIVITY_MAX_PER_POST);
  assert.ok(ACTIVITY_MAX_PER_POST >= 30, 'a real flush must never be clamped');
  assert.ok(ACTIVITY_MAX_PER_POST < 2 ** 31 - 1, 'and must not approach the column limit');
});

test('the stored daily total is capped in SQL, so repeats cannot accumulate past a day', () => {
  assert.equal(ACTIVITY_MAX_PER_DAY, 86400, 'a day is 86400 seconds');
  const insert = SRC.slice(SRC.indexOf('INSERT INTO app_activity'));
  const stmt = insert.slice(0, insert.indexOf('`'));
  assert.match(stmt, /LEAST\(/, 'the accumulated total is clamped');
  assert.match(stmt, /app_activity\.seconds_spent \+ EXCLUDED\.seconds_spent/,
    'and it is still an accumulation, not a replacement');
});

test('the route refuses a bad body before it reaches the database', () => {
  const route = SRC.slice(SRC.indexOf("router.post('/api/apps/:slug/activity'"));
  const body = route.slice(0, route.indexOf('INSERT INTO app_activity'));
  assert.match(body, /activitySeconds\(/, 'the route uses the shared guard');
  assert.match(body, /Invalid seconds value/, 'and still answers 400 with the same message');
});
