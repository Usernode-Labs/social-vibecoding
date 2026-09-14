// #1788 — the weekly cap's boundary arithmetic.
//
// The weekly allowance is only as trustworthy as its edges. Every sentence
// the product says about it promises "Monday 00:00 UTC", and the SQL window
// that decides whether a turn is refused is `date >= weekStartUtc(now)` —
// so the reset instant and the query window have to be the same boundary,
// derived from the same helper, at every awkward moment: the minute before
// a rollover, the minute after one, and across a year end.
//
// It is a pure-function test on purpose. The cap's enforcement is covered
// by tests/limits-resolve-billing-path.test.js; what is easy to get wrong
// and impossible to see in a diff is the date maths.
//
// Run with: node --test tests/limits-week-boundary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');

// weeklyResetAt() is defined as "start of this week, plus exactly seven
// days", so it can only ever land on a Monday at 00:00:00.000 UTC.
function assertMondayMidnight(iso) {
  const d = new Date(iso);
  assert.equal(d.getUTCDay(), 1, `${iso} is a Monday`);
  assert.equal(d.getUTCHours(), 0);
  assert.equal(d.getUTCMinutes(), 0);
  assert.equal(d.getUTCSeconds(), 0);
  assert.equal(d.getUTCMilliseconds(), 0);
}

test('Sunday 23:59 UTC: the week is about to end, one minute out', () => {
  const now = new Date('2026-09-06T23:59:00.000Z'); // a Sunday
  assert.equal(limits.weekStartUtc(now), '2026-08-31', 'still last Monday’s week');
  const reset = limits.weeklyResetAt(now);
  assert.equal(reset, '2026-09-07T00:00:00.000Z');
  assertMondayMidnight(reset);
  assert.equal(new Date(reset) - now, 60 * 1000, 'exactly one minute away');
});

test('Monday 00:01 UTC: the new week has started, a full seven days out', () => {
  const now = new Date('2026-09-07T00:01:00.000Z'); // the Monday after
  assert.equal(limits.weekStartUtc(now), '2026-09-07', 'this Monday, not the last');
  const reset = limits.weeklyResetAt(now);
  assert.equal(reset, '2026-09-14T00:00:00.000Z');
  assertMondayMidnight(reset);
  // The two instants either side of the rollover resolve to DIFFERENT
  // windows, which is the whole point: a user refused at 23:59 Sunday can
  // spend again two minutes later.
  assert.notEqual(reset, limits.weeklyResetAt(new Date('2026-09-06T23:59:00.000Z')));
});

test('the boundary survives a year end', () => {
  // Thursday 31 December 2026 belongs to the week that began Monday the
  // 28th, so its reset is in the NEXT year.
  const now = new Date('2026-12-31T12:00:00.000Z');
  assert.equal(limits.weekStartUtc(now), '2026-12-28');
  const reset = limits.weeklyResetAt(now);
  assert.equal(reset, '2027-01-04T00:00:00.000Z');
  assertMondayMidnight(reset);

  // And the first days of January belong to the week that started in
  // December — an off-by-one here would silently give everyone a second
  // allowance for the same week.
  assert.equal(limits.weekStartUtc(new Date('2027-01-01T00:00:00.000Z')), '2026-12-28');
  assert.equal(limits.weeklyResetAt(new Date('2027-01-03T23:59:59.999Z')),
    '2027-01-04T00:00:00.000Z');
});

test('every day of a week resolves to the same window', () => {
  const start = '2026-09-07'; // Monday
  const expected = '2026-09-14T00:00:00.000Z';
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(`${start}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + i);
    // Mid-afternoon on each day, so a naive local-time helper would drift.
    d.setUTCHours(15, 30, 0, 0);
    assert.equal(limits.weekStartUtc(d), start, `${d.toISOString()} → ${start}`);
    assert.equal(limits.weeklyResetAt(d), expected, `${d.toISOString()} → ${expected}`);
  }
});

test('the reset label and the reset instant name the same boundary', () => {
  assert.equal(limits.WEEKLY_RESET_LABEL, 'Monday 00:00 UTC');
  assert.equal(limits.DAILY_RESET_LABEL, 'midnight UTC');
  assertMondayMidnight(limits.weeklyResetAt());
  // The daily one still rolls at the next UTC midnight, unchanged.
  const daily = new Date(limits.dailyResetAt());
  assert.equal(daily.getUTCHours(), 0);
  assert.equal(daily.getUTCMinutes(), 0);
});

test('the SQL window is inclusive of the Monday itself', () => {
  // getWeeklySpentCents filters `date >= weekStartUtc(now)`, and the
  // ledger is keyed on a DATE. So the Monday's own row must be inside the
  // window it starts — assert the boundary value is the Monday, not the
  // Tuesday.
  const monday = new Date('2026-09-07T00:00:00.000Z');
  assert.equal(limits.weekStartUtc(monday), '2026-09-07');
});

test('spend on the Monday counts toward the week it starts', async () => {
  // The one query-shaped assertion here: the parameter handed to Postgres
  // is that same Monday, so a row dated the Monday is included.
  let captured = null;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ total: '1234.5' }] };
    },
  };
  const spent = await limits.getWeeklySpentCents(pool, 7, {
    now: new Date('2026-09-10T09:00:00.000Z'), // the Thursday
  });
  assert.equal(spent, 1234.5, 'fractional cents survive the read');
  assert.match(captured.sql, /date >= \$2/);
  assert.deepEqual(captured.params, [7, '2026-09-07']);
});
