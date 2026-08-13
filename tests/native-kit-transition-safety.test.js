// The view-transition safety contract in the usernode-native kit
// (public/usernode-native/v1/native.js).
//
// ── The bug this pins ──────────────────────────────────────────────────
//
// `document.startViewTransition()` hands back THREE promises: `ready`,
// `updateCallbackDone` and `finished`. When the browser ABORTS a transition
// it rejects `ready`. transition() only ever attached a handler to
// `finished`, so that rejection was observed by nobody — and an unhandled
// promise rejection is reported by Playwright as a `pageerror`, which fails
// the platform's own proposal checks on every route that hits it.
//
// The abort itself is legitimate and unavoidable: a View Transition animates
// BETWEEN two rendered states, so starting one before the document's first
// paint has no "old" state to snapshot and the browser declines it with
// `InvalidStateError: Transition was aborted because of invalid state`. The
// shell walks into that window on a deep-link boot — land on `#profile` and
// App.init() routes on DOMContentLoaded and immediately asks for a 'push'.
//
// Whether it landed was a race, which is why it read as a flaky spray of
// route failures rather than one bug: 33 failing checks on one proposal and
// 55 on another, from the same cause.
//
// Two guards, and BOTH matter:
//   1. Attach no-op rejection handlers to `ready`/`updateCallbackDone`, so an
//      abort can never become a page error. This is the safety net — it
//      holds for abort causes nobody has thought of yet (a background tab,
//      a duplicate view-transition-name, a future browser rule).
//   2. Don't start a transition before the first frame at all, so the common
//      case is deterministic rather than timing-dependent.
//
// Neither is a behaviour change: an aborted transition already ran its
// mutation callback and already produced no animation.
//
// Run with: node --test tests/native-kit-transition-safety.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'usernode-native', 'v1', 'native.js'),
  'utf8',
);

// The body of `function transition(fn, opts) { … }`, up to the next
// top-level function in the file.
function transitionBody() {
  const start = SRC.indexOf('function transition(fn, opts)');
  assert.ok(start > -1, 'native.js no longer defines transition(fn, opts)');
  const end = SRC.indexOf('\n  /* ', start);
  assert.ok(end > start, 'could not find the end of transition()');
  return SRC.slice(start, end);
}

test('an aborted view transition cannot become an unhandled rejection', () => {
  const body = transitionBody();

  assert.match(
    body, /vt\.ready[\s\S]{0,120}?\.catch\(/,
    'transition() must attach a rejection handler to vt.ready. The browser rejects it on every '
    + 'aborted transition, and an unobserved rejection is a pageerror, which fails proposal checks.',
  );
  assert.match(
    body, /vt\.updateCallbackDone[\s\S]{0,160}?\.catch\(/,
    'transition() must attach a rejection handler to vt.updateCallbackDone for the same reason.',
  );
  assert.match(
    body, /vt\.finished\.catch\(/,
    'transition() must keep handling vt.finished — it is what resets vtActive and clears data-un-vt.',
  );
});

test('the abort path stays silent — no console output of its own', () => {
  const body = transitionBody();
  assert.doesNotMatch(
    body, /console\.(error|warn)\s*\(/,
    'the transition path must not log. console.error fails the platform\'s console-error baseline '
    + 'on every route, which is the exact failure the rejection handlers exist to remove — logging '
    + 'the abort instead of swallowing it would simply reintroduce it in another shape.',
  );
});

test('an immediate mutation skips a transition that has not captured yet', () => {
  // #1102. A View Transition captures its OLD snapshot at the next rendering
  // opportunity, not when startViewTransition() returns. Everything in the
  // bail-out branch above runs its mutation SYNCHRONOUSLY instead — 'none',
  // a re-entrant call (vtActive), reduced motion — so when one of those
  // lands inside another transition's uncaptured window, the mutation is
  // baked into the outgoing snapshot and the animation plays the new page
  // against a dimmed copy of itself. That is the two-copies artefact.
  //
  // The caller is responsible for not issuing the duplicate at all (see
  // tests/screen-transition-order.test.js); what the kit guarantees is
  // narrower — it will not ANIMATE a corrupted snapshot. Skipping first
  // degrades the worst case to no animation.
  const body = transitionBody();

  assert.match(
    body, /var vtPending = null;|vtPending/,
    'transition() must track the transition whose update callback has not run yet.',
  );
  assert.match(
    SRC, /var vtPending = null;/,
    'the pending-transition handle must be a module-level var beside vtActive.',
  );

  const bail = body.slice(
    body.indexOf("type === 'none' || vtActive"),
    body.indexOf('vtActive = true;'),
  );
  assert.ok(bail.length, 'could not find the immediate-run branch of transition()');
  assert.match(
    bail, /skipTransition\(\)/,
    'the immediate-run branch must skip a pending transition before mutating — otherwise the '
    + 'mutation ends up in that transition\'s old snapshot (#1102).',
  );
  const skipAt = bail.indexOf('skipTransition()');
  const runAt = bail.indexOf('run();');
  assert.ok(runAt > -1, 'the immediate-run branch still calls run()');
  assert.ok(skipAt > -1 && skipAt < runAt,
    'the skip must happen BEFORE run() — after it, the snapshot is already corrupted.');
  assert.match(
    bail, /try \{[^}]*skipTransition\(\)[\s\S]{0,80}?catch/,
    'skipTransition() must be guarded: it throws on a transition that has already finished.',
  );
  assert.doesNotMatch(
    bail, /console\.(error|warn|log)\s*\(/,
    'the skip path must stay silent for the same reason the abort path does.',
  );

  // The handle is cleared from inside the update callback, which the browser
  // only invokes once the old state is captured. Clearing it any earlier
  // (right after startViewTransition returns) would reopen the window.
  assert.match(
    body, /var capture = function \(\) \{ vtPending = null; run\(\); \};/,
    'the pending handle must be cleared from INSIDE the update callback — that call is the '
    + 'browser telling us the old state has been captured.',
  );
  assert.match(
    body, /vt = document\.startViewTransition\(capture\)/,
    'startViewTransition() must be handed the wrapper that clears the handle, not run directly.',
  );
  assert.match(
    body, /if \(vtPending === vt\) vtPending = null;/,
    'the finished handler must release the handle too, for a transition the browser aborted '
    + 'before ever calling the update callback.',
  );
});

test('a transition is not started before the document has painted a frame', () => {
  const body = transitionBody();
  assert.match(
    body, /hasRenderedAFrame\(\)/,
    'transition() must consult the first-paint guard in its bail-out condition, alongside the '
    + '`type === none` / vtActive / prefers-reduced-motion checks.',
  );

  const guard = SRC.slice(SRC.indexOf('function hasRenderedAFrame'));
  assert.ok(guard.length, 'native.js no longer defines hasRenderedAFrame()');
  assert.match(
    guard.slice(0, 600), /visibilityState/,
    'hasRenderedAFrame() should also treat a hidden document as unpainted — a background tab is '
    + 'not being rendered, so there is no frame to capture however long the page has been open.',
  );

  // The flag has to be set from a DOUBLE requestAnimationFrame. A single rAF
  // callback runs BEFORE its frame is painted, so flipping the flag there
  // would claim a paint that has not happened yet and reopen the race.
  assert.match(
    SRC, /requestAnimationFrame\(function \(\) \{ requestAnimationFrame\(markFramePainted\); \}\)/,
    'the painted-a-frame flag must be set from a nested requestAnimationFrame — a single rAF fires '
    + 'before that frame reaches the screen.',
  );
});

test('the shell still asks for real animations, so the guard is load-bearing', () => {
  // If nothing requested a push/pop any more, the guards above would be
  // vacuous and this file would be pinning dead code.
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.match(
    appJs, /PlatformUI\.transition\(/,
    'app.js should still route screen navigation through PlatformUI.transition',
  );
  // Screen navigations ask via App._entryTransition(preferred, screenEl),
  // which downgrades to 'none' when the drawer is on screen (#977) and
  // otherwise passes the preference through.
  assert.match(
    appJs, /_entryTransition\([^)]*'push'/,
    'app.js should still request push transitions for real screen navigation',
  );
});

test('the first-paint guard cannot change what dapp.json asserts about entry type', () => {
  // Two declared checks assert `[data-entered="none"]`. That attribute is
  // stamped by App._entryTransition in app.js BEFORE the kit is called, so a
  // kit-side decision to skip the animation cannot move it. Pin the ordering
  // — if the stamp ever moved into the kit, those checks would start
  // reporting the kit's decision instead of the shell's and this fix would
  // silently change their meaning.
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const entry = appJs.slice(appJs.indexOf('_entryTransition(preferred, screenEl)'));
  assert.match(
    entry.slice(0, 700), /setAttribute\('data-entered', type\)/,
    'app.js must keep stamping data-entered itself — the dapp.json #977 checks read it, and the '
    + 'kit never sees the drawer-suppression rule that decides its value.',
  );
  assert.doesNotMatch(
    SRC, /data-entered/,
    'the native kit must not write data-entered; it belongs to the shell.',
  );
});
