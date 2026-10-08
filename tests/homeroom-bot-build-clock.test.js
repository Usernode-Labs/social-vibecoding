// The Homeroom bot's build is told its clock, and how to try a drag (7 Oct
// 2026). A first version spent 28 minutes of its 40 on 226 model requests
// and 94 browser calls, most of them getting a simulated drag to move
// anything. The build could not see the time, and nothing said what to cut.
//
// These pin the build prompt's TIME section (when the turn started, when it
// is stopped and thrown away, the soft budget at 30 minutes on a clock longer
// than that, and the order the time is spent in, which never cuts building
// what the plan asks for), and the drag lines every bot build and revision
// reads.
//
// Run with: node --test tests/homeroom-bot-build-clock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = require('../src/services/homeroom-bot-live');

const STARTED = Date.parse('2026-10-07T19:41:00Z');
const MIN = 60 * 1000;
const flat = (lines) => lines.join('\n');

test('the soft budget is 30 minutes', () => {
  assert.equal(live.BUILD_SOFT_BUDGET_MS, 30 * MIN);
});

test('a first version\'s 40-minute build is told when it started, when it is stopped, and when to wrap up', () => {
  const t = flat(live.clockLines({ startedAt: STARTED, budgetMs: 40 * MIN }));
  assert.match(t, /^\nTIME\. This build started at 19:41 UTC\. The platform stops it at 20:21 UTC \(40 minutes\), and a build it stops is thrown away: nothing is proposed\./);
  assert.match(t, /Aim to be finished by 20:11 UTC \(30 minutes\)\./);
  assert.match(t, /Read the time with `date -u \+%H:%M` whenever you are about to start another round of testing or polish\./);
  assert.match(t, /1\. Build everything the spec and the plan ask for\. This is never what gets cut\./);
  assert.match(t, /2\. Boot the app and do its main thing once, as a person would\./);
  assert.match(t, /3\. Fix what that shows is broken\./);
  assert.match(t, /4\. Only then, while it is before 20:11 UTC: the other screens, sizes and looks, the empty and error states, and polish\./);
  assert.match(t, /After 20:11 UTC, start no new round of testing or polish\. Finish building what the spec asks for if you still are, finish the fix you are in, check the app still boots, and finish your turn\. Say in your summary what you did not get to check\./);
  assert.doesNotMatch(t, /—/);
});

test('a build whose clock is not longer than the soft budget has no soft mark, only its stop', () => {
  for (const budget of [20 * MIN, 30 * MIN]) {
    const t = flat(live.clockLines({ startedAt: STARTED, budgetMs: budget }));
    assert.doesNotMatch(t, /Aim to be finished by/);
    assert.match(t, /4\. Only then, with time to spare:/);
    assert.match(t, /Leave time before \d\d:\d\d UTC to check the app still boots and to finish your turn\./);
  }
  assert.match(flat(live.clockLines({ startedAt: STARTED, budgetMs: 20 * MIN })), /stops it at 20:01 UTC \(20 minutes\)/);
});

test('no clock, no TIME section, and the prompt reads as it did', () => {
  assert.deepEqual(live.clockLines({}), []);
  assert.deepEqual(live.clockLines({ startedAt: STARTED }), []);
  const p = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan' });
  assert.doesNotMatch(p, /^TIME\./m);
  assert.match(p, /say why in your summary\. Stay within the time budget above\./);
});

test('with a clock, the TIME section comes before the browser block, which defers to it', () => {
  const p = live.buildPrompt({
    seed: 'ISSUE', buildNote: 'plan', readsImages: true, clock: { startedAt: STARTED, budgetMs: 40 * MIN },
  });
  assert.ok(p.indexOf('Do not commit or push yourself') < p.indexOf('\nTIME. This build started'), 'after the build contract');
  assert.ok(p.indexOf('\nTIME. This build started') < p.indexOf('The in-loop browser, as'), 'before the browser block');
  assert.match(p, /say why in your summary\. Do it in the order, and by the time, the TIME section above sets\./);
  assert.doesNotMatch(p, /Stay within the time budget above\./);
});

test('the live build hands its prompt the clock its turn is stopped on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'homeroom-bot-live.js'), 'utf8');
  assert.match(src, /clock: \{ startedAt: Date\.now\(\), budgetMs: turnBudgetMs \},/);
  assert.match(src, /prompt, budgetMs: turnBudgetMs, commitMsg:/, 'the same budget the turn\'s timer uses');
});

test('a drag is tried with the tools the build has, twice at most, and a failed gesture is said', () => {
  const t = flat(live.DRAG_TEST_LINES);
  assert.match(t, /is tried with `browser_drag`, from the thing to\n  where it goes\./);
  assert.match(t, /dispatching `pointerdown`, `pointermove` and `pointerup` on those elements with `browser_evaluate`/);
  assert.match(t, /the simulated gesture is what failed, not necessarily the app/);
  assert.match(t, /make sure the same move can also be made without dragging \(a button or a menu\)/);
  assert.match(t, /say in\n  your summary that the drag was not tried in the browser\. Two tries at simulating a gesture is the limit\./);
  assert.doesNotMatch(t, /mouse_drag_xy|mouse_move_xy/, 'the coordinate tools are not enabled in the build worker');
  assert.doesNotMatch(t, /—/);
  // Never one of the App bench's starter briefs (homeroom-bot-build-design.test.js).
  assert.doesNotMatch(t, /tier list|ranking|\bmusic|keyboard|bread/i);
  for (const p of [
    live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan' }),
    live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', clock: { startedAt: STARTED, budgetMs: 40 * MIN } }),
    live.revisionDesignText({ readsImages: true }),
  ]) {
    assert.ok(p.includes(t), 'every bot build and revision reads it');
  }
});
