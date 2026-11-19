// Paper, the one look of the frame kept after 19 Nov 2026 (Glass, Pastel,
// Mosaic and Sunrise were removed that day; the file keeps the name it had
// when there were five), and what the design tour's refinement asked of it:
// readable faint and muted ink, an off switch that shows, about 40px to
// press on a phone. The source is frontend/looks/paper.css; app.css holds
// its compiled form (tests/looks-css.test.js holds the two together), and
// tests/glass-skin.test.js holds the retired looks to the standard design.
//
// Run with: node --test tests/looks-five.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const config = JSON.parse(read('frontend', 'looks', 'looks.json'));
const look = (id) => read('frontend', 'looks', `${id}.css`);
const css = read('public', 'css', 'app.css');
const compiled = css.slice(css.indexOf('/* looks:begin'), css.indexOf('/* looks:end */'));
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));

const FIVE = ['paper'];
const GONE = ['glass', 'pastel', 'mosaic', 'sunrise'];

// The tokens a look's root sets, light or dark.
function tokens(id, dark) {
  const m = look(id).match(dark ? /^\.hr\.dark\{([\s\S]*?)\}/m : /^\.hr\{([\s\S]*?)\}/m);
  assert.ok(m, `${id}: a ${dark ? 'dark' : 'light'} root rule`);
  const out = {};
  for (const d of m[1].matchAll(/--([a-z0-9-]+):([^;]+)/g)) out[d[1]] = d[2].trim();
  return out;
}

// WCAG 2 contrast of two opaque hex colours.
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  assert.match(h, /^[0-9a-f]{6}$/i, `${hex} is a plain hex colour`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('there is one look, Paper, with its own file, and nothing left of the others', () => {
  assert.deepEqual(config.order, FIVE);
  assert.deepEqual(Object.keys(config.looks), FIVE);
  const files = fs.readdirSync(path.join(ROOT, 'frontend', 'looks')).filter((f) => f.endsWith('.css')).sort();
  assert.deepEqual(files, [...FIVE, 'kit'].map((id) => `${id}.css`).sort(), 'the kit and one sheet per look, nothing left of the retired ones');
  for (const id of GONE) {
    assert.ok(!css.includes(`data-skin="${id}"`), `app.css has no rule for ${id}`);
    assert.equal(config.looks[id], undefined, `${id} is not in looks.json`);
  }
  // Every typeface under public/fonts that looks.json names is one a kept look uses.
  const used = new Set(FIVE.flatMap((id) => config.looks[id].faces));
  assert.deepEqual(Object.keys(config.fonts).sort(), [...used].sort());
  for (const dir of used) assert.ok(fs.existsSync(path.join(ROOT, 'public', 'fonts', dir)), `${dir} is served from our own origin`);
});

test('faint and muted ink reach WCAG AA on each look\'s surface, in light and dark', () => {
  for (const id of FIVE) {
    for (const dark of [false, true]) {
      const t = tokens(id, dark);
      // A see-through surface is read over the wallpaper: its opaque twin
      // (looks.json, the no-backdrop-filter fallback) stands for it.
      const surface = config.looks[id].opaque ? config.looks[id].opaque[dark ? 1 : 0] : t.surface;
      for (const ink of ['faint', 'mut']) {
        const ratio = contrast(t[ink], surface);
        assert.ok(ratio >= 4.5, `${id} ${dark ? 'dark' : 'light'}: --${ink} ${t[ink]} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('an off switch shows: its track is a tone of the ink, not the surface it stands on', () => {
  assert.match(look('paper'), /\.tog\{background:rgba\(20,21,31,\.2\);box-shadow:none\}\.dark \.tog\{background:rgba\(255,255,255,\.22\)\}/);
  // Settings' own switch wears it (looks.json: tog), so it reaches the one screen full of switches.
  assert.equal(config.wear.roots.tog.to, '.un-switch:is(#settings-root *)');
  assert.match(compiled, /html\[data-skin="paper"\] \.fr-tog,html\[data-skin="paper"\] \.un-switch:is\(#settings-root \*\)\{background:rgba\(20,21,31,\.2\);box-shadow:none\}/);
});

test('on a phone a round button and a small button are about 40px to press', () => {
  assert.match(look('paper'), /\.phone \.ib\{width:40px;height:40px\}/, 'a round button');
  assert.match(look('paper'), /\.phone \.btn\.sm\{height:40px;/, 'a small button');
  // A phone's tab-bar badge sits over the icon's corner, clear of the glyph.
  assert.match(look('paper'), /\.tb \.n\{top:-1px;left:calc\(50% \+ 8px\)/);
});

test('Paper: a control has its own tone, and the sidebar shows where you are', () => {
  const paper = look('paper');
  const light = tokens('paper', false);
  const dark = tokens('paper', true);
  for (const t of [light, dark]) for (const name of ['ctl', 'well', 'lift']) assert.ok(t[name], `--${name} is set`);
  assert.notEqual(dark.ctl, dark.surface, 'in dark a control on a panel is a raised tone, not the sheet\'s');
  assert.match(paper, /\.nv\.on\{background:var\(--ctl\);color:var\(--ink\);font-weight:650;box-shadow:var\(--lift\)\}/);
  assert.match(paper, /\.card \.btn\.quiet,\.card \.btn\.line\{background:var\(--ctl\);box-shadow:none\}/);
  assert.match(paper, /\.inp\{background:var\(--well\);border-radius:12px;box-shadow:none\}/, 'no leftover outline on a field');
  // What the shell says by hand for Paper follows the same tone.
  assert.match(hand, /html\[data-skin="paper"\] :is\(\.rf-run, \.rf-page-wrap\) \{ --rf-page: var\(--fr-sunk\); --rf-sheet: var\(--fr-sunk\); --rf-fill: var\(--fr-ctl\); --rf-cream: var\(--fr-ctl\); \}/);
  assert.doesNotMatch(hand, /html\[data-skin="paper"\][^{]*\{[^}]*background: var\(--fr-surface\)/);
});

test('the chrome draws one markup and branches on no look', () => {
  const chrome = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.doesNotMatch(chrome, /skin === '/, 'no branch on a look in the chrome');
  assert.match(chrome, /root\.style\.setProperty\('--fr-shell-left', `\$\{Math\.max\(0, Math\.round\(r\.left\)\)\}px`\);/, 'the screens start where the measured page area does, whatever the menu\'s width');
  for (const id of GONE) assert.doesNotMatch(hand, new RegExp(`data-skin="${id}"`), `no hand-written rule is left for ${id}`);
});

test('a page\'s tab fade stays in the page: the product\'s two-tab switches that wear the tabs keep their last tab whole', () => {
  for (const id of FIVE) {
    const block = compiled.slice(compiled.indexOf(`(data-skin="${id}")`));
    const own = block.slice(0, block.indexOf('\n/* ── THE ', 10) > 0 ? block.indexOf('\n/* ── THE ', 10) : block.length);
    for (const rule of own.split('\n').filter((line) => line.includes('mask-image') && line.includes('notifications-screen-tabs'))) {
      assert.match(rule, /\.fr-inner #notifications-screen-tabs/, `${id}: a mask reaches the bell's tabs only inside a kit page, where they never are`);
    }
  }
});
