// The device back button, for surfaces that are open rather than navigated to
// (#1521).
//
// Screens already work: they are hash routes, so back walks browser history
// and `App._routeFromHash` rebuilds them. Dialogs and sheets are React state
// with no history entry, so the press fell straight past them — which stopped
// being merely useless the moment the Android shell started exiting at its
// root, because then the same press closes the whole app while the viewer is
// dismissing a dialog.
//
// Run with: node --test tests/back-stack.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { createBackStack, DISMISS_STATE_KEY, DISMISS_ID_KEY } =
  loadTsx('frontend/src/lib/back-stack.ts');

/**
 * A history that records what was asked of it, and a `back()` that fires
 * popstate the way a browser does — which is the whole reason the release
 * path needs a flag.
 */
function fixture() {
  const pushes = [];
  // One browser action, used for BOTH a real press and the release path's
  // own history.back(): a record is consumed and popstate follows. Modelling
  // them identically is the point — the module has to tell them apart on its
  // own, and a fixture that popped only for one of them would do that work
  // for it and prove nothing.
  const navigateBack = () => {
    pushes.pop();
    win.history.state = pushes[pushes.length - 1] ?? null;
    // The browser fires this asynchronously; synchronous here is the harsher
    // test, because it runs while release() is still on the stack.
    return stack.handlePop();
  };
  const win = {
    history: {
      state: null,
      pushState(state) {
        pushes.push(state);
        this.state = state;
      },
      back: () => navigateBack(),
    },
  };
  const stack = createBackStack(win);
  // What the viewer pressing back looks like from here.
  const pressBack = () => navigateBack();
  return { stack, win, pushes, pressBack };
}

test('an open surface claims the next back press, and back closes it', () => {
  const { stack, pushes, pressBack } = fixture();
  let closed = 0;
  stack.push(() => { closed += 1; });

  assert.equal(stack.size, 1);
  assert.equal(pushes.length, 1, 'opening pushes exactly one history record');
  assert.equal(pushes[0][DISMISS_STATE_KEY], 1);

  assert.equal(pressBack(), true, 'the press is consumed, not passed on');
  assert.equal(closed, 1);
  assert.equal(stack.size, 0);
});

test('with nothing open, the press is passed on', () => {
  const { stack, pressBack } = fixture();
  assert.equal(pressBack(), false,
    'an unclaimed press must reach the shell, and on Android the app');
});

test('closing by ✕ spends its own record, so the next press is not wasted', () => {
  // The bug this prevents: dismiss a dialog by tapping ✕, then press back.
  // The record the dialog pushed is still on the stack, so that press is
  // swallowed by a dialog that is no longer there and the viewer sees
  // nothing happen — the original complaint, reintroduced one level down.
  const { stack, pushes, pressBack } = fixture();
  let closed = 0;
  const release = stack.push(() => { closed += 1; });

  release();

  assert.equal(stack.size, 0);
  assert.equal(pushes.length, 0, 'the record went with it');
  assert.equal(closed, 0, 'releasing is not closing — the caller already closed');
  assert.equal(pressBack(), false, 'the next press passes on');
});

test('closing the top by \u2715 does not also close what is under it', () => {
  // The release path spends its own record with history.back(), and that fires
  // a popstate indistinguishable from a real press. Without the flag that
  // marks it as ours, this popstate closes the NEXT surface down — dismiss a
  // dialog over a sheet with \u2715 and the sheet vanishes with it.
  //
  // One surface is not enough to catch that: the entry is spliced out before
  // back() fires, so the stack is empty and the stray press lands on nothing.
  // It takes two.
  const { stack, pushes } = fixture();
  let underClosed = 0;
  stack.push(() => { underClosed += 1; });
  const releaseTop = stack.push(() => {});

  releaseTop();

  assert.equal(underClosed, 0, 'the surface underneath must still be open');
  assert.equal(stack.size, 1, 'and still claiming the next press');
  assert.equal(pushes.length, 1, 'holding exactly its own record');
});

test('a back-driven close does not spend a second record', () => {
  // handlePop pops the entry BEFORE running close(), so the surface's own
  // release finds nothing to do. Without that ordering the release would call
  // history.back() again and eat an unrelated record — on the dashboard, that
  // is the app exiting a press early.
  const { stack, win, pushes, pressBack } = fixture();
  let release;
  release = stack.push(() => { release(); });

  pressBack();

  assert.equal(stack.size, 0);
  assert.equal(pushes.length, 0);
  assert.equal(win.history.state, null);
});

test('refusing to close keeps the claim, rather than handing the press on', () => {
  // A dialog guarding unsaved work answers false. The press is still consumed
  // — nothing underneath should act on it — and the NEXT press finds the
  // dialog still claiming, instead of falling through to exit the app.
  const { stack, pushes, pressBack } = fixture();
  let asked = 0;
  stack.push(() => { asked += 1; return false; });

  assert.equal(pressBack(), true, 'the press is consumed even when refused');
  assert.equal(asked, 1);
  assert.equal(stack.size, 1, 'the surface is still open and still claiming');
  assert.equal(pushes.length, 1, 'and still owns a record for the next press');

  assert.equal(pressBack(), true);
  assert.equal(asked, 2);
});

test('stacked surfaces close newest first', () => {
  const { stack, pressBack } = fixture();
  const order = [];
  stack.push(() => { order.push('under'); });
  stack.push(() => { order.push('over'); });

  pressBack();
  pressBack();

  assert.deepEqual(order, ['over', 'under']);
});

test('releasing underneath does not steal the record above it', () => {
  // Two surfaces closing out of order. The lower one must drop its entry
  // without spending a record, because the newest record belongs to the one
  // still open — spending it would leave that surface unable to be closed by
  // back.
  const { stack, pushes, pressBack } = fixture();
  let overClosed = 0;
  const releaseUnder = stack.push(() => {});
  stack.push(() => { overClosed += 1; });
  assert.equal(pushes.length, 2);

  releaseUnder();

  assert.equal(stack.size, 1, 'only the top is left');
  assert.equal(pushes.length, 2, 'and its record is untouched');
  assert.equal(pressBack(), true);
  assert.equal(overClosed, 1, 'back still closes the surface that is open');
});

test('a history that refuses to be written does not throw into the caller', () => {
  // Some embeddings refuse pushState. A dialog that cannot claim back is a
  // degraded dialog, not a broken one.
  const win = {
    history: {
      state: null,
      pushState() { throw new Error('denied'); },
      back() { throw new Error('denied'); },
    },
  };
  const stack = createBackStack(win);
  let closed = 0;
  const release = stack.push(() => { closed += 1; });
  assert.equal(stack.size, 1);
  assert.doesNotThrow(() => release());
  assert.equal(stack.size, 0);
  assert.equal(closed, 0);
});

// ── #2811: a dialog's own traversal must not re-run the page's router ─────
//
// Every record here is pushed at the SAME address, so popping one — the
// release path's history.back() when a dialog closes by ✕ / Cancel / its own
// timer, or a back press the dialog consumes — lands where the page already
// is. Letting that popstate through re-ran `App._routeFromHash`, which on a
// dev session page rebuilds `#dev-section` from scratch: the transcript
// blanked for a few hundred ms every time the Send feedback dialog closed
// after filing an issue. `handlePopstate` is what the capture-phase listener
// asks before stopping the event.

/** The fixture above, plus an address a test can move. */
function fixtureAt(href) {
  const f = fixture();
  f.win.location = { href };
  return f;
}

test('#2811: a release spending its own record is reported as in place', () => {
  const f = fixtureAt('https://x.test/app/demo/dev/sessions/1');
  const release = f.stack.push(() => {});
  let verdict;
  // The browser fires popstate for the release's history.back(); route it
  // through handlePopstate, as the shell's listener does.
  f.win.history.back = () => {
    f.pushes.pop();
    verdict = f.stack.handlePopstate();
  };

  release();

  assert.equal(verdict, true,
    'closing a dialog must not re-run the router at the address it is already on');
  assert.equal(f.stack.size, 0);
});

test('#2811: a back press a surface consumes is reported as in place', () => {
  const f = fixtureAt('https://x.test/app/demo/dev/sessions/1');
  let closed = 0;
  f.stack.push(() => { closed += 1; });
  f.pushes.pop();

  assert.equal(f.stack.handlePopstate(), true);
  assert.equal(closed, 1, 'the press still closes the surface');
});

test('#2811: an unclaimed press still reaches the router', () => {
  const f = fixtureAt('https://x.test/app/demo/workshop');
  assert.equal(f.stack.handlePopstate(), false,
    'with nothing open, back is navigation and the page must see it');
});

test('#2811: a traversal that moved the address is passed on', () => {
  // Something navigated while the dialog was open, so the release's
  // history.back() lands on a different address — there IS a route to
  // restore, and swallowing it would leave the screen out of step with the URL.
  const f = fixtureAt('https://x.test/app/demo/dev/sessions/1');
  const release = f.stack.push(() => {});
  let verdict;
  f.win.history.back = () => {
    f.pushes.pop();
    f.win.location.href = 'https://x.test/app/demo/workshop';
    verdict = f.stack.handlePopstate();
  };

  release();

  assert.equal(verdict, false);
});

test('#2811: a host with no address never swallows a popstate', () => {
  const { stack } = fixture();
  stack.push(() => {});
  assert.equal(stack.handlePopstate(), false);
});

test('#2811: the shell listener runs first and stops an in-place traversal', () => {
  // Capture phase, so it precedes App's bubble-phase popstate listener on
  // window regardless of which script registered first.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'frontend/src/lib/back-stack.ts'), 'utf8');
  assert.match(src,
    /addEventListener\('popstate', \(event\) => \{\s*if \(shared\?\.handlePopstate\(\)\) event\.stopImmediatePropagation\(\);\s*\}, true\);/);
});

// ── QA 2026-09-24 Q16: closing on the way somewhere ──────────────────────
//
// Sheets and menus close as the first half of a navigation: a notification
// row, a menu row, a link inside the profile editor, Leave group. A release
// that spends its record with history.back() in that same task loses to the
// navigation either way round, so a release can say it is navigating, no
// release spends a record the page is not standing on, and a record whose
// surface has gone is passed through rather than stopped at.
//
// This needs a history with addresses, asynchronous traversals and the
// shell's router behind the capture listener, so it gets a fixture of its own.

function browser({ navigationApi = false } = {}) {
  const tasks = [];
  let keys = 0;
  const entries = [{ url: 'https://x.test/#apps', state: null, key: `k${keys++}` }];
  let at = 0;
  const routed = [];
  let navFrom = null;
  const listeners = [];
  const win = {
    location: { href: entries[0].url },
    setTimeout: (fn) => { tasks.push(fn); },
    history: {
      get state() { return entries[at].state; },
      pushState(state, _t, url) {
        entries.splice(at + 1);
        entries.push({ url: url ? new URL(url, win.location.href).href : entries[at].url, state, key: `k${keys++}` });
        at = entries.length - 1;
        win.location.href = entries[at].url;
      },
      // Same slot, same Navigation API key; the state is whatever was passed.
      replaceState(state, _t, url) {
        entries[at] = { ...entries[at], state, url: url ? new URL(url, win.location.href).href : entries[at].url };
        win.location.href = entries[at].url;
      },
      back: () => tasks.push(() => traverse(-1)),
      forward: () => tasks.push(() => traverse(1)),
    },
  };
  if (navigationApi) {
    win.navigation = {
      get currentEntry() { return { index: at, key: entries[at].key }; },
      get canGoForward() { return at < entries.length - 1; },
      addEventListener: (type, fn) => listeners.push(fn),
    };
  }
  const stack = createBackStack(win);
  function traverse(delta) {
    const to = at + delta;
    if (to < 0 || to >= entries.length) return;
    navFrom = { index: at, url: entries[at].url };
    at = to;
    win.location.href = entries[at].url;
    for (const fn of listeners) fn({ navigationType: 'traverse', from: navFrom });
    // The capture listener first; the router hears only what it lets through.
    if (!stack.handlePopstate()) routed.push(win.location.href);
  }
  const flush = () => { while (tasks.length) tasks.shift()(); };
  return {
    stack, win, routed, flush,
    // The page writing an address (a link, a row, the router's pushState).
    navigate(url) { win.history.pushState(null, '', url); },
    press() { win.history.back(); flush(); },
    forward() { win.history.forward(); flush(); },
    get at() { return at; },
    urls: () => entries.map((e) => e.url.replace('https://x.test/', '')),
  };
}

test('Q16: a record is spent only from on top of it', () => {
  // Leave group: the store navigates to the list, THEN the dialog closes.
  // Spending the record from there would take the viewer back to the thread
  // they just left.
  const b = browser();
  const release = b.stack.push(() => {});
  b.navigate('#messages');
  release();
  b.flush();
  assert.equal(b.win.location.href, 'https://x.test/#messages', 'the navigation stands');
  assert.deepEqual(b.routed, [], 'nothing was traversed');
});

test('Q16: a navigating release spends its record a task later when nothing moved', () => {
  // ✕ on a sheet: every close of a sheet is a navigating release, and with
  // nothing written after it the record goes exactly as a plain one would.
  const b = browser();
  const release = b.stack.push(() => {});
  assert.equal(b.at, 1);
  release({ navigating: true });
  assert.equal(b.at, 1, 'not in the same task');
  b.flush();
  assert.equal(b.at, 0, 'spent');
  assert.deepEqual(b.routed, [], 'and the router never saw it');
});

test('Q16: a navigating release followed by a navigation leaves the navigation alone', () => {
  const b = browser();
  const release = b.stack.push(() => {});
  release({ navigating: true });
  b.navigate('#messages/7');
  b.flush();
  assert.equal(b.win.location.href, 'https://x.test/#messages/7');
  assert.deepEqual(b.urls(), ['#apps', '#apps', '#messages/7'], 'the record is left where it was');
});

test('Q16: Back passes through a record whose surface has gone', () => {
  // A notification row opened a conversation from Discover. One Back returns
  // to Discover: the router hears the landing (a real move), and the step on
  // to the entry under the record is ours and in place.
  const b = browser();
  const release = b.stack.push(() => {});
  release({ navigating: true });
  b.navigate('#messages/7');
  b.flush();

  b.press();

  assert.equal(b.at, 0, 'on the entry under the record, not on the record');
  assert.deepEqual(b.routed, ['https://x.test/#apps'], 'routed once, back to Discover');
  b.press();
  assert.equal(b.at, 0, 'and the next press is not spent on a record either');
});

test('Q16: a press a surface consumes also passes through a dead record under it', () => {
  // The Homeroom menu's "Give feedback": the menu closes on its way to the
  // dialog, whose record lands on top of the menu's before the menu's could
  // be spent. Back closes the dialog and must not stop on the menu's record.
  const b = browser();
  const releaseMenu = b.stack.push(() => {});
  releaseMenu({ navigating: true });
  let closed = 0;
  b.stack.push(() => { closed += 1; });
  b.flush();
  assert.deepEqual(b.urls(), ['#apps', '#apps', '#apps']);

  b.press();

  assert.equal(closed, 1, 'the dialog closed');
  assert.equal(b.at, 0, 'and one press reached the page itself');
  assert.deepEqual(b.routed, [], 'without the router re-running at the same address');
});

test('Q16: Forward passes through a dead record too, where the browser says which way', () => {
  const b = browser({ navigationApi: true });
  const release = b.stack.push(() => {});
  release({ navigating: true });
  b.navigate('#messages/7');
  b.flush();
  b.press();
  assert.equal(b.at, 0);
  b.routed.length = 0;

  b.forward();

  assert.equal(b.at, 2, 'on to the conversation, not stopped on the record');
  assert.deepEqual(b.routed, ['https://x.test/#messages/7'],
    'the router hears the conversation, and not the in-place step onto the record');
});

test('Q16: records are told apart by an id, not by their depth', () => {
  const b = browser();
  b.stack.push(() => {});
  const id = b.win.history.state[DISMISS_ID_KEY];
  assert.equal(typeof id, 'string');
  b.stack.push(() => {});
  assert.notEqual(b.win.history.state[DISMISS_ID_KEY], id);
});

test('Q16: a record the router replaced in place is still spent by \u2715, where the browser keeps its key', () => {
  // updateHash replaces the entry with a null state when the screen does not
  // change. The id in the record's state goes with it; the Navigation API's
  // key for the slot does not, and it is what says the page is still on it.
  const b = browser({ navigationApi: true });
  const release = b.stack.push(() => {});
  b.win.history.replaceState(null, '');
  release();
  b.flush();
  assert.equal(b.at, 0, 'spent');
});

test('Q16: without the Navigation API, a record with its state replaced is left, not spent blind', () => {
  // Nothing then says the page is on it; spending it anyway is the Leave
  // group bug. A duplicate entry costs a press; a wrong back() costs a page.
  const b = browser();
  const release = b.stack.push(() => {});
  b.win.history.replaceState(null, '');
  release();
  b.flush();
  assert.equal(b.at, 1);
});
