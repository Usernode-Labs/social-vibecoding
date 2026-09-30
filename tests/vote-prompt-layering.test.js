// #3412: the vote prompt must never lose its taps to a screen-covering layer
// the screen it was opened from left behind. The Needs-you deck keeps its
// sheet mounted for the exit animation (`data-ws-leaving`), and its answer
// path starts that exit in the same breath it calls `castVote` — so for the
// ~220ms the fade runs, a full-screen scrim (fixed and transparent on the
// wide vote popover) sits over the prompt's buttons. The kit releases its
// own surfaces at dismissal start for exactly this reason (releaseInput);
// the attribute that starts the deck's exit must release this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the deck sheet releases hit-testing the moment its exit starts', () => {
  const css = read('public/css/app.css');
  const rule = '.dev-ws-sheet-modal[data-ws-leaving] { pointer-events: none; }';
  const at = css.indexOf(rule);
  assert.ok(at >= 0, 'a base rule releases the leaving sheet, card and scrim alike');
  // Base level, not inside a reduced-motion query: the release is not a
  // motion preference — a reduced-motion user closes sheets too. The exit
  // keyframes sit just after that query closes, so they mark base level.
  const keyframes = css.indexOf('@keyframes dev-ws-scrim-out');
  assert.ok(keyframes > 0 && at > keyframes, 'the release sits outside the motion query');
  // The wide vote popover is the reported stale layer: the same element is
  // the full-screen modal the release rule targets, and its own scrim is a
  // fixed transparent box — the one a tap lands on when the sheet goes stale.
  const wide = css.indexOf('.dev-ws-sheet-vote > .dev-ws-scrim { position: fixed; background: transparent; }');
  assert.ok(wide > 0, 'the wide popover still carries the transparent fixed scrim the release covers');
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'),
    /className="dev-ws-sheet-modal dev-ws-sheet-vote"/,
    'the popover is the modal the release rule keys on');
});
