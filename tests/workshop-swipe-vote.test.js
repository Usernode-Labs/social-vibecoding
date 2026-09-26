'use strict';

// #3052: on a phone, a Needs-you proposal card can be swiped right to vote
// Yes and left to vote No, with a faded-in note saying which.
//
// What is pinned here, and why each would fail silently if it drifted:
//
//   * The gesture is a pure module (swipe-vote.ts): the axis lock, the
//     commit distance, the release decision and the per-frame visual. A
//     vertical drag is the feed's own scroll and must never become a vote,
//     so it is released to the browser before anything moves.
//   * The tracker ignores everything that is not one touch: a mouse, a pen,
//     a second finger (which cancels the gesture outright) and a
//     pointercancel all end without a vote.
//   * Only a card this viewer can vote on is swipeable, by the same rule the
//     sheet's buttons follow, and a side with no action cannot commit.
//   * A swipe does not have a vote path of its own. It calls the feed's
//     `answer`, which calls castVote, so a left swipe asks "What's not
//     working for you?" and sends NOTHING until a line is given. That is
//     checked against castVote's real source, not a copy.
//   * prefers-reduced-motion: the card does not travel or tilt; the note
//     alone says what the release will do.
//
// Run with: node --test tests/workshop-swipe-vote.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SWIPE_PATH = 'frontend/src/features/dev-board/workshop/swipe-vote.ts';
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');
const APP_VIEW_SRC = read('public/js/app-view.js');

const S = loadTsx(SWIPE_PATH);

const BOTH = { yes: true, no: true };
const WIDTH = 390;

/** A tracker wired to recorders, the way the feed item wires it. */
function track({ allowed = BOTH, reduced = false, width = WIDTH } = {}) {
  const frames = [];
  const commits = [];
  const t = S.createSwipeTracker({
    allowed: () => allowed,
    width: () => width,
    reducedMotion: () => reduced,
    onFrame: (v) => frames.push(v),
    onCommit: (side) => commits.push(side),
  });
  return { t, frames, commits };
}
const touch = (x, y, over) => ({ pointerId: 1, pointerType: 'touch', isPrimary: true, x, y, ...(over || {}) });

/* ── The pure decisions ─────────────────────────────────────────────── */

test('the axis lock waits for the slop, then only a clearly horizontal drag is a swipe', () => {
  assert.equal(S.lockAxis(3, 4), 'pending', 'a finger settling is not a direction yet');
  assert.equal(S.lockAxis(0, 30), 'y', 'straight down is the feed scrolling');
  assert.equal(S.lockAxis(-4, -40), 'y');
  assert.equal(S.lockAxis(30, 0), 'x');
  assert.equal(S.lockAxis(-30, 4), 'x');
  // A diagonal is ambiguous, and an ambiguous drag belongs to the scroll:
  // a mis-read scroll is a vote nobody meant.
  assert.equal(S.lockAxis(20, 20), 'y', '45 degrees is not a swipe');
  assert.equal(S.lockAxis(24, 18), 'y', 'nor is a drag only a little more sideways than down');
});

test('the commit distance scales with the card and never drops below a floor', () => {
  assert.equal(S.commitDistance(WIDTH), Math.round(WIDTH * S.SWIPE_COMMIT_FRACTION));
  assert.equal(S.commitDistance(100), S.SWIPE_MIN_COMMIT, 'a narrow card still needs a deliberate drag');
  assert.equal(S.commitDistance(0), S.SWIPE_MIN_COMMIT);
});

test('release: past the distance commits that side; short of it, nothing', () => {
  const d = S.commitDistance(WIDTH);
  assert.equal(S.releaseDecision(d, WIDTH, BOTH), 'yes', 'right is yes');
  assert.equal(S.releaseDecision(-d, WIDTH, BOTH), 'no', 'left is no');
  assert.equal(S.releaseDecision(d - 1, WIDTH, BOTH), null);
  assert.equal(S.releaseDecision(-(d - 1), WIDTH, BOTH), null);
  assert.equal(S.releaseDecision(0, WIDTH, BOTH), null);
  // A side the card cannot take never commits, however far it went.
  assert.equal(S.releaseDecision(-d * 2, WIDTH, { yes: true, no: false }), null);
  assert.equal(S.releaseDecision(d * 2, WIDTH, { yes: false, no: true }), null);
});

test('the note fades in with the distance and is full at the commit point', () => {
  const d = S.commitDistance(WIDTH);
  const half = S.swipeVisual(d / 2, WIDTH, BOTH, false);
  assert.equal(half.side, 'yes');
  assert.ok(Math.abs(half.yes - 0.5) < 1e-9, 'half way, half faded in');
  assert.equal(half.no, 0);
  assert.equal(half.armed, false);
  const full = S.swipeVisual(-d * 1.5, WIDTH, BOTH, false);
  assert.equal(full.side, 'no');
  assert.equal(full.no, 1, 'capped at one');
  assert.equal(full.yes, 0);
  assert.equal(full.armed, true, 'past the point, the release will vote');
  assert.match(full.transform, /^translate3d\(-\d+(\.\d+)?px, 0, 0\) rotate\(-?\d+(\.\d+)?deg\)$/);
  // A side with no action does not move and says nothing.
  const barred = S.swipeVisual(-d, WIDTH, { yes: true, no: false }, false);
  assert.equal(barred.no, 0);
  assert.equal(barred.transform, '');
  assert.equal(barred.armed, false);
});

test('reduced motion: the card stays put, and the note alone says what a release does', () => {
  const d = S.commitDistance(WIDTH);
  const v = S.swipeVisual(d, WIDTH, BOTH, true);
  assert.equal(v.transform, '', 'no travel, no tilt');
  assert.equal(v.yes, 1, 'the note still shows');
  assert.equal(v.armed, true);
  assert.equal(S.releaseDecision(d, WIDTH, BOTH), 'yes', 'and the swipe still votes');
  // The CSS side: the spring-back transition only where motion is welcome.
  const block = CSS.slice(CSS.indexOf('#3052'));
  assert.ok(block.length > 0 && CSS.includes('#3052'), 'app.css carries the swipe block');
  assert.match(block, /@media \(prefers-reduced-motion: no-preference\) \{[^}]*\.dev-ws-item\[data-ws-swipe\]:not\(\[data-ws-swiping\]\) \{ transition: transform/);
});

test('eligibility: only a proposal this viewer can still vote on is swipeable', () => {
  const cast = (vote) => ({ label: vote, act: { fn: 'castVote', args: [7, vote, 2] } });
  const vote = { kind: 'vote', yes: cast('yes'), no: cast('no') };
  assert.deepEqual({ ...S.swipeAllowed(vote, false, false) }, { yes: true, no: true });
  assert.deepEqual({ ...S.swipeAllowed(vote, true, false) }, { yes: false, no: false }, 'already answered here');
  assert.deepEqual({ ...S.swipeAllowed(vote, false, true) }, { yes: false, no: false }, 'a vote already on its way');
  assert.deepEqual({ ...S.swipeAllowed({ ...vote, no: null }, false, false) }, { yes: true, no: false });
  assert.deepEqual({ ...S.swipeAllowed({ ...vote, yes: { label: 'x', act: null } }, false, false) }, { yes: false, no: true });
  // An open issue is "take it or not", and No records nothing: not a vote.
  const claim = { kind: 'claim', yes: { label: "Let's take it", act: { fn: 'openTopic', args: ['issue', 3] } }, no: null };
  assert.deepEqual({ ...S.swipeAllowed(claim, false, false) }, { yes: false, no: false });
  // Anything that is not castVote is not a vote, whatever the row says.
  assert.deepEqual({ ...S.swipeAllowed({ ...vote, yes: { label: 'x', act: { fn: 'openTopic', args: [] } } }, false, false) },
    { yes: false, no: true });
  assert.equal(S.anySwipe({ yes: false, no: false }), false);
  assert.equal(S.anySwipe({ yes: false, no: true }), true);
});

/* ── The tracker: pointer events in, frames and one commit out ──────── */

test('a vertical drag is released to the scroll and never moves the card or votes', () => {
  const { t, frames, commits } = track();
  assert.equal(t.down(touch(100, 300)), true);
  assert.equal(t.move(touch(102, 280)), false, 'not captured');
  assert.equal(t.move(touch(104, 200)), false);
  assert.equal(t.move(touch(260, 190)), false, 'a later sideways turn is still the scroll it began as');
  t.up(touch(260, 190));
  assert.deepEqual(commits, []);
  assert.ok(frames.every((f) => f === null), 'nothing but resets');
  assert.equal(t.consumeClick(1000), false, 'a tap after a scroll is left alone');
});

test('a sideways drag past the distance votes once; short of it, the card springs back', () => {
  const d = S.commitDistance(WIDTH);
  let r = track();
  r.t.down(touch(50, 300));
  assert.equal(r.t.move(touch(70, 302)), true, 'captured once it is clearly sideways');
  r.t.move(touch(50 + d + 5, 305));
  assert.equal(r.frames[r.frames.length - 1].armed, true);
  r.t.up(touch(50 + d + 5, 305), 1000);
  assert.deepEqual(r.commits, ['yes']);
  assert.equal(r.frames[r.frames.length - 1], null, 'and the card comes back to rest');
  // The implicit capture ends after the release; that is not a lost gesture.
  r.t.lost(1);
  assert.equal(r.t.consumeClick(1020), true, 'the click that ends a drag is not a tap on the title');
  assert.equal(r.t.consumeClick(1030), false, 'once');
  // A touch drag often ends with no click at all: the leftover must not eat
  // the next real tap, from a finger or a mouse...
  r.t.down(touch(50, 300));
  r.t.move(touch(80, 300));
  r.t.up(touch(80, 300), 2000);
  r.t.down(touch(50, 300, { pointerType: 'mouse' }));
  assert.equal(r.t.consumeClick(2050), false, 'a new press clears it');
  // ...nor a click with no press before it (a screen reader's activation).
  r.t.down(touch(50, 300));
  r.t.move(touch(80, 300));
  r.t.up(touch(80, 300), 3000);
  assert.equal(r.t.consumeClick(3000 + S.SWIPE_CLICK_WINDOW_MS + 1), false, 'too late to be the swipe\'s own click');
  r.t.down(touch(50, 300));
  r.t.move(touch(80, 300));
  r.t.cancel();
  assert.equal(r.t.consumeClick(4000), false, 'a cancelled gesture makes no click to swallow');
  // The wiring: only a pointer-made click is ever swallowed.
  assert.match(WORKSHOP, /if \(t\.consumeClick\(e\.timeStamp\) && e\.detail !== 0\)/);

  r = track();
  r.t.down(touch(300, 300));
  r.t.move(touch(280, 300));
  r.t.move(touch(300 - d - 1, 300));
  r.t.up(touch(300 - d - 1, 300));
  assert.deepEqual(r.commits, ['no'], 'left is no');

  r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 20, 300));
  r.t.move(touch(50 + d - 20, 300));
  r.t.up(touch(50 + d - 20, 300));
  assert.deepEqual(r.commits, [], 'dragged past and back: changed their mind');
  assert.equal(r.frames[r.frames.length - 1], null, 'spring back');
});

test('pointercancel, a second finger, a mouse and a pen all end without a vote', () => {
  const d = S.commitDistance(WIDTH);
  let r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 30, 300));
  r.t.cancel();
  r.t.up(touch(50 + d + 30, 300));
  assert.deepEqual(r.commits, [], 'the browser took the gesture back');
  assert.equal(r.frames[r.frames.length - 1], null);

  r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 30, 300));
  assert.equal(r.t.down(touch(200, 400, { pointerId: 2, isPrimary: false })), false);
  r.t.move(touch(50 + d + 60, 300));
  r.t.up(touch(50 + d + 60, 300));
  assert.deepEqual(r.commits, [], 'a pinch is not a vote');

  for (const pointerType of ['mouse', 'pen']) {
    r = track();
    assert.equal(r.t.down(touch(50, 300, { pointerType })), false, `${pointerType} does not start a swipe`);
    r.t.move(touch(50 + d + 30, 300, { pointerType }));
    r.t.up(touch(50 + d + 30, 300, { pointerType }));
    assert.deepEqual(r.commits, []);
  }

  // Another pointer's up does not end (or commit) this one.
  r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 30, 300));
  r.t.up(touch(50 + d + 30, 300, { pointerId: 9 }));
  assert.deepEqual(r.commits, []);
});

test('an ineligible card never starts a swipe, and a barred side cannot commit', () => {
  const d = S.commitDistance(WIDTH);
  let r = track({ allowed: { yes: false, no: false } });
  assert.equal(r.t.down(touch(50, 300)), false);
  assert.equal(r.t.move(touch(50 + d + 30, 300)), false);
  r.t.up(touch(50 + d + 30, 300));
  assert.deepEqual(r.commits, []);
  assert.deepEqual(r.frames, []);

  r = track({ allowed: { yes: true, no: false } });
  r.t.down(touch(300, 300));
  r.t.move(touch(280, 300));
  r.t.move(touch(300 - d - 40, 300));
  r.t.up(touch(300 - d - 40, 300));
  assert.deepEqual(r.commits, [], 'no No where the card has none');
});

test('eligibility is read again at release: a card that became unvotable mid-drag does not vote', () => {
  const d = S.commitDistance(WIDTH);
  let allowed = BOTH;
  const commits = [];
  const t = S.createSwipeTracker({
    allowed: () => allowed,
    width: () => WIDTH,
    reducedMotion: () => false,
    onFrame: () => {},
    onCommit: (s) => commits.push(s),
  });
  t.down(touch(50, 300));
  t.move(touch(70, 300));
  t.move(touch(50 + d + 30, 300));
  allowed = { yes: false, no: false }; // a tap on the sheet's Yes landed meanwhile
  t.up(touch(50 + d + 30, 300));
  assert.deepEqual(commits, []);
});

test('a drag that starts sideways and turns down is abandoned, and a sloppy diagonal never votes', () => {
  const d = S.commitDistance(WIDTH);
  let r = track();
  r.t.down(touch(50, 300));
  assert.equal(r.t.move(touch(65, 300)), true, 'locked sideways by the first 15px');
  r.t.move(touch(80, 340));
  assert.equal(r.frames[r.frames.length - 1], null, 'turned vertical: the card goes back');
  assert.equal(r.t.move(touch(50 + d + 40, 360)), false, 'and stays out of it');
  r.t.up(touch(50 + d + 40, 360));
  assert.deepEqual(r.commits, [], 'the scroll it became is not a vote');

  // Far enough, but nearly as far down as across: not clearly a swipe.
  r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 10, 300 + Math.round((d + 10) * 0.8)));
  assert.equal(r.frames[r.frames.length - 1].armed, false, 'the note does not promise a vote');
  r.t.up(touch(50 + d + 10, 300 + Math.round((d + 10) * 0.8)));
  assert.deepEqual(r.commits, []);
  assert.equal(S.releaseDecision(d, WIDTH, BOTH, d), null);
  assert.equal(S.releaseDecision(d, WIDTH, BOTH, Math.floor(d / 2)), 'yes', 'a natural arc still counts');
});

test('a second finger anywhere on the page, or a lost capture, ends the swipe without a vote', () => {
  const d = S.commitDistance(WIDTH);
  let r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 30, 300));
  r.t.interrupt(1); // the window listener hears the gesture's own down: no-op
  r.t.interrupt(2); // a finger on the rail, which the card never sees
  r.t.up(touch(50 + d + 30, 300));
  assert.deepEqual(r.commits, []);
  assert.equal(r.frames[r.frames.length - 1], null);

  r = track();
  r.t.down(touch(50, 300));
  r.t.move(touch(70, 300));
  r.t.move(touch(50 + d + 30, 300));
  r.t.lost(1);
  r.t.up(touch(50 + d + 30, 300));
  assert.deepEqual(r.commits, [], 'a release the card may not have seen is not trusted');
  assert.equal(r.frames[r.frames.length - 1], null, 'and the card is back at rest');
  // The hook listens where the card cannot.
  assert.match(WORKSHOP, /window\.addEventListener\('pointerdown', onDown, true\)/);
  assert.match(WORKSHOP, /onLostPointerCapture: \(e: ReactPointerEvent<HTMLElement>\) => \{ t\.lost\(e\.pointerId\); \}/);
  assert.match(WORKSHOP, /window\.addEventListener\('blur', stop\)/);
});

/* ── The wiring: a swipe is the feed's own answer, and so castVote's ─── */

test('the feed hands a committed swipe to `answer`, the same path the sheet buttons take', () => {
  assert.match(WORKSHOP, /from '\.\/swipe-vote';/, 'the feed imports the gesture module');
  // One answer function, now told which item: the swiped card, not whatever
  // happens to be `row` when the release lands.
  assert.match(WORKSHOP, /const answer = \(which: 'yes' \| 'no', at: number = i\) => \{/);
  assert.match(WORKSHOP, /answerRef\.current = answer;/);
  assert.match(WORKSHOP, /const onSwipe = useCallback\(\(key: string, which: 'yes' \| 'no'\) => \{/);
  const fn = WORKSHOP.slice(WORKSHOP.indexOf('  const onSwipe = useCallback('));
  const body = fn.slice(0, fn.indexOf('\n  }, []);\n'));
  assert.match(body, /answerRef\.current\(which, idx\)/, 'a swipe answers through answer()');
  assert.ok(!/castVote|fetch\(/.test(body), 'and has no vote path of its own');
  // The sheet's buttons are untouched: keyboard and screen-reader users keep them.
  assert.match(WORKSHOP, /data-ws-answer-btn="yes"[\s\S]{0,160}?onClick=\{\(\) => answer\('yes'\)\}/);
  assert.match(WORKSHOP, /data-ws-answer-btn="no"[\s\S]{0,160}?onClick=\{\(\) => answer\('no'\)\}/);
  // The notes are decoration for sighted touch users; the rail's Vote button
  // is what assistive technology is offered.
  assert.match(WORKSHOP, /className="dev-ws-swipe-note dev-ws-swipe-yes" aria-hidden="true"/);
  assert.match(WORKSHOP, /className="dev-ws-swipe-note dev-ws-swipe-no" aria-hidden="true"/);
  // Eligibility per row, from the same state the rail reads.
  assert.match(WORKSHOP, /swipeAllowed\(r, !!answered\[r\.key\], !!sending\[r\.key\]\)/);
});

test('the scroller cannot scroll sideways under a swiped card, and a swipeable card leaves vertical pans to the browser', () => {
  assert.match(CSS, /\.dev-ws-item\[data-ws-swipe\] \{[^}]*touch-action: pan-y;/);
  assert.match(CSS, /\.dev-ws-needs-scroll \{[^}]*overflow-x: hidden;/);
});

/**
 * castVote and the two reason helpers, lifted out of app-view.js as they
 * are and evaluated against a stubbed kit and fetch. The swipe path ends
 * in exactly this call (answer → callAppView(castVote, …, { onSend })).
 */
function realCastVote({ promptAnswer }) {
  const start = APP_VIEW_SRC.indexOf('  async _askVoteReason(vote) {');
  const castAt = APP_VIEW_SRC.indexOf('  async castVote(sessionId, vote');
  const end = APP_VIEW_SRC.indexOf('\n  },\n', castAt) + '\n  },\n'.length;
  assert.ok(start > 0 && castAt > start && end > castAt, 'the three methods are where this test looks');
  const methods = APP_VIEW_SRC.slice(start, end);
  const fetches = [];
  const prompts = [];
  const toasts = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const PlatformUI = {
    prompt: async (o) => { prompts.push(o); await gate; return promptAnswer; },
    toast: (m) => toasts.push(m),
  };
  const sandbox = {
    window: { PlatformUI, Notifications: null },
    PlatformUI,
    fetch: async (url, init) => { fetches.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; },
  };
  vm.createContext(sandbox);
  const AppView = vm.runInContext(`(() => { const AppView = {
    _voteInFlight: new Set(), _pendingVotes: new Map(), _seenEpoch: new Map(),
    _findItem: () => null, _applyVoteToRow: () => {}, _repaintAfterVote: () => {},
    refreshDevData: async () => {},
${methods}
  }; return AppView; })()`, sandbox);
  return { AppView, fetches, prompts, toasts, release };
}

async function swipeLeftThrough(AppView) {
  // The feed's answer() pads castVote's args to three and adds the bag.
  const d = S.commitDistance(WIDTH);
  let voted = null;
  const sent = [];
  const t = S.createSwipeTracker({
    allowed: () => BOTH,
    width: () => WIDTH,
    reducedMotion: () => false,
    onFrame: () => {},
    onCommit: (side) => {
      voted = AppView.castVote(7, side, 2, { onSend: (v) => sent.push(v) });
    },
  });
  t.down(touch(300, 300));
  t.move(touch(280, 300));
  t.move(touch(300 - d - 10, 300));
  t.up(touch(300 - d - 10, 300));
  return { voted, sent };
}

test('a No swipe opens the reason prompt and sends nothing until a line is given', async () => {
  const k = realCastVote({ promptAnswer: 'The button is too small' });
  const { voted, sent } = await swipeLeftThrough(k.AppView);
  assert.ok(voted, 'the swipe reached castVote');
  await new Promise((r) => setImmediate(r));
  assert.equal(k.prompts.length, 1, 'the same prompt the sheet\'s No opens');
  assert.equal(k.prompts[0].title, 'What’s not working for you?');
  assert.equal(k.fetches.length, 0, 'NOTHING is sent while the prompt is open');
  assert.deepEqual(sent, [], 'and the rail does not say Sending…');
  k.release();
  assert.equal(await voted, true);
  assert.equal(k.fetches.length, 1);
  assert.equal(k.fetches[0].url, '/api/sessions/7/vote', 'the one vote endpoint the buttons use');
  assert.deepEqual(k.fetches[0].body, { vote: 'no', expectedEpoch: 2, reason: 'The button is too small' });
});

test('cancelling the reason prompt after a No swipe votes nothing and returns the card', async () => {
  const k = realCastVote({ promptAnswer: null });
  const { voted, sent } = await swipeLeftThrough(k.AppView);
  k.release();
  assert.equal(await voted, false, 'answer() reads false and drops the pin: the card is as it was');
  assert.equal(k.fetches.length, 0);
  assert.deepEqual(sent, []);
});

test('an empty line after a No swipe is refused on the client too', async () => {
  const k = realCastVote({ promptAnswer: '   ' });
  const { voted } = await swipeLeftThrough(k.AppView);
  k.release();
  assert.equal(await voted, false);
  assert.equal(k.fetches.length, 0);
  assert.match(k.toasts[0], /A No comes with a line/);
});

test('a swipe and a tap on the same card cannot both vote', () => {
  // answer() keeps one vote per card in flight; the swipe runs through it,
  // so the guard covers the swipe + tap race without a second copy.
  const fn = WORKSHOP.slice(WORKSHOP.indexOf('  const answer = (which'));
  const body = fn.slice(0, fn.indexOf('\n  };\n'));
  assert.match(body, /if \(sendingRef\.current\.has\(key\)\) return;/);
  // And a card answered this session is not swipeable at all (above), so a
  // swipe cannot flip a vote the sheet's buttons would ask about.
});
