'use strict';

// #2223: THE ROOT IS HIDDEN BEFORE THE CARD COMES HOME.
//
// On a KIT-initiated dismissal — a backdrop tap, Escape, the kit's own
// control — React does not know the dialog is closing. Its close branch,
// which is what writes `hidden` on the root, has not run: `open` is still
// true. The kit finishes its exit animation, calls onDismiss, and
// adoptKitSurface's `undo()` re-homes the card into a root that is STILL
// VISIBLE. The whole dialog paints back in at full opacity until React
// catches up a frame or two later.
//
// Measured in Chromium against the real kit, tracking the card's painted
// visibility through a backdrop-tap close of the feedback dialog:
//
//   t=  5ms  visible   in the kit shell, root not hidden
//   t=154ms  gone      the kit's fade has finished
//   t=195ms  VISIBLE   undo() re-homed it into the un-hidden root
//   t=212ms  gone      React's state finally caught up
//
// Seventeen milliseconds of dialog AFTER the animation has played. Closing
// through `controller.close()` never showed it — that path hides the root on
// the way in — which is why this went unfound by reading the close branch.
// Only the kit's own dismissal reaches it, and that is the one a person uses.
//
// What this file pins is the ORDER, at the seam where it is decided:
// `present()` hands adoptKitSurface an `onDismissStart`, and adoptKitSurface
// calls that immediately before `undo()`. Lose either half and the flash is
// back with nothing to catch it — the dialogs' own tests assert end states,
// and the end state was always correct.
//
// Run with: node --test tests/static-modal-dismiss-order.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const STATIC_MODAL = read('frontend/src/lib/static-modal.ts');
const KIT_SURFACE = read('frontend/src/lib/kit-surface.ts');

test('present() hands the kit an onDismissStart that hides the root', () => {
  // The whole fix in one hook. Without it the restore lands in a visible
  // root; with it the root is already hidden and nothing paints.
  const at = STATIC_MODAL.indexOf('return adoptKitSurface({');
  assert.ok(at > 0, 'present() adopts through adoptKitSurface');
  const call = STATIC_MODAL.slice(at, STATIC_MODAL.indexOf('\n}', at));
  assert.match(call, /onDismissStart:/,
    'the modal seam must take the pre-restore hook');
  assert.match(call, /onDismissStart:[\s\S]*?classList\.add\('hidden'\)/,
    'and what it does there is hide the root');
});

test('the hook fires BEFORE the card is re-homed, not after', () => {
  // Order is the entire point. adoptKitSurface's own onDismiss runs
  // onDismissStart, then the ownership guard, then undo().
  const at = KIT_SURFACE.indexOf('onDismiss: () => {');
  assert.ok(at > 0, 'adoptKitSurface wires the kit callback');
  const body = KIT_SURFACE.slice(at, KIT_SURFACE.indexOf('},', at));
  const start = body.indexOf('onDismissStart');
  const undo = body.indexOf('undo()');
  assert.ok(start >= 0, 'onDismissStart is called');
  assert.ok(undo >= 0, 'undo() re-homes the card');
  assert.ok(start < undo,
    'onDismissStart must run BEFORE undo() — reversing them restores the '
    + 'card into a root that is still visible, which is the #2223 flash');
});

test('hiding the root is idempotent, so the React path is unaffected', () => {
  // The React-initiated close already hid the root on its way in. The hook
  // has to no-op there rather than fight it, or a reopen races the write.
  const at = STATIC_MODAL.indexOf('onDismissStart:');
  const hook = STATIC_MODAL.slice(at, STATIC_MODAL.indexOf('},', at));
  assert.match(hook, /!root\.classList\.contains\('hidden'\)/,
    'guarded on the class not already being there');
});

test('the close branch still hides the root itself', () => {
  // The hook is the kit path's answer, NOT a replacement for the React
  // path's own hide — a dialog closed through the controller with no kit
  // loaded never reaches adoptKitSurface at all.
  const at = STATIC_MODAL.indexOf('} else {', STATIC_MODAL.indexOf('if (open) {'));
  const closeBranch = STATIC_MODAL.slice(at, at + 2400);
  assert.match(closeBranch, /classList\.add\('hidden'\)/,
    'the close branch keeps hiding the root for the no-kit path');
});
