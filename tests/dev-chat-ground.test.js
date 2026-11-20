'use strict';

// THE LIFT SITS ON THE PLATFORM'S GROUND, AND ITS GROUNDS CLIMB IN BOTH
// THEMES.
//
// The three-layer lift (`.dc-lift`, `.dc-lift-strip`, `.dc-lift-session`; the
// `dc-` prefix is the retired dev chat's, which it was built for) gives
// Messages, a project's channel and a request's thread sheet their depth.
// It first did that with two opaque planes over the screen: #f5f5f7 on
// #ffffff in light, #131316 on #1c1c1e in dark. The comment it replaced said
// what that cost: "before this the whole screen sat on the bare wallpaper".
// The platform's ground (the cream, the three washes, the star) was covered
// by a flat white or a flat black. So the planes are glass, and the surface
// tokens the cards inside them fill with stay opaque.
//
// And the tokens had to be re-ordered for dark: --bg-secondary and
// --bg-primary ascend in light and DESCEND in dark, so the sheet built on
// them came out as the darkest thing on the screen. The grounds climb now,
// light mode is untouched, and no .dc- surface reads the raw tokens.
//
// Run with: node --test tests/dev-chat-ground.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');

const rule = (sel) => {
  const at = APP_CSS.indexOf(`${sel} {`);
  assert.ok(at > 0, `${sel} must exist`);
  return APP_CSS.slice(at, APP_CSS.indexOf('\n}', at));
};
const alphaOf = (decl) => {
  const m = /rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(decl);
  return m ? parseFloat(m[1]) : 1;
};

test('the two lift PLANES are glass; the surface tokens stay opaque', () => {
  // The distinction is the whole design. --dc-sheet is read by many rules as
  // an opaque INSET inside a card (chips, code blocks, the PR card's strip);
  // making that translucent would let every one of them see the card behind
  // it, which is a different change and a wrong one.
  for (const tok of ['--dc-strip:', '--dc-sheet:', '--dc-raised:']) {
    const decls = APP_CSS.match(new RegExp(`${tok}[^;]+;`, 'g')) || [];
    assert.ok(decls.length >= 2, `${tok} must be declared in both themes`);
    for (const d of decls) {
      assert.doesNotMatch(d, /rgba|transparent/,
        `${tok} is a SURFACE value and must stay opaque: ${d.trim()}`);
    }
  }
  for (const tok of ['--dc-strip-fill:', '--dc-sheet-fill:']) {
    const decls = APP_CSS.match(new RegExp(`${tok}[^;]+;`, 'g')) || [];
    assert.equal(decls.length, 2, `${tok} must be declared in both themes`);
    for (const d of decls) assert.match(d, /rgba\(/, `${tok} must be translucent: ${d.trim()}`);
  }
});

test('the sheet is denser than the strip — the ladder still reads', () => {
  // Transparency is not the point on its own: if both planes had the same
  // alpha the lift would flatten into one pane of glass and the session
  // header would stop reading as a layer above the transcript.
  const fills = (APP_CSS.match(/--dc-(strip|sheet)-fill:[^;]+;/g) || []);
  assert.equal(fills.length, 4);
  const strip = fills.filter((f) => f.includes('strip')).map(alphaOf);
  const sheet = fills.filter((f) => f.includes('sheet')).map(alphaOf);
  for (let i = 0; i < 2; i++) {
    assert.ok(sheet[i] > strip[i],
      `the sheet must be denser than the strip (${sheet[i]} vs ${strip[i]})`);
  }
});

test('both planes keep their fills and blur nothing, on every platform', () => {
  for (const [sel, fill] of [['.dc-lift-strip', '--dc-strip-fill'], ['.dc-lift-session', '--dc-sheet-fill']]) {
    const r = rule(sel);
    assert.match(r, new RegExp(`background-color: var\\(${fill}\\)`), `${sel} is its translucent plane`);
    // Still routed through the token, prefixed and not, so turning it back on
    // stays a one-line change.
    assert.match(r, /backdrop-filter: var\(--dc-frost\)/);
    assert.match(r, /-webkit-backdrop-filter: var\(--dc-frost\)/);
  }
  // No blur on any platform, and no fallback that swaps the planes for the
  // neutral #f5f5f7 / #ffffff on some of them: one colour scheme
  // (app.css "No glass, on any platform").
  assert.match(APP_CSS, /--dc-frost: none;/);
  assert.doesNotMatch(APP_CSS, /\.dc-lift-strip \{ background-color: var\(--dc-strip\); \}/);
  assert.doesNotMatch(APP_CSS, /\.dc-lift-session \{ background-color: var\(--dc-sheet\); \}/);
});

test('the lift takes the running app\'s radius, and neither layer clips', () => {
  // The lift is the move a running app makes, repeated per layer: a sheet
  // that rounds its top corners over the layer above (#app-frame-host). The
  // geometry is asked for BY CLASS, so the three cannot drift apart the way
  // hand-copied radii could.
  const lift = APP_CSS.slice(APP_CSS.indexOf('\n.dc-lift {'));
  const frame = APP_CSS.slice(APP_CSS.indexOf('\n#app-frame-host {'));
  const radius = (block) => (block.match(/border-start-start-radius: ([^;]+);/) || [])[1];
  assert.ok(radius(lift), '.dc-lift declares its radius');
  assert.equal(radius(lift), radius(frame),
    'the layers take the running app\'s radius, not one of their own');
  // A sheet's shoulder is the area INSIDE its border box and OUTSIDE its
  // arc, so `overflow: hidden` would remove exactly the thing this is for.
  assert.doesNotMatch(lift.slice(0, lift.indexOf('\n.dc-lift-strip')), /overflow: hidden/);
});

test('--bubble-bg is retired; --accent-ink is not', () => {
  // --bubble-bg existed only because --bg-primary IS the page ground in dark,
  // so a bubble drawn on it vanished. It had no other reader.
  assert.doesNotMatch(APP_CSS, /--bubble-bg\s*:/, 'the token is gone');
  assert.doesNotMatch(APP_CSS, /var\(--bubble-bg\)/, 'and so is every use');

  // --accent-ink STAYS. It is the near-black-on-light-accent pair, and
  // .messages-state button is still a real accent fill: retiring it would
  // take a live button's contrast with it.
  assert.match(APP_CSS, /--accent-ink: #ffffff;/);
  assert.match(APP_CSS, /--accent-ink: #0b0b0c;/);
  assert.match(rule('\n.messages-state button'), /color: var\(--accent-ink\)/);
});

test('the three GROUNDS ascend in both themes; the card only has to differ', () => {
  // The bug: --bg-secondary / --bg-primary ascend in light (#f5f5f7 →
  // #ffffff) and DESCEND in dark (#1c1c1e → #0b0b0c). The lift was built on
  // that pairing, so in dark the sheet came out as the darkest thing on the
  // screen: a near-black hole in the #0b0d1b wallpaper, with the strip above
  // it lighter than both. Measured before the fix: wallpaper (11,13,27) →
  // strip (28,28,30) → sheet (11,11,12).
  //
  // The GROUNDS are what must climb: each layer nearer the reader is lighter
  // than the one behind it, in both themes. A CARD is the other kind of
  // step (on white a grey inset, on near-black a lighter raise), so its
  // direction flips by theme and only its DISTANCE from the sheet is the
  // invariant. Asserting "lighter" on it is what a first draft of this test
  // did, and light mode caught it.
  //
  // What climbs from the PAGE is what the planes paint on it, the `-solid`
  // colours (each plane's fill over the wallpaper's base): the strip is the
  // ground's own colour at a fraction of its alpha, so it never sinks below
  // the page, and the sheet over it is lighter again. The surface values
  // (--dc-strip, --dc-sheet) climb between themselves; neither is painted on
  // the page (the planes take their fills, asserted above). The light page
  // is the export's cream again (#fffeea, 98% luminance), which is lighter
  // than the neutral #f5f5f7 a card's inset takes, so the page is compared
  // with the planes that lie on it, not with that inset value.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const val = (block, name) => {
    const m = block.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
    assert.ok(m, `${name} must be declared`);
    return m[1];
  };
  const light = APP_CSS.slice(0, APP_CSS.indexOf('\n.dark {'));
  const dark = APP_CSS.slice(APP_CSS.indexOf('\n.dark {'));
  for (const [theme, block, ground] of [
    ['light', light, '#fffeea'],
    ['dark', dark, '#0b0d1b'],
  ]) {
    assert.ok(APP_CSS.includes(`--home-ground: ${ground};`), `${theme}: the wallpaper's ground is ${ground}`);
    const stripPlane = val(block, '--dc-strip-solid');
    const sheetPlane = val(block, '--dc-sheet-solid');
    assert.ok(lum(stripPlane) >= lum(ground),
      `${theme}: the strip (${stripPlane}) must not sink below the page (${ground})`);
    assert.ok(lum(sheetPlane) > lum(stripPlane),
      `${theme}: the sheet (${sheetPlane}) must be nearer the reader than the strip (${stripPlane})`);
    assert.ok(lum(val(block, '--dc-sheet')) > lum(val(block, '--dc-strip')),
      `${theme}: the sheet's surface value must be nearer the reader than the strip's`);
    const sheet = val(block, '--dc-sheet');
    const raised = val(block, '--dc-raised');
    assert.ok(Math.abs(lum(raised) - lum(sheet)) >= 8,
      `${theme}: a card (${raised}) must be visibly off the sheet (${sheet})`);
  }
});

test('light mode is byte-identical: only dark moved', () => {
  // The ladder's light values ARE the tokens the lift shipped with, so a
  // reader who liked light mode sees exactly what they saw.
  const light = APP_CSS.slice(0, APP_CSS.indexOf('\n.dark {'));
  assert.match(light, /--dc-strip: #f5f5f7;/, "--bg-secondary's value");
  assert.match(light, /--dc-sheet: #ffffff;/, "--bg-primary's value");
  assert.match(light, /--dc-raised: #f5f5f7;/, "--bg-secondary's value again");
});

test('no .dc- surface reads the raw surface tokens', () => {
  // The sweep this pins. Moving the sheet in dark left every OTHER card on
  // the lift sitting on the wrong step: a rule on --bg-secondary was flush
  // with the new sheet (both #1c1c1e) and one on --bg-primary was DARKER
  // than it (#0b0b0c), a hole rather than an inset.
  //
  // The swap is light-identical BY CONSTRUCTION, which is the only reason it
  // could be done mechanically: --dc-sheet is --bg-primary's light value and
  // --dc-raised is --bg-secondary's, asserted above.
  const rules = APP_CSS.split('}');
  const offenders = [];
  for (const r of rules) {
    const head = r.slice(0, r.indexOf('{'));
    if (!/\.dc-[a-z0-9-]/.test(head)) continue;
    if (/background(-color)?\s*:\s*var\(--bg-(primary|secondary)\)/.test(r)) {
      offenders.push(head.trim().split('\n').pop().trim());
    }
  }
  assert.deepEqual(offenders, [],
    'a .dc- surface must take the ladder, not the raw token');
});
