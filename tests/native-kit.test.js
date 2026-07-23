// Unit tests for the usernode-native v1 kit's physics
// (public/usernode-native/v1/native.js). The file is dual-target: in Node
// it exports { physics } and touches no DOM, so the gesture math — the
// part the "feels native" fidelity requirements hang on — is testable
// headlessly. The DOM half (springs on elements, swipe/PTR wiring) is
// exercised via the demo page in a browser.
//
// Run with: node --test tests/native-kit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { physics } = require('../public/usernode-native/v1/native.js');

const {
  PRESETS,
  DECEL_RATE,
  springStep,
  simulateSpring,
  projectMomentum,
  projectDisplacement,
  estimateVelocity,
  rubberband,
  rubberbandInvert,
  lockIntent,
  decideSwipeRelease,
  decidePtrRelease,
  decideSheetRelease,
  keyboardInset,
  isTextEntryField,
  revealScrollDelta,
  reorderDropIndex,
  gridDropSide,
  autoScrollVelocity,
  createArbiter,
  createToastSlot,
} = physics;

// ── Spring integrator ──────────────────────────────────────────────────

test('spring converges to the target and terminates at the rest threshold', () => {
  for (const name of Object.keys(PRESETS)) {
    const r = simulateSpring(0, 100, 0, PRESETS[name]);
    assert.ok(
      Math.abs(r.x - 100) < physics.REST_DELTA,
      `${name}: settled at ${r.x}, expected ~100`
    );
    assert.ok(Math.abs(r.v) < physics.REST_VELOCITY, `${name}: still moving at rest`);
    assert.ok(r.durationMs < 5000, `${name}: never terminated (${r.durationMs}ms)`);
    assert.ok(r.durationMs > 50, `${name}: implausibly instant (${r.durationMs}ms)`);
  }
});

test('spring gains no energy (overshoot stays bounded for the shipped presets)', () => {
  for (const name of Object.keys(PRESETS)) {
    const r = simulateSpring(0, 100, 0, PRESETS[name]);
    const maxX = Math.max(...r.samples.map((s) => s.x));
    // The shipped presets are near-critically damped: tiny overshoot is
    // fine, oscillation growth is not.
    assert.ok(maxX < 110, `${name}: overshoot ${maxX} exceeds 10%`);
    // And the tail must decay: the last quarter of samples all near target.
    const tail = r.samples.slice(Math.floor(r.samples.length * 0.75));
    for (const s of tail) {
      assert.ok(Math.abs(s.x - 100) < 5, `${name}: tail sample ${s.x} not settled`);
    }
  }
});

test('velocity seeding shifts the trajectory (a flicked release moves faster early)', () => {
  const still = simulateSpring(0, 100, 0, PRESETS.default);
  const flicked = simulateSpring(0, 100, 1.5, PRESETS.default); // 1.5 px/ms toward target
  const at = (r, t) => r.samples[Math.min(t, r.samples.length - 1)].x;
  assert.ok(
    at(flicked, 60) > at(still, 60),
    `flicked spring should lead at 60ms (${at(flicked, 60)} vs ${at(still, 60)})`
  );
  // Both still settle on the same target.
  assert.ok(Math.abs(flicked.x - 100) < physics.REST_DELTA);
});

test('springStep integrates with fixed-timestep semantics (many small steps ≈ simulate)', () => {
  const state = { x: 0, v: 0 };
  for (let t = 0; t < 500; t++) springStep(state, 100, PRESETS.default, 1);
  const ref = simulateSpring(0, 100, 0, PRESETS.default);
  const refAt500 = ref.samples[Math.min(500, ref.samples.length - 1)].x;
  assert.ok(Math.abs(state.x - refAt500) < 0.001, `${state.x} vs ${refAt500}`);
});

// ── Momentum projection ────────────────────────────────────────────────

test('projectMomentum matches the closed form and degenerates to position at v=0', () => {
  // v * decel / (1 - decel): 1 px/ms at 0.998 → +499 px
  assert.ok(Math.abs(projectMomentum(0, 1) - 499) < 1e-9);
  assert.equal(projectMomentum(-40, 0), -40);
  // Direction-preserving
  assert.ok(projectMomentum(0, -1) < 0);
  // Custom decel rate
  assert.equal(projectMomentum(0, 1, 0.5), 1);
  assert.equal(DECEL_RATE, 0.998);
});

test('projectDisplacement is the bounded closed form and defaults to the 120ms commit horizon', () => {
  assert.equal(physics.COMMIT_HORIZON_MS, 120);
  // Explicit horizon: position + v * horizon
  assert.equal(projectDisplacement(0, 1, 100), 100);
  assert.equal(projectDisplacement(50, -0.5, 40), 30);
  // Default horizon: the 120ms commit window (x + v·0.12s, issue #690)
  assert.equal(projectDisplacement(-40, -1), -160);
  // Degenerates to position at v=0
  assert.equal(projectDisplacement(-40, 0, 500), -40);
});

// ── Release decisions (the fidelity requirements, as math) ─────────────

test('swipe release: a short fast flick commits even far from the commit distance', () => {
  // Finger travelled only 40px of a 360px row, but the flick projects
  // well past 60% of the row width.
  const d = decideSwipeRelease({ x: -40, v: -1.5, trayWidth: 160, rowWidth: 360, canCommit: true });
  assert.equal(d, 'commit');
});

test('swipe release: dragging past the line then back before release does NOT commit', () => {
  // Position is past 60% of the row (-230 < -216) but the finger was
  // moving back toward closed at release: the commit is cancelled. With
  // the bounded 120ms horizon the projected landing (-170) is still past
  // the tray, so the row settles OPEN — matching iOS, where drifting back
  // off the delete cue keeps the actions revealed. (The old full-coast
  // projection overshot all the way to 'close'.)
  const d = decideSwipeRelease({ x: -230, v: 0.5, trayWidth: 160, rowWidth: 360, canCommit: true });
  assert.equal(d, 'open');
  // Drifting back harder projects past the tray line and closes.
  const d2 = decideSwipeRelease({ x: -230, v: 1.5, trayWidth: 160, rowWidth: 360, canCommit: true });
  assert.equal(d2, 'close');
});

test('swipe release: issue #690 benchmark — a fast 70px flick opens a 204px tray', () => {
  // 70px travelled at 1.2 px/ms projects to -214, past half the tray.
  assert.equal(
    decideSwipeRelease({ x: -70, v: -1.2, trayWidth: 204, rowWidth: 375, canCommit: false }),
    'open'
  );
  // Drifting back from just past the tray cancels (projected -50 > -102).
  assert.equal(
    decideSwipeRelease({ x: -110, v: 0.5, trayWidth: 204, rowWidth: 375, canCommit: false }),
    'close'
  );
});

test('release decisions honor an explicit horizon override', () => {
  // 30px pulled at 0.5 px/ms: 120ms horizon projects to 90 (commit)…
  assert.equal(decidePtrRelease({ pull: 30, v: 0.5, threshold: 70 }), true);
  // …a 40ms horizon only reaches 50 (no commit).
  assert.equal(decidePtrRelease({ pull: 30, v: 0.5, threshold: 70, horizonMs: 40 }), false);
  assert.equal(
    decideSwipeRelease({ x: -70, v: -1.2, trayWidth: 204, rowWidth: 375, canCommit: false, horizonMs: 10 }),
    'close'
  );
});

test('swipe release: a slow reveal past half the tray opens; a shallow one closes', () => {
  assert.equal(
    decideSwipeRelease({ x: -90, v: 0, trayWidth: 160, rowWidth: 360, canCommit: true }),
    'open'
  );
  assert.equal(
    decideSwipeRelease({ x: -30, v: 0, trayWidth: 160, rowWidth: 360, canCommit: true }),
    'close'
  );
});

test('swipe release: without a destructive full-swipe action, commit never fires', () => {
  const d = decideSwipeRelease({ x: -300, v: -3, trayWidth: 160, rowWidth: 360, canCommit: false });
  assert.equal(d, 'open');
});

test('PTR release: commits on distance, commits on velocity, cancels on neither', () => {
  assert.equal(decidePtrRelease({ pull: 80, v: 0, threshold: 70 }), true);
  // Only 30px pulled but yanked at 0.5 px/ms → projected past threshold.
  assert.equal(decidePtrRelease({ pull: 30, v: 0.5, threshold: 70 }), true);
  assert.equal(decidePtrRelease({ pull: 30, v: 0, threshold: 70 }), false);
  // Moving back up at release: projection reduces, still under.
  assert.equal(decidePtrRelease({ pull: 60, v: -0.5, threshold: 70 }), false);
});

test('sheet release: flick dismisses, deep drag dismisses, shallow drag cancels', () => {
  // Fast flick from a shallow position projects past half the sheet.
  assert.equal(decideSheetRelease({ y: 60, v: 1.4, sheetHeight: 400 }), true);
  // Deep slow drag past half the sheet dismisses on distance alone.
  assert.equal(decideSheetRelease({ y: 260, v: 0, sheetHeight: 400 }), true);
  // Shallow drag with no momentum cancels.
  assert.equal(decideSheetRelease({ y: 80, v: 0, sheetHeight: 400 }), false);
  // Past the line but drifting back UP at release: cancels.
  assert.equal(decideSheetRelease({ y: 230, v: -1, sheetHeight: 400 }), false);
});

// ── Keyboard occlusion (issue #719) ────────────────────────────────────

test('keyboardInset: iOS overlay keyboard returns the occluded height', () => {
  // iPhone-ish: layout viewport 844px, keyboard shrinks the visual
  // viewport to 508px while overlaying the layout viewport.
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 0, vvScale: 1 }),
    336
  );
  // A scrolled visual viewport (offsetTop) reduces the occluded strip.
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 100, vvScale: 1 }),
    236
  );
  // Fractional viewport metrics round to integer px.
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 507.7, vvOffsetTop: 0, vvScale: 1 }),
    336
  );
});

test('keyboardInset: Android resize mode (innerHeight tracks the vv) returns 0', () => {
  // The layout viewport shrank with the keyboard — fixed bottom:0
  // already sits above it, so no extra inset (no double compensation).
  assert.equal(
    keyboardInset({ innerHeight: 508, vvHeight: 508, vvOffsetTop: 0, vvScale: 1 }),
    0
  );
});

test('keyboardInset: sub-threshold noise (URL-bar transients) returns 0', () => {
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 804, vvOffsetTop: 0, vvScale: 1 }),
    0
  );
  // Exactly at the threshold counts as a keyboard.
  assert.equal(
    keyboardInset({
      innerHeight: 844,
      vvHeight: 844 - physics.KB_MIN_INSET,
      vvOffsetTop: 0,
      vvScale: 1,
    }),
    physics.KB_MIN_INSET
  );
});

test('keyboardInset: pinch zoom forces 0 (a zoomed viewport is not a keyboard)', () => {
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 422, vvOffsetTop: 0, vvScale: 2 }),
    0
  );
  // Missing scale is treated as unzoomed.
  assert.equal(keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 0 }), 336);
});

test('keyboardInset: negative occlusion clamps to 0', () => {
  assert.equal(
    keyboardInset({ innerHeight: 508, vvHeight: 844, vvOffsetTop: 0, vvScale: 1 }),
    0
  );
});

test('keyboardInset: explicit minInset override is honored, degenerate input is 0', () => {
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 804, vvOffsetTop: 0, vvScale: 1, minInset: 20 }),
    40
  );
  assert.equal(keyboardInset(null), 0);
  assert.equal(keyboardInset(undefined), 0);
});

// ── Keyboard-avoidance reveal math ─────────────────────────────────────
// bottomLimit = innerHeight - inset - margin; topLimit is passed final
// (the caller adds its own margin, e.g. navbar bottom + margin).

test('revealScrollDelta: field under the keyboard scrolls down by the overlap', () => {
  // iPhone-ish: 844 viewport, 336 keyboard, 8 margin → bottomLimit 500.
  assert.equal(
    revealScrollDelta({
      fieldTop: 600, fieldBottom: 640, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    140
  );
});

test('revealScrollDelta: field above the top limit scrolls up (negative delta)', () => {
  assert.equal(
    revealScrollDelta({
      fieldTop: 20, fieldBottom: 60, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    -32
  );
});

test('revealScrollDelta: an already-visible field does not move (minimal motion)', () => {
  // scrollIntoView would count a field under the padding as visible; this
  // is the corrected math — inside [topLimit, bottomLimit] means delta 0.
  assert.equal(
    revealScrollDelta({
      fieldTop: 100, fieldBottom: 140, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    0
  );
  // Exactly at the limits is visible too.
  assert.equal(
    revealScrollDelta({
      fieldTop: 52, fieldBottom: 500, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    0
  );
});

test('revealScrollDelta: a field taller than the visible strip keeps its top visible', () => {
  // Strip is [52, 500]; a 600px-tall field can't fit — the clamp caps the
  // downward scroll so fieldTop lands at topLimit, never past it.
  assert.equal(
    revealScrollDelta({
      fieldTop: 300, fieldBottom: 900, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    248 // fieldTop 300 - topLimit 52, NOT fieldBottom 900 - bottomLimit 500
  );
  // Tall field whose top is already at the limit: no motion at all.
  assert.equal(
    revealScrollDelta({
      fieldTop: 52, fieldBottom: 900, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    0
  );
});

test('revealScrollDelta: inset 0 degenerates to plain viewport math', () => {
  // Resize-mode Android / hardware keyboard: innerHeight already shrank,
  // so bottomLimit = innerHeight - margin is correct as-is.
  assert.equal(
    revealScrollDelta({
      fieldTop: 460, fieldBottom: 520, innerHeight: 508, inset: 0, margin: 8, topLimit: 8,
    }),
    20
  );
  assert.equal(revealScrollDelta(null), 0);
  assert.equal(revealScrollDelta(undefined), 0);
});

// ── Keyboard-avoidance text-entry allowlist ────────────────────────────

test('isTextEntryField: text-keyboard input types are intercepted', () => {
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number']) {
    assert.equal(isTextEntryField({ tag: 'input', type }), true, type);
  }
  assert.equal(isTextEntryField({ tag: 'textarea' }), true);
  assert.equal(isTextEntryField({ tag: 'div', contentEditable: true }), true);
  // Missing/unknown types default to text (the HTML default).
  assert.equal(isTextEntryField({ tag: 'input' }), true);
  assert.equal(isTextEntryField({ tag: 'input', type: 'made-up-type' }), true);
  // Case-insensitive, like the DOM.
  assert.equal(isTextEntryField({ tag: 'INPUT', type: 'Text' }), true);
});

test('isTextEntryField: non-text controls keep native taps', () => {
  for (const type of [
    'checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit',
    'reset', 'image', 'hidden', 'date', 'time', 'month', 'week', 'datetime-local',
  ]) {
    assert.equal(isTextEntryField({ tag: 'input', type }), false, type);
  }
  assert.equal(isTextEntryField({ tag: 'select' }), false);
  assert.equal(isTextEntryField({ tag: 'button' }), false);
  assert.equal(isTextEntryField({ tag: 'div' }), false);
});

test('isTextEntryField: disabled / readonly fields are never intercepted', () => {
  assert.equal(isTextEntryField({ tag: 'input', type: 'text', disabled: true }), false);
  assert.equal(isTextEntryField({ tag: 'input', type: 'text', readOnly: true }), false);
  assert.equal(isTextEntryField({ tag: 'textarea', readOnly: true }), false);
  assert.equal(isTextEntryField({ tag: 'div', contentEditable: true, disabled: true }), false);
  assert.equal(isTextEntryField(null), false);
  assert.equal(isTextEntryField(undefined), false);
});

// ── Gesture arbiter ────────────────────────────────────────────────────

test('gesture arbiter: first claim wins, owner re-claim is idempotent, release frees', () => {
  const a = createArbiter();
  const swipe = {};
  const ptr = {};
  assert.equal(a.claim('touch', swipe), true);
  assert.equal(a.claim('touch', ptr), false, 'second claimant must lose');
  assert.equal(a.claim('touch', swipe), true, 'owner re-claim is idempotent');
  assert.equal(a.owner('touch'), swipe);
  a.release('touch');
  assert.equal(a.owner('touch'), null);
  assert.equal(a.claim('touch', ptr), true, 'released sequence is claimable again');
  // Sequences are independent.
  assert.equal(a.claim(7, swipe), true);
  assert.equal(a.owner(7), swipe);
  assert.equal(a.owner('touch'), ptr);
  // Degenerate input never claims.
  assert.equal(a.claim(null, swipe), false);
  assert.equal(a.claim('touch', null), false);
});

// ── Velocity estimator ─────────────────────────────────────────────────

test('estimateVelocity computes px/ms over the sample window', () => {
  const samples = [];
  for (let i = 0; i <= 5; i++) samples.push({ t: i * 16, x: i * 10 }); // 10px / 16ms
  const v = estimateVelocity(samples);
  assert.ok(Math.abs(v - 10 / 16) < 1e-9, `got ${v}`);
});

test('estimateVelocity ignores samples older than the window', () => {
  // Ancient fast movement, then holding still for the last 100ms.
  const samples = [
    { t: 0, x: 0 },
    { t: 10, x: 200 },
    { t: 500, x: 200 },
    { t: 590, x: 200 },
  ];
  assert.equal(estimateVelocity(samples, 100), 0);
});

test('estimateVelocity decays to zero across a held-still dwell before release', () => {
  // A fast drag, then the finger holds still for 250ms; the gesture
  // handlers push a final sample stamped at the release moment, which
  // pushes all the movement samples out of the window.
  const samples = [
    { t: 0, x: 0 },
    { t: 16, x: -20 },
    { t: 32, x: -40 },
    { t: 48, x: -60 },
    { t: 48 + 250, x: -60 }, // release-time sample after the dwell
  ];
  assert.equal(estimateVelocity(samples, 100), 0);
});

test('estimateVelocity handles degenerate input', () => {
  assert.equal(estimateVelocity([], 100), 0);
  assert.equal(estimateVelocity([{ t: 0, x: 5 }], 100), 0);
  assert.equal(estimateVelocity(null, 100), 0);
});

// ── Intent lock ────────────────────────────────────────────────────────

test('lockIntent stays null under the threshold, then picks the dominant axis', () => {
  assert.equal(lockIntent(4, 4), null);
  assert.equal(lockIntent(-9, 3), null);
  assert.equal(lockIntent(-14, 3), 'x');
  assert.equal(lockIntent(3, 18), 'y');
  // Custom threshold
  assert.equal(lockIntent(6, 1, 5), 'x');
});

// ── Rubber band ────────────────────────────────────────────────────────

test('rubberband is monotonic, sign-preserving and bounded by the limit', () => {
  let prev = 0;
  for (let d = 10; d <= 2000; d += 10) {
    const out = rubberband(d, 150, 0.4);
    assert.ok(out > prev, 'must be monotonic');
    assert.ok(out < 150, `must stay under the limit (got ${out})`);
    prev = out;
  }
  assert.ok(rubberband(-100, 150, 0.4) < 0, 'sign-preserving');
  assert.equal(rubberband(0, 150, 0.4), 0);
});

test('rubberband initial slope approximates the coefficient', () => {
  const out = rubberband(1, 150, 0.4);
  assert.ok(Math.abs(out - 0.4) < 0.01, `slope near 0.4 at origin, got ${out}`);
});

test('rubberbandInvert round-trips (mid-settle grab re-enters the drag without a jump)', () => {
  for (const d of [5, 40, 90, 300, 1200]) {
    const display = rubberband(d, 150, 0.4);
    const back = rubberbandInvert(display, 150, 0.4);
    assert.ok(Math.abs(back - d) < 0.01, `roundtrip ${d} → ${display} → ${back}`);
  }
});

// ── Reorder hit-testing ────────────────────────────────────────────────

// Three 40px rows starting at y=100, packed tight.
const packed = [
  { top: 100, bottom: 140 },
  { top: 140, bottom: 180 },
  { top: 180, bottom: 220 },
];

test('reorderDropIndex: inside an item, the midpoint splits before/after', () => {
  assert.equal(reorderDropIndex(110, packed), 0, 'above first midpoint → gap 0');
  assert.equal(reorderDropIndex(130, packed), 1, 'below first midpoint → gap 1');
  assert.equal(reorderDropIndex(159, packed), 1);
  assert.equal(reorderDropIndex(161, packed), 2);
  assert.equal(reorderDropIndex(215, packed), 3, 'bottom half of the last row → append');
});

test('reorderDropIndex: outside the list snaps to the first/last gap', () => {
  assert.equal(reorderDropIndex(20, packed), 0, 'far above → insert at top');
  assert.equal(reorderDropIndex(900, packed), 3, 'far below → append');
});

test('reorderDropIndex: a section header / deadspace snaps to the NEAREST gap', () => {
  // Two sections with a 60px header band between them (rows 0-1, rows 2-3).
  const sectioned = [
    { top: 100, bottom: 140 },
    { top: 140, bottom: 180 },
    { top: 240, bottom: 280 }, // section 2, after a 60px header/deadspace
    { top: 280, bottom: 320 },
  ];
  // Hovering the header band (y 180..240): the nearest gap is 2 in the
  // lower half — "insert at the top of that section", never "append".
  assert.equal(reorderDropIndex(235, sectioned), 2);
  assert.equal(reorderDropIndex(212, sectioned), 2, 'past the band midpoint → section top');
  // The very start of the band is closer to gap 2's boundary too (the gap
  // midpoint is 210, so everything above it maps to the same gap index),
  // but a y right at the last row of section 1 stays with it.
  assert.equal(reorderDropIndex(175, sectioned), 2, 'bottom half of row 1 → after it');
});

test('reorderDropIndex: degenerate input', () => {
  assert.equal(reorderDropIndex(50, []), 0);
  assert.equal(reorderDropIndex(50, null), 0);
});

// ── Grid reorder drop side (attachReorder grid mode) ───────────────────

test('gridDropSide: a tile sharing its row splits at the horizontal midpoint', () => {
  // 100px-wide tile at x 200..300 in a 1000px list (multi-column).
  const tile = { left: 200, top: 100, width: 100, height: 120 };
  assert.equal(gridDropSide(tile, 1000, 240, 160), 'before', 'left half → before');
  assert.equal(gridDropSide(tile, 1000, 260, 160), 'after', 'right half → after');
  // The y coordinate is irrelevant for multi-column tiles — top-right
  // still reads as "after", bottom-left as "before".
  assert.equal(gridDropSide(tile, 1000, 290, 101), 'after');
  assert.equal(gridDropSide(tile, 1000, 210, 219), 'before');
});

test('gridDropSide: a full-width tile splits at the vertical midpoint', () => {
  // Tile spanning (almost) the whole list — single-column layout.
  const row = { left: 0, top: 100, width: 960, height: 80 };
  assert.equal(gridDropSide(row, 1000, 480, 120), 'before', 'top half → before');
  assert.equal(gridDropSide(row, 1000, 480, 170), 'after', 'bottom half → after');
  // x is irrelevant for full-width rows.
  assert.equal(gridDropSide(row, 1000, 950, 110), 'before');
  assert.equal(gridDropSide(row, 1000, 10, 175), 'after');
});

test('gridDropSide: the ~90% width threshold separates the two regimes', () => {
  // 89% of the list width → still a row-sharing tile (x decides)…
  const narrow = { left: 0, top: 0, width: 890, height: 100 };
  assert.equal(gridDropSide(narrow, 1000, 300, 90), 'before', 'x-left wins despite bottom y');
  // …while 90%+ is treated as full-width (y decides).
  const wide = { left: 0, top: 0, width: 900, height: 100 };
  assert.equal(gridDropSide(wide, 1000, 300, 90), 'after', 'bottom y wins despite left x');
});

// ── Reorder edge auto-scroll ───────────────────────────────────────────

test('autoScrollVelocity: zero outside the edge band, ramps to ±max at the edge', () => {
  // Viewport 0..800, 48px band, 14px/frame max.
  assert.equal(autoScrollVelocity(400, 0, 800, 48, 14), 0, 'mid-viewport → no scroll');
  assert.equal(autoScrollVelocity(48, 0, 800, 48, 14), 0, 'band boundary → still zero');
  // Inside the top band: negative (scroll up), growing toward the edge.
  const shallow = autoScrollVelocity(40, 0, 800, 48, 14);
  const deep = autoScrollVelocity(8, 0, 800, 48, 14);
  assert.ok(shallow < 0 && deep < shallow, `ramps up: ${shallow} vs ${deep}`);
  assert.equal(autoScrollVelocity(0, 0, 800, 48, 14), -14, 'top edge → -max');
  assert.equal(autoScrollVelocity(-50, 0, 800, 48, 14), -14, 'past the edge → clamped');
  // Bottom band mirrors with positive velocity.
  assert.ok(autoScrollVelocity(770, 0, 800, 48, 14) > 0);
  assert.equal(autoScrollVelocity(800, 0, 800, 48, 14), 14);
  assert.equal(autoScrollVelocity(900, 0, 800, 48, 14), 14, 'past the bottom → clamped');
});

test('autoScrollVelocity: defaults and degenerate band', () => {
  // Defaults: 48px band, 14px/frame.
  assert.equal(autoScrollVelocity(0, 0, 800), -14);
  assert.equal(autoScrollVelocity(400, 0, 800), 0);
  assert.equal(autoScrollVelocity(0, 0, 800, 0, 14), 0, 'zero-width band never scrolls');
});

// ── Reorder vs swipe arbitration ───────────────────────────────────────

test('gesture arbiter: a reorder claim loses to an earlier swipe claim and vice versa', () => {
  const a = createArbiter();
  const swipe = { swipe: true };
  const reorder = { reorder: true };
  // Swipe locks the x axis first: the long-press lift must back off.
  assert.equal(a.claim('touch', swipe), true);
  assert.equal(a.claim('touch', reorder), false, 'reorder lift must abort');
  a.release('touch');
  // Reorder lifts first: a later swipe x-lock on the same finger loses.
  assert.equal(a.claim('touch', reorder), true);
  assert.equal(a.claim('touch', swipe), false, 'swipe must back off mid-reorder');
});

// ── Toast slot state machine (priority / pending displacement) ─────────

test('toast slot: ordinary replaces visible ordinary (last-writer-wins)', () => {
  const slot = createToastSlot();
  const a = { priority: false };
  const b = { priority: false };
  assert.deepEqual(slot.show(a), { display: 'replace', closed: [] });
  const r = slot.show(b);
  assert.equal(r.display, 'replace');
  assert.deepEqual(r.closed, [a]);
  assert.equal(slot.current(), b);
  assert.equal(slot.pending(), null);
});

test('toast slot: ordinary queues behind a visible priority toast', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const saved = { priority: false };
  slot.show(undo);
  const r = slot.show(saved);
  assert.equal(r.display, 'queue');
  assert.deepEqual(r.closed, []);
  assert.equal(slot.current(), undo, 'the priority toast keeps the visible slot');
  assert.equal(slot.pending(), saved);
});

test('toast slot: a second queued ordinary replaces the first pending (depth stays 1)', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const first = { priority: false };
  const second = { priority: false };
  slot.show(undo);
  slot.show(first);
  const r = slot.show(second);
  assert.equal(r.display, 'queue');
  assert.deepEqual(r.closed, [first], 'the dropped pending toast is reported closed');
  assert.equal(slot.pending(), second);
});

test('toast slot: priority replaces priority; the pending ordinary survives', () => {
  const slot = createToastSlot();
  const undo1 = { priority: true };
  const saved = { priority: false };
  const undo2 = { priority: true };
  slot.show(undo1);
  slot.show(saved);
  const r = slot.show(undo2);
  assert.equal(r.display, 'replace');
  assert.deepEqual(r.closed, [undo1]);
  assert.equal(slot.current(), undo2);
  assert.equal(slot.pending(), saved);
});

test('toast slot: priority replaces a visible ordinary toast', () => {
  const slot = createToastSlot();
  const saved = { priority: false };
  const undo = { priority: true };
  slot.show(saved);
  const r = slot.show(undo);
  assert.equal(r.display, 'replace');
  assert.deepEqual(r.closed, [saved]);
  assert.equal(slot.current(), undo);
});

test('toast slot: resolution promotes the pending toast exactly once', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const saved = { priority: false };
  slot.show(undo);
  slot.show(saved);
  assert.equal(slot.resolve(undo), saved);
  assert.equal(slot.current(), saved);
  assert.equal(slot.pending(), null);
  assert.equal(slot.resolve(undo), null, 'a stale resolve is a no-op');
  assert.equal(slot.current(), saved, 'a stale resolve must not clear the slot');
  assert.equal(slot.resolve(saved), null, 'nothing left to promote');
  assert.equal(slot.current(), null);
});

test('toast slot: cancelPending removes only the queued record', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const saved = { priority: false };
  slot.show(undo);
  slot.show(saved);
  assert.equal(slot.cancelPending(undo), false, 'the visible record is not pending');
  assert.equal(slot.cancelPending(saved), true);
  assert.equal(slot.pending(), null);
  assert.equal(slot.resolve(undo), null, 'a cancelled pending toast never promotes');
});

test('toast slot: every record ends exactly once across a mixed sequence', () => {
  // Drive the machine with a mixed priority/ordinary sequence and count
  // lifecycle ends per record: displaced (via show().closed) or resolved
  // (the visible slot ending). Exactly-once here is what guarantees the
  // DOM layer's exactly-once onClose.
  const slot = createToastSlot();
  const records = [];
  const ended = new Map();
  function mk(priority) {
    const r = { priority, id: records.length };
    records.push(r);
    ended.set(r, 0);
    return r;
  }
  function end(r) { ended.set(r, ended.get(r) + 1); }
  for (const p of [false, true, false, false, true, true, false]) {
    for (const c of slot.show(mk(p)).closed) end(c);
  }
  // Drain: resolve whatever is visible until the slot empties.
  let cur = slot.current();
  while (cur) { end(cur); cur = slot.resolve(cur); }
  for (const r of records) {
    assert.equal(ended.get(r), 1, `record ${r.id} ended ${ended.get(r)} times`);
  }
});
