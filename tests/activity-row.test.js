'use strict';
// #3648: every points activity says when it happened. The profile overlay's
// and the standings drill-down's activity lists showed only the reason and
// the points; both now draw ./activity-row.tsx, which adds the day and time
// from the `activity_at` both APIs already return.
//
// The expectations are built with the same Intl options in the test's own
// timezone, so the suite holds wherever it runs; the date-only case is read
// in UTC by design and is asserted literally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROW = 'frontend/src/features/leaderboard/activity-row.tsx';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const mod = loadTsx(ROW);
const NOW = new Date('2026-10-08T09:00:00Z');

test('a timed activity shows weekday, date and time, in local time', () => {
  const iso = '2026-10-02T16:32:00.000Z';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
  const when = mod.activityWhen(iso, { now: NOW });
  assert.ok(when);
  assert.equal(when.text, `${day} · ${time}`);
  assert.doesNotMatch(when.text, /2026/, 'the current year is dropped');
  assert.match(when.title, /2026/, 'the title keeps it');
  assert.ok(when.title.endsWith(time), 'and the time');
  assert.equal(when.iso, iso);
});

test('an earlier year keeps its year', () => {
  const when = mod.activityWhen('2025-10-02T16:32:00.000Z', { now: NOW });
  assert.match(when.text, /2025/);
});

test('a date-only credit (pinned to noon UTC by the scorer) shows no time', () => {
  const d = new Date('2026-10-02T12:00:00.000Z');
  const day = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const noon = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
  const when = mod.activityWhen('2026-10-02T12:00:00.000Z', { now: NOW });
  assert.equal(when.text, day, 'the calendar day alone, read in UTC');
  assert.ok(!when.title.includes(noon), 'and no invented time in the title either');
  // One millisecond off noon is a real time.
  assert.match(mod.activityWhen('2026-10-02T12:00:00.001Z', { now: NOW }).text, / · /);
});

test('a missing or bad timestamp draws no date line', () => {
  for (const v of [null, undefined, '', 'not a date']) {
    assert.equal(mod.activityWhen(v), null);
  }
  const html = renderToHtml(createElement(mod.ActivityRow, { text: 'Tried Chess', points: '+10', at: null }));
  assert.doesNotMatch(html, /<time/);
  assert.match(html, /Tried Chess/);
  assert.match(html, /\+10/);
});

test('the row renders the reason, the date and the points', () => {
  const html = renderToHtml(createElement(mod.ActivityRow, {
    text: 'Sent feedback on RecipeBot', points: '+250', at: '2026-10-02T16:32:00.000Z',
  }));
  assert.match(html, /Sent feedback on RecipeBot/);
  assert.match(html, /<time[^>]*dateTime="2026-10-02T16:32:00.000Z"|<time[^>]*datetime="2026-10-02T16:32:00.000Z"/);
  assert.match(html, /data-activity-when/);
  assert.match(html, /\+250/);
});

test('both activity lists draw the shared row and pass activity_at through', () => {
  for (const f of ['challenges-pane.tsx', 'topochain-standings.tsx']) {
    const src = read(`frontend/src/features/leaderboard/${f}`);
    assert.match(src, /import \{ ActivityRow \} from '\.\/activity-row';/, `${f} imports the row`);
    assert.match(src, /<ActivityRow [^>]*at=\{a\.at\}/, `${f} hands it the timestamp`);
  }
  for (const f of ['topochain-challenges.js', 'topochain-leaderboard.js']) {
    const src = read(`frontend/src/features/leaderboard/${f}`);
    assert.match(src, /at: a\.activity_at \|\| null,/, `${f} passes activity_at through`);
  }
});

test('the profile view carries each activity timestamp', () => {
  const src = read('frontend/src/features/leaderboard/topochain-challenges.js');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'topochain-challenges.js' });
  const TC = sandbox.window.TopochainChallenges;
  TC._profileUserId = 7;
  TC._profileLoading = false;
  TC._profileError = null;
  TC._profile = {
    display_name: 'Marlee', total_points: 6278, extra_points: 6278,
    activities: [
      { description: 'Sent feedback on RecipeBot', points: 250, activity_at: '2026-10-02T16:32:00.000Z' },
      { description: 'Tried Chess', points: 10 },
    ],
  };
  const view = TC.profileView();
  assert.equal(view.activities[0].at, '2026-10-02T16:32:00.000Z');
  assert.equal(view.activities[0].points, '+250');
  assert.equal(view.activities[1].at, null);
});
