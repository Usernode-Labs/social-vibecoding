'use strict';

// `parseActivityAt` is the one place an inbound activity time is read, so a
// bare calendar date ("2026-10-20") becomes noon UTC marked 'day' instead of
// a midnight that the activity list printed as "12:00 AM". Everything else
// keeps its exact instant, marked 'instant'.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseActivityAt } = require('../src/services/topochain/activity-time');

test('a bare calendar date is pinned to noon UTC and marked day-only', () => {
  const parsed = parseActivityAt('2026-10-20');
  assert.equal(parsed.at.toISOString(), '2026-10-20T12:00:00.000Z');
  assert.equal(parsed.precision, 'day');
});

test('a full ISO timestamp keeps its exact instant and stays an instant', () => {
  const parsed = parseActivityAt('2026-10-20T15:42:13.000Z');
  assert.equal(parsed.at.toISOString(), '2026-10-20T15:42:13.000Z');
  assert.equal(parsed.precision, 'instant');
});

test('a midnight ISO timestamp is an instant, not a date', () => {
  const parsed = parseActivityAt('2026-10-20T00:00:00.000Z');
  assert.equal(parsed.at.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(parsed.precision, 'instant');
});

test('a timestamp with an offset and a numeric epoch stay instants', () => {
  const offset = parseActivityAt('2026-10-20T15:42:00+02:00');
  assert.equal(offset.at.toISOString(), '2026-10-20T13:42:00.000Z');
  assert.equal(offset.precision, 'instant');
  const epoch = parseActivityAt(1792501320000);
  assert.equal(epoch.at.getTime(), 1792501320000);
  assert.equal(epoch.precision, 'instant');
});

test('a timezone-less timestamp is not a bare date', () => {
  const parsed = parseActivityAt('2026-10-20T00:00');
  assert.equal(parsed.precision, 'instant');
});

test('an impossible date is rejected rather than rolled forward', () => {
  assert.equal(parseActivityAt('2026-02-30'), null);
});

test('absent, blank and unparsable values return null', () => {
  assert.equal(parseActivityAt(undefined), null);
  assert.equal(parseActivityAt(null), null);
  assert.equal(parseActivityAt(''), null);
  assert.equal(parseActivityAt('nope'), null);
});
