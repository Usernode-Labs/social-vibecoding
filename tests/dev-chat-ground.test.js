'use strict';

// THE SESSION SITS ON THE PLATFORM'S GROUND, AND YOUR TURN IS TELLABLE FROM
// THE AGENT'S. Two regressions from the transcript work, reported together
// because one change caused both.
//
// The three-layer lift gave the dev chat depth by putting two opaque planes
// over it — #f5f5f7 on #ffffff in light, #131316 on #1c1c1e in dark. The
// comment it replaced said what that cost: "before this the whole screen sat
// on the bare wallpaper". The platform's ground (the cream, the three washes,
// the star) was covered by a flat white or a flat black across the entire
// session, on the one route where the wallpaper had always been the page.
//
// The same pass filled the user's message with --dc-raised, which is the
// token the coding-run card, the PR card and the stopped card also use, and
// removed the visible "You" label on the argument that "side and surface
// already say whose turn it is". Neither did: the fill was identical, and
// `.dc-msg`'s 92% cap makes a message of any length indistinguishable from
// full width, so `margin-left: auto` had nothing to push against.
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

test('both planes blur their backdrop, and fall back to opaque without it', () => {
  for (const sel of ['.dc-lift-strip', '.dc-lift-session']) {
    const r = rule(sel);
    assert.match(r, /backdrop-filter: var\(--dc-frost\)/);
    // Safari has shipped the filter under the prefix for years and still
    // needs it; dropping it turns the glass into an unblurred wash there.
    assert.match(r, /-webkit-backdrop-filter: var\(--dc-frost\)/);
  }
  assert.match(APP_CSS, /--dc-frost: blur\(\d+px\)/);
  // Without the blur the star and the washes sit UNBLURRED behind body text,
  // which is worse than the flat surface this replaced. The effect depends on
  // the blur, so the unsupported path takes the opaque values back.
  const at = APP_CSS.indexOf('@supports not ((backdrop-filter');
  assert.ok(at > 0, 'the no-backdrop-filter fallback must exist');
  const block = APP_CSS.slice(at, APP_CSS.indexOf('\n}\n', at));
  assert.match(block, /\.dc-lift-strip \{ background-color: var\(--dc-strip\); \}/);
  assert.match(block, /\.dc-lift-session \{ background-color: var\(--dc-sheet\); \}/);
});

test('your message does not wear the agent cards\' fill', () => {
  const user = rule('.dc-msg-user');
  assert.doesNotMatch(user, /var\(--dc-raised\)/,
    'that is the token the coding-run, PR and stopped cards fill with');
  assert.match(user, /background: var\(--accent-tint\)/);

  // A TINT, not the fill that was retired here for contrast: white on the
  // accent is 3.93:1, which is why that fill needed --accent-ink and a whole
  // inverted vocabulary. At 8% the page's own ink still reads.
  const tint = (APP_CSS.match(/--accent-tint:[^;]+;/g) || []);
  assert.ok(tint.length >= 2);
  for (const d of tint) assert.ok(alphaOf(d) <= 0.2, `--accent-tint must stay a tint: ${d.trim()}`);
});

test('…and it leaves a gutter no agent row crosses', () => {
  const user = rule('.dc-msg-user');
  const m = /max-width: (\d+)%/.exec(user);
  assert.ok(m, '.dc-msg-user must cap its own width');
  const pct = Number(m[1]);
  const shared = /max-width: (\d+)%/.exec(rule('.dc-msg'));
  assert.ok(pct < Number(shared[1]),
    `92% is indistinguishable from full width; ${pct}% must be narrower`);
  assert.ok(pct <= 80, `${pct}% does not leave a legible gutter`);

  // The gutter only means anything because the agent's rows are full-bleed.
  // If a card ever took a max-width, the cue would go with it.
  for (const sel of ['.dc-failure', '.dc-pr-card']) {
    assert.doesNotMatch(rule(sel), /max-width/,
      `${sel} must stay full-bleed, or the gutter stops being a signal`);
  }
});
