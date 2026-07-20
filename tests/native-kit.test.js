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
  createArbiter,
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
