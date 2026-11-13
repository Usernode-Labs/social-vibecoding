// The five looks kept on 12 Nov 2026 (Glass, Paper, Pastel, Mosaic, Sunrise)
// and what the design tour's refinement asked of them: readable faint and
// muted ink, an off switch that shows, about 40px to press on a phone, one
// frosted sheet, one gradient button a page, and the full left menu in
// Pastel and Mosaic. The sources are frontend/looks/<look>.css; app.css
// holds their compiled form (tests/looks-css.test.js holds the two
// together), and tests/glass-skin.test.js holds the four retired looks to
// the standard design.
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

const FIVE = ['glass', 'paper', 'pastel', 'mosaic', 'sunrise'];

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

test('there are five looks, in the tour\'s order, each with its own file', () => {
  assert.deepEqual(config.order, FIVE);
  assert.deepEqual(Object.keys(config.looks), FIVE);
  const files = fs.readdirSync(path.join(ROOT, 'frontend', 'looks')).filter((f) => f.endsWith('.css')).sort();
  assert.deepEqual(files, [...FIVE, 'kit'].map((id) => `${id}.css`).sort(), 'the kit and one sheet per look, nothing left of the retired four');
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
  assert.match(look('mosaic'), /\.tog:not\(\.on\)\{background:rgba\(30,34,70,\.2\);box-shadow:none\}\n\.dark \.tog:not\(\.on\)\{background:rgba\(255,255,255,\.22\)\}/);
  assert.match(look('sunrise'), /\.tog\{background:rgba\(23,24,47,\.16\);box-shadow:none\}\.dark \.tog\{background:rgba\(255,255,255,\.2\)\}/);
  // Settings' own switch wears it (looks.json: tog), so it reaches the one screen full of switches.
  assert.equal(config.wear.roots.tog.to, '.un-switch:is(#settings-root *)');
  assert.match(compiled, /html\[data-skin="paper"\] \.fr-tog,html\[data-skin="paper"\] \.un-switch:is\(#settings-root \*\)\{background:rgba\(20,21,31,\.2\);box-shadow:none\}/);
});

test('on a phone a tab, a round button and a small button are about 40px to press', () => {
  for (const id of ['glass', 'pastel', 'mosaic']) assert.match(look(id), /\.phone \.tab\{height:40px[;}]/, `${id}: a tab`);
  for (const id of ['glass', 'paper', 'pastel', 'sunrise']) assert.match(look(id), /\.phone \.ib\{width:40px;height:40px\}/, `${id}: a round button`);
  for (const id of ['glass', 'paper', 'pastel', 'mosaic']) assert.match(look(id), /\.phone \.btn\.sm\{height:40px;/, `${id}: a small button`);
  assert.match(look('sunrise'), /\.phone \.btn\.sm\{height:36px;/, 'Sunrise keeps 36px, its bar being the tightest');
  // A phone's tab-bar badge sits over the icon's corner, clear of the glyph.
  for (const id of ['glass', 'mosaic']) assert.match(look(id), /\.tb \.n\{top:-3px;left:calc\(50% \+ 5px\)/, `${id}: the badge`);
  assert.match(look('paper'), /\.tb \.n\{top:-1px;left:calc\(50% \+ 8px\)/);
  assert.match(look('pastel'), /\.phone \.tb \.n\{top:1px;left:calc\(50% \+ 5px\)/);
  assert.match(look('sunrise'), /\.tb \.n\{top:-4px;left:calc\(50% \+ 7px\)/);
});

test('Glass: a sheet is frosted, and nothing behind it is', () => {
  const glass = look('glass');
  assert.match(glass, /\.sheet\{border-radius:32px;background:color-mix\(in srgb,var\(--ground\) 80%,transparent\);backdrop-filter:blur\(34px\) saturate\(1\.5\)/);
  assert.doesNotMatch(glass, /\.ov\{[^}]*backdrop-filter/, 'a blurred scrim would be the sheet\'s backdrop root and leave the sheet unfrosted');
  assert.doesNotMatch(compiled, /html\[data-skin="glass"\] \.fr-ov\{[^}]*backdrop-filter/);
  // The tint is said in the rule: the page's ground is the product's, set on
  // <body>, so a token on <html> could not read it and the sheet would have no fill.
  assert.doesNotMatch(glass, /--sheet:/);
  assert.match(glass, /\.dark \.sheet\{background:color-mix\(in srgb,#14162a 78%,transparent\)\}/);
  // The product measures its page area, so the phone's capsule keeps its own row (the tour floats it over the page).
  assert.doesNotMatch(glass.replace(/\/\*[\s\S]*?\*\//g, ''), /\.pagearea/);
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

test('Pastel: a dark surface has a hairline', () => {
  const pastel = look('pastel');
  assert.match(pastel, /\.dark \.card\{box-shadow:inset 0 0 0 1px var\(--line2\)\}/);
  assert.match(pastel, /\.dark \.side,\.dark \.tab,[^{]*\.dark\.phone \.tabbar,[^{]*\{box-shadow:var\(--soft\),inset 0 0 0 1px var\(--line\)\}/);
  // The mock's dark phone root lands in the phone's media query, with .dark on <html>.
  assert.match(compiled, /@media \(max-width: 767\.98px\)\{\n(?:.*\n)*?html\[data-skin="pastel"\]\[data-skin\]\.dark \.fr-tabbar\{box-shadow:var\(--fr-soft\),inset 0 0 0 1px var\(--fr-line\)\}/);
});

test('Pastel and Mosaic draw the full left menu: a 256px column, the panel 12px in, Recents by name, You at the foot', () => {
  for (const id of ['pastel', 'mosaic']) {
    const sheet = look(id);
    assert.match(sheet, /\.app\{grid-template-columns:256px minmax\(0,1fr\)\}/, `${id}: the menu's column`);
    assert.match(sheet, /\.side\{margin:12px 0 12px 12px;/, `${id}: a panel 12px in from the window`);
    assert.match(sheet, /\.sidefoot\{border-top:1px solid var\(--line2?\);padding-top:8px\}/, `${id}: You under a line at the foot`);
    assert.doesNotMatch(sheet, /\.nv\.rec \.nm\{display:none\}|\.side \.cap,\.side \.nv\.rec\{display:none\}|\.brand \.bn\{display:none\}/, `${id}: the brand's name, the Recents label and each community's name are drawn`);
    assert.doesNotMatch(sheet, /grid-template-rows/, `${id}: no top row for a capsule`);
    assert.ok(compiled.includes(`html[data-skin="${id}"] .fr-app{grid-template-columns:256px minmax(0,1fr)}`));
  }
  assert.match(look('pastel'), /\.side\{[^}]*border-radius:28px;background:var\(--surface\);box-shadow:var\(--soft\)\}/, 'Pastel: a rounded white panel');
  assert.match(look('mosaic'), /\.side\{[^}]*border-radius:24px;background:var\(--surface\);backdrop-filter:blur\(24px\) saturate\(1\.4\)/, 'Mosaic: a glass panel');
  // The chrome draws the same markup for every look (brand, the three places, Recents, All, You): the look only lays it out.
  const chrome = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.doesNotMatch(chrome, /skin === '|isFrameSkin\(skin\) &&[^\n]*(pastel|mosaic)/, 'no branch on a look in the chrome');
  assert.match(chrome, /root\.style\.setProperty\('--fr-shell-left', `\$\{Math\.max\(0, Math\.round\(r\.left\)\)\}px`\);/, 'the screens start where the measured page area does, whatever the menu\'s width');
  // Pastel's capsule needed the layer offset and its bar un-margined; with a left panel it is every look's rule.
  assert.doesNotMatch(hand, /data-skin="pastel"\] \.fr\.fr-app\.fr-shell|data-skin="pastel"\] \.fr\.fr-shell \.fr-bar/);
  assert.doesNotMatch(hand, /:not\(\[data-skin="pastel"\]\)/);
});

test('Sunrise: one gradient button a page', () => {
  const sunrise = look('sunrise');
  assert.match(sunrise, /\.btn\{background:var\(--grad\);color:#17182f;font-weight:700;box-shadow:var\(--glow\)\}/);
  assert.match(sunrise, /\.bar \.btn:not\(\.quiet\):not\(\.line\)\{background:var\(--ink\);color:var\(--surface\);box-shadow:none\}/, 'the bar\'s button is ink, so the page\'s own is the one gradient');
  assert.match(sunrise, /\.btn\.line\{background:var\(--surface\);/);
});

test('a page\'s tab fade stays in the page: the product\'s two-tab switches that wear the tabs keep their last tab whole', () => {
  assert.match(look('mosaic'), /\n\.inner \.tabs\{-webkit-mask-image:linear-gradient\(90deg,#000 calc\(100% - 32px\),transparent\)/);
  assert.match(look('sunrise'), /\n\.phone \.inner \.tabs\{-webkit-mask-image:linear-gradient\(90deg,#000 calc\(100% - 40px\),transparent\)/);
  for (const id of FIVE) {
    const block = compiled.slice(compiled.indexOf(`(data-skin="${id}")`));
    const own = block.slice(0, block.indexOf('\n/* ── THE ', 10) > 0 ? block.indexOf('\n/* ── THE ', 10) : block.length);
    for (const rule of own.split('\n').filter((line) => line.includes('mask-image') && line.includes('notifications-screen-tabs'))) {
      assert.match(rule, /\.fr-inner #notifications-screen-tabs/, `${id}: a mask reaches the bell's tabs only inside a kit page, where they never are`);
    }
  }
});
