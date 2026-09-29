'use strict';

// #1920: THE SHARED-AXIS LANE IS A FADE-*THROUGH*, NOT A CROSS-FADE.
//
// unNative.transition(fn, {type:'push'|'pop'}) has two lanes. iOS slides:
// the outgoing snapshot is opaque, sits at z-index 2 and travels off over
// the incoming one, so the two never blend however their opacity runs.
// Android and desktop deliberately do not slide — the block in native.css
// calls it "Material shared-axis fade-through" — and there nothing is
// stacked and nothing is opaque.
//
// Both halves used to run opacity across the WHOLE duration: old 1 -> 0 and
// new 0 -> 1, simultaneously. At the midpoint both snapshots sat near 0.5
// and painted on top of each other. Measured in Chromium with a red
// outgoing screen over a blue incoming one, sampled while paused:
//
//   t=40ms  #f8232a   old only
//   t=80ms  #e33955   BOTH
//   t=120ms #bf3f7f   BOTH
//   t=160ms #8d38aa   BOTH
//   t=200ms #4d22d4   BOTH
//
// Four of five frames carry both screens. On the app directory that is two
// grids of app chips ghosting through one another, which is what #1920
// reports on the back navigation out of browse-all-apps.
//
// Material's fade-through does not cross-fade: the outgoing surface leaves
// over roughly the first third and only then does the incoming one arrive,
// so the handoff passes through the container's own ground rather than
// through a mixture of the two surfaces. Same measurement, sequenced:
//
//   t=40ms  #ff7979   old only
//   t=80ms  #fff3f3   ground
//   t=120ms #c4c4ff   new only
//
// What this file pins is the sequencing itself — that on the fade lane the
// two opacity ramps do not overlap. It reads the keyframes rather than
// running them: the arithmetic below is the same one the browser does, and
// a unit test that needed a compositor would not run here.
//
// Run with: node --test tests/native-screen-transition-fade.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public/usernode-native/v1/native.css'), 'utf8'
);

/** The four fade keyframes, by name, as `{ offset -> opacity }`. */
function opacityStops(name) {
  const at = CSS.indexOf(`@keyframes ${name} {`);
  assert.ok(at > 0, `@keyframes ${name} must exist`);
  // Start INSIDE the block: the `@keyframes <name> {` header is itself a
  // `…{` and the scanner below would read it as a selector otherwise.
  const open = CSS.indexOf('{', at) + 1;
  const body = CSS.slice(open, CSS.indexOf('\n}', open));
  const stops = [];
  // Each block is `<selector> { … }`; a selector may list several offsets
  // (`35%, to`), and only the ones declaring opacity matter here.
  for (const m of body.matchAll(/([a-z0-9%,\s]+)\{([^}]*)\}/g)) {
    const decls = m[2];
    const op = /opacity:\s*([\d.]+)/.exec(decls);
    if (!op) continue;
    for (const raw of m[1].split(',')) {
      const key = raw.trim();
      if (!key) continue;
      const offset = key === 'from' ? 0
        : key === 'to' ? 1
          : /^([\d.]+)%$/.test(key) ? parseFloat(key) / 100
            : null;
      if (offset === null) continue;
      stops.push({ offset, opacity: parseFloat(op[1]) });
    }
  }
  assert.ok(stops.length >= 2, `${name} declares opacity at two or more offsets`);
  return stops.sort((a, b) => a.offset - b.offset);
}

/** Linear-interpolated opacity at `t` (0..1), as the compositor would. */
function opacityAt(stops, t) {
  if (t <= stops[0].offset) return stops[0].opacity;
  const last = stops[stops.length - 1];
  if (t >= last.offset) return last.opacity;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.offset) {
      const span = b.offset - a.offset;
      if (span === 0) return b.opacity;
      return a.opacity + (b.opacity - a.opacity) * ((t - a.offset) / span);
    }
  }
  return last.opacity;
}

// The two pairings native.css actually wires up on the fade lane.
const PAIRS = [
  { type: 'pop', out: 'un-vt-fade-down-out', in: 'un-vt-fade-in' },
  { type: 'push', out: 'un-vt-fade-out', in: 'un-vt-fade-up-in' },
];

test('the fade lane never shows both screens at once', () => {
  // The whole bug in one assertion. Two translucent snapshots that are both
  // meaningfully visible at the same instant composite into each other; the
  // ceiling is deliberately low, because "faint ghost" was the complaint.
  for (const pair of PAIRS) {
    const out = opacityStops(pair.out);
    const inc = opacityStops(pair.in);
    for (let step = 0; step <= 100; step++) {
      const t = step / 100;
      const a = opacityAt(out, t);
      const b = opacityAt(inc, t);
      assert.ok(Math.min(a, b) <= 0.02,
        `${pair.type}: at ${Math.round(t * 100)}% the outgoing screen is at `
        + `${a.toFixed(2)} and the incoming one at ${b.toFixed(2)} — both are `
        + 'painted, which is the cross-fade #1920 reports as overlapping chips');
    }
  }
});

test('each half still reaches its end state', () => {
  // Sequencing must not cost the animation its job: the outgoing screen has
  // to be gone by the end and the incoming one fully there.
  for (const pair of PAIRS) {
    const out = opacityStops(pair.out);
    const inc = opacityStops(pair.in);
    assert.equal(opacityAt(out, 0), 1, `${pair.type}: the outgoing screen starts visible`);
    assert.equal(opacityAt(out, 1), 0, `${pair.type}: the outgoing screen ends gone`);
    assert.equal(opacityAt(inc, 0), 0, `${pair.type}: the incoming screen starts absent`);
    assert.equal(opacityAt(inc, 1), 1, `${pair.type}: the incoming screen ends visible`);
  }
});

test('the outgoing half clears early enough to leave the incoming one room', () => {
  // A fade-through hands off in the first third. Pinning it loosely — the
  // exact crossover is a taste call, but a handoff late in the duration
  // leaves the incoming screen no time and reads as a cut.
  for (const pair of PAIRS) {
    const out = opacityStops(pair.out);
    let cleared = null;
    for (let step = 0; step <= 100; step++) {
      if (opacityAt(out, step / 100) <= 0.02) { cleared = step / 100; break; }
    }
    assert.ok(cleared !== null && cleared <= 0.5,
      `${pair.type}: the outgoing screen must be gone by the halfway point `
      + `(clears at ${cleared === null ? 'never' : Math.round(cleared * 100) + '%'})`);
  }
});

test('the iOS lane is untouched — it is stacked and opaque, so it may overlap', () => {
  // Guard against "fixing" the slide lane the same way. Its outgoing
  // snapshot is opaque at z-index 2 and travels off over the incoming one,
  // so there is no blending to remove, and sequencing it would introduce a
  // gap where neither screen is drawn.
  const ios = CSS.slice(CSS.indexOf('html.un-ios[data-un-vt="push"]'));
  const popOld = /html\.un-ios\[data-un-vt="pop"\]::view-transition-old\(root\) \{([^}]*)\}/.exec(ios);
  assert.ok(popOld, 'the iOS pop rule must exist');
  assert.match(popOld[1], /animation-name: un-vt-slide-out-right/,
    'iOS pop still slides its outgoing screen rather than fading it');
  assert.match(popOld[1], /z-index: 2/,
    'and keeps it above the incoming screen, which is why it may overlap');
});
