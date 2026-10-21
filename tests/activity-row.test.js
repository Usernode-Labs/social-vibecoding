'use strict';
// #3648: every points activity says when it happened. The standings
// drill-down's activity list showed only the reason and the points; it draws
// ./activity-row.tsx, which adds the day and time from the `activity_at` the
// API already returns. (The Challenges tab's profile overlay drew it too,
// until the overlay retired with the Semi design, 2026-10-16.)
//
// The expectations are built with the same Intl options in the test's own
// timezone, so the suite holds wherever it runs; the date-only case is read
// in UTC by design and is asserted literally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROW = 'frontend/src/features/leaderboard/activity-row.tsx';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const mod = loadTsx(ROW);
const NOW = new Date('2026-10-08T09:00:00Z');

test('a timed activity shows weekday, date and time, in local time', () => {
  const iso = '2026-10-02T16:32:00.000Z';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
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

test('explicit occurrence precision shows genuine noon and midnight times in the viewer timezone', () => {
  for (const iso of ['2026-10-02T12:00:00.000Z', '2026-10-02T00:00:00.000Z']) {
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    const when = mod.activityWhen(iso, { now: NOW, precision: 'instant' });
    assert.ok(when.text.endsWith(` · ${time}`));
    const html = renderToHtml(createElement(mod.ActivityRow, {
      text: 'Tried Chess', points: '+10', at: iso, precision: 'instant',
    }));
    assert.match(html, / · /);
  }
});

test('explicit old day precision is honored without guessing from the timestamp hour', () => {
  const when = mod.activityWhen('2026-10-02T00:00:00.000Z', { now: NOW, precision: 'day' });
  assert.doesNotMatch(when.text, / · /);
});

test('a date-only credit (pinned to noon UTC by the scorer) shows no time', () => {
  const d = new Date('2026-10-02T12:00:00.000Z');
  const day = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const noon = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
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

// #3200: a graded activity also says why it earned its points — the grader's
// own short reason, under the label and above the date, in the same small
// muted text as the date so it reads as part of the entry.
test('a graded activity shows the grader\'s reason between the label and the date (#3200)', () => {
  const reason = 'Says what broke, where, and what was expected.';
  const html = renderToHtml(createElement(mod.ActivityRow, {
    text: 'Reported a reproducible bug.', points: '+250', at: '2026-10-02T16:32:00.000Z', reason,
  }));
  const line = message('leaderboard:activity.gradeReason', { reason });
  assert.equal(line, 'Why: Says what broke, where, and what was expected.');
  assert.ok(html.includes(`>${line}</span>`), 'the catalog text is drawn');
  const reasonAt = html.indexOf('data-activity-reason');
  const labelAt = html.indexOf('Reported a reproducible bug.');
  const timeAt = html.indexOf('<time');
  assert.ok(reasonAt > -1, 'the line carries the data-activity-reason hook');
  assert.ok(labelAt < reasonAt && reasonAt < timeAt, 'and sits between the label and the date');
});

test('no reason, or a blank one, draws nothing and the markup is what it always was', () => {
  for (const reason of [undefined, null, '', '   ']) {
    const html = renderToHtml(createElement(mod.ActivityRow, {
      text: 'Sent a testnet transaction.', points: '+100', at: '2026-10-02T10:00:00.000Z', reason,
    }));
    assert.ok(!html.includes('data-activity-reason'), `no reason line for ${JSON.stringify(reason)}`);
    assert.match(html, /<time/, 'the date line is unaffected');
  }
});

test('the standings drill-down draws the shared row and passes activity_at through', () => {
  const src = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(src, /import \{ ActivityRow \} from '\.\/activity-row';/, 'the drill-down imports the row');
  assert.match(src, /<ActivityRow [^>]*at=\{a\.at\}/, 'and hands it the timestamp');
  assert.match(read('frontend/src/features/leaderboard/topochain-leaderboard.js'), /at: a\.activity_at \|\| null,/,
    'its view module passes activity_at through');
  // The Challenges tab's profile overlay, the other list, retired with the
  // participants it was opened from.
  assert.doesNotMatch(read('frontend/src/features/leaderboard/challenges-pane.tsx'), /ActivityRow/);
  assert.doesNotMatch(read('frontend/src/features/leaderboard/topochain-challenges.js'), /profileView|activity_at/);
});
