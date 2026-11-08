'use strict';

// #6463: the "Use apps for N minutes" challenge's timer over the running app.
//
// WHAT THIS PINS. The pill shows only while it applies (an open, unfinished
// minutes challenge, an app whose time counts, not already at the target when
// the app opened, not hidden by its ×); it counts the server's minutes plus
// the collector's unacknowledged time and never goes backwards within one
// open (so the moment between an acknowledgement and the re-read cannot dip
// it); and it has three states: counting, Paused, and done, which links to
// the challenge's page. The container is mounted in the app frame host, and
// its first render is nothing.
//
// Run with: node --test tests/app-frame-minutes-timer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const TIMER_PATH = 'frontend/src/features/app-frame/minutes-timer.tsx';
const Timer = loadTsx(TIMER_PATH);
const root = path.join(__dirname, '..');
const frameSrc = fs.readFileSync(path.join(root, 'frontend/src/features/app-frame/app-frame.tsx'), 'utf8');

const CHALLENGE = { challengeId: 7, eventId: 3, seconds: 180, targetSeconds: 600, weekly: false, counts: true };
const base = { challenge: CHALLENGE, eligible: true, hidden: false, pendingMs: 0, engaged: true, shownMs: 0 };

test('the clock reads minutes and seconds', () => {
  assert.equal(Timer.clock(0), '0:00');
  assert.equal(Timer.clock(185_400), '3:05');
  assert.equal(Timer.clock(600_000), '10:00');
});

test('counting: the server\'s minutes plus the time it does not hold yet', () => {
  const { view, shownMs } = Timer.timerView({ ...base, pendingMs: 20_000 });
  assert.deepEqual({ ...view }, { kind: 'counting', elapsed: '3:20', target: '10:00', pct: 33 });
  assert.equal(shownMs, 200_000);
});

test('paused when the collector is not crediting time', () => {
  assert.equal(Timer.timerView({ ...base, engaged: false }).view.kind, 'paused');
});

test('it never goes backwards within one open', () => {
  // The acknowledgement took the pending time away; the re-read has not
  // brought the server's count back yet.
  const { view } = Timer.timerView({ ...base, pendingMs: 0, shownMs: 200_000 });
  assert.equal(view.elapsed, '3:20');
});

test('done at the target, linking to the challenge\'s page', () => {
  const { view } = Timer.timerView({ ...base, pendingMs: 420_000 });
  assert.deepEqual({ ...view }, { kind: 'done', minutes: 10, href: '#leaderboard/challenges/3/7' });
});

test('nothing when it does not apply', () => {
  const none = (over) => Timer.timerView({ ...base, ...over }).view.kind;
  assert.equal(none({ challenge: null }), 'none', 'no open minutes challenge');
  assert.equal(none({ challenge: { ...CHALLENGE, counts: false } }), 'none', 'an app the viewer made');
  assert.equal(none({ eligible: false }), 'none', 'already at the target when the app opened');
  assert.equal(none({ hidden: true }), 'none', 'hidden by its ×');
});

test('the pill: ring and time, Paused beside it, the done link, and its ×', () => {
  const pill = (view) => renderToHtml(createElement(Timer.MinutesTimerPill, { view, onClose() {} }));
  const counting = pill({ kind: 'counting', elapsed: '3:00', target: '10:00', pct: 30 });
  assert.match(counting, /data-minutes-timer="counting"/);
  assert.match(counting, /role="img"/, 'the progress ring');
  assert.match(counting, />3:00 of 10:00</);
  assert.doesNotMatch(counting, new RegExp(message('agent:appFrame.minutes.paused')));
  assert.match(counting, new RegExp(`aria-label="${message('agent:appFrame.minutes.close')}"`));
  const paused = pill({ kind: 'paused', elapsed: '3:00', target: '10:00', pct: 30 });
  assert.match(paused, /data-minutes-timer="paused"/);
  assert.match(paused, />Paused</);
  const done = pill({ kind: 'done', minutes: 10, href: '#leaderboard/challenges/3/7' });
  assert.match(done, /<a href="#leaderboard\/challenges\/3\/7"/);
  assert.match(done, />10 minutes</);
  assert.equal(pill({ kind: 'none' }), '');
});

test('the container renders nothing at first, and is mounted over the app on screen', () => {
  assert.equal(renderToHtml(createElement(Timer.MinutesTimer, { slug: 'daily-puzzle' })), '',
    'the prerendered document carries no pill: data loads in effects');
  assert.match(frameSrc, /<MinutesTimer slug=\{state\.active && state\.slug \? state\.slug : null\} \/>/);
  const src = fs.readFileSync(path.join(root, TIMER_PATH), 'utf8');
  assert.match(src, /\/api\/v4\/me\/minutes-challenge\?app=\$\{encodeURIComponent\(slug\)\}/);
  assert.match(src, /addEventListener\('sv:app-activity-recorded', onRecorded\)/, 're-read on every acknowledgement');
  assert.match(src, /appActivity\.onEngagement\(slug,/);
});
