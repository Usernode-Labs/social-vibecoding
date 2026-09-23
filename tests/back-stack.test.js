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
const { createBackStack, DISMISS_STATE_KEY } =
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
