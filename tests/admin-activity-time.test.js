'use strict';
// Request 6713: an activity saved with a calendar date and no time of day is
// stored at noon UTC and marked 'day'. Members see the date alone; the admin
// console printed a clock time for it (noon UTC in the admin's own zone).
// The admin reads now carry the same `activity_time_precision` the member
// reads do, and every admin screen that draws an activity's time honours it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { fmtActivityAt } = loadTsx('frontend/src/features/admin/activity-at.ts');
const { formatActivityRow } = require('../src/routes/topochain/admin/user-activities');

const instant = (v) => `instant:${v}`;

test('a day-only activity shows its calendar date, read in UTC, and no time', () => {
  // Noon UTC is the next day in Auckland and the same day in Los Angeles:
  // the date shown is the one that was saved, wherever the admin sits.
  assert.equal(fmtActivityAt('2026-10-20T12:00:00.000Z', 'day', instant, 'en-GB'), '20 Oct 2026');
  // A row marked by the backfill still sits at midnight UTC.
  assert.equal(fmtActivityAt('2026-10-20T00:00:00.000Z', 'day', instant, 'en-GB'), '20 Oct 2026');
});

test('a timed activity, or one with no precision, keeps the screen\'s own date and time', () => {
  assert.equal(fmtActivityAt('2026-10-20T12:00:00.000Z', 'instant', instant), 'instant:2026-10-20T12:00:00.000Z');
  assert.equal(fmtActivityAt('2026-10-20T12:00:00.000Z', null, instant), 'instant:2026-10-20T12:00:00.000Z');
  assert.equal(fmtActivityAt('2026-10-20T12:00:00.000Z', undefined, instant), 'instant:2026-10-20T12:00:00.000Z');
});

test('an absent or unreadable day-only value falls back to the screen\'s formatter', () => {
  assert.equal(fmtActivityAt(null, 'day', instant), 'instant:null');
  assert.equal(fmtActivityAt('nonsense', 'day', instant), 'instant:nonsense');
});

test('the admin activity row carries the precision the member reads carry', () => {
  const base = { id: 1, user_id: 2, season_event_id: 3, points: '5', activity_at: new Date('2026-10-20T12:00:00Z') };
  assert.equal(formatActivityRow({ ...base, metadata: { timestamp_precision: 'day' } }).activity_time_precision, 'day');
  assert.equal(formatActivityRow({ ...base, metadata: { timestamp_precision: 'instant' } }).activity_time_precision, 'instant');
  assert.equal(formatActivityRow({ ...base, metadata: { measure: 'TRY_APPS' } }).activity_time_precision, 'day');
  assert.equal(formatActivityRow({ ...base, metadata: null }).activity_time_precision, 'instant');
});

test('the support timeline reads a points row\'s precision and no other kind\'s', () => {
  const routes = read('src/routes/admin-support.js');
  assert.match(routes, /ua\.metadata AS meta/);
  assert.match(routes, /AS t\(at, kind, type, points, title, detail, app_name, app_slug, meta\)/);
  assert.match(routes, /precision: r\.kind === 'points' \? activityTimePrecision\(\{ metadata: r\.meta \}\) : null/);
  // Every arm of the union has the ninth column.
  const arms = routes.slice(routes.indexOf('function timelineArms'), routes.indexOf('function formatAction'));
  assert.equal((arms.match(/arms\.push\(/g) || []).length, (arms.match(/ua\.metadata AS meta|NULL::jsonb/g) || []).length);
});

test('every admin screen that draws an activity\'s time passes its precision', () => {
  const support = read('frontend/src/features/admin/admin-support.tsx');
  assert.match(support, /fmtActivityAt\(a\.activity_at, a\.activity_time_precision, fmtDateTime, 'en-GB'\)/);
  assert.match(support, /fmtActivityAt\(it\.at, it\.precision, fmtDateTime, 'en-GB'\)/);
  assert.doesNotMatch(support, /fmtDateTime\(a\.activity_at\)/);
  const list = read('frontend/src/features/admin/topochain/user-activities.tsx');
  assert.match(list, /fmtActivityAt\(a\.activity_at, a\.activity_time_precision, fmt\)/);
  assert.doesNotMatch(list, /cell: \(a\) => fmt\(a\.activity_at\)/);
});
