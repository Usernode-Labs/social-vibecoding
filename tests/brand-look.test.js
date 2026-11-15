// Tests for the brand look, "Paper, simplified, with brand styling": one of
// the Look menu's looks (Settings › Experimental › Look, an admin's
// preview). The head's window.Skin keeps the choice on the device and sets
// data-skin="brand" on <html> before first paint; app.css draws the look
// from that attribute, in light and in dark. It keeps the standard pages
// and redraws them in the website's colours and typefaces. Its rules are
// written once for both modes and read each mode's own colours.
//
// The id is the old New look's, whose own switch was removed on 13 Nov
// 2026: a device that had that switch on shows this look.
//
// Static-assertion style (cf. tests/accessibility-prefs.test.js), plus one
// run of the head module itself against a stub window, so the storage
// contract is pinned by behaviour rather than by spelling.
//
// Run with: node --test tests/brand-look.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const headSrc = () => read('frontend', 'src', 'head.html');
const settingsJs = () => read('frontend', 'src', 'features', 'settings', 'settings.js');
const experimentalSrc = () => read('frontend', 'src', 'features', 'settings', 'sections', 'experimental.tsx');

// The Skin module's own source: from its assignment to the end of its IIFE.
function skinModuleSrc() {
  const src = headSrc();
  const start = src.indexOf('window.Skin = (function () {');
  assert.ok(start > 0, 'head.html must assign window.Skin');
  const end = src.indexOf('}());', start);
  assert.ok(end > start, 'the Skin module is one IIFE');
  return src.slice(start, end + '}());'.length);
}

// Runs the module against a stub window/document. `stored` seeds storage;
// `broken` makes every storage call throw, as a locked-down browser does.
function runSkin({ stored = null, broken = false } = {}) {
  const store = new Map(stored === null ? [] : [['homeroom:skin', stored]]);
  const attrs = new Map();
  const listeners = [];
  const localStorage = {
    getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('blocked'); store.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('blocked'); store.delete(k); },
  };
  const window = {
    localStorage,
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const document = {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
    },
  };
  vm.runInNewContext(skinModuleSrc(), { window, document });
  return { Skin: window.Skin, store, attrs, listeners };
}

// ── The inline head module ───────────────────────────────────────────────

test('no look is on by default', () => {
  const { Skin, attrs } = runSkin();
  assert.equal(Skin.get(), 'standard');
  assert.equal(attrs.has('data-skin'), false, 'no stored choice: no data-skin on <html>');
});

test('a stored choice is on <html> as soon as the module runs', () => {
  // This is also what a device that had the old New look switch on holds.
  const { Skin, attrs } = runSkin({ stored: 'brand' });
  assert.equal(Skin.get(), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
});

test('set() stores the look and removes the key for the standard one', () => {
  const { Skin, store, attrs } = runSkin();
  let heard = 0;
  Skin.onChange(() => { heard += 1; });
  Skin.set('brand');
  assert.equal(store.get('homeroom:skin'), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false, 'the standard look is the absence of the key');
  assert.equal(attrs.has('data-skin'), false);
  assert.equal(heard, 2, 'every set() tells its listeners');
});

test('unknown values read as standard, and a pick applies even with blocked storage', () => {
  assert.equal(runSkin({ stored: 'neon' }).Skin.get(), 'standard');
  const blocked = runSkin({ broken: true });
  assert.equal(blocked.Skin.get(), 'standard');
  assert.doesNotThrow(() => blocked.Skin.set('brand'), 'a blocked write never throws');
  // #6562: the pick is held in memory for the page's life when the browser
  // refuses to store it, so it is not lost.
  assert.equal(blocked.attrs.get('data-skin'), 'brand',
    'a choice that could not be stored still applies');
  assert.equal(blocked.Skin.get(), 'brand', 'and every reader gets it');
});

test('another tab changing the key re-applies it here', () => {
  const { Skin, store, attrs, listeners } = runSkin();
  assert.equal(listeners.length, 1, 'the module listens for storage events');
  store.set('homeroom:skin', 'brand');
  listeners[0]({ key: 'homeroom:skin' });
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
});

test('the Skin module runs before the first stylesheet', () => {
  const src = headSrc();
  const skinAt = src.indexOf('window.Skin =');
  const cssAt = src.indexOf('<link rel="stylesheet"');
  assert.ok(cssAt > 0 && skinAt > 0 && skinAt < cssAt,
    'window.Skin must apply before any stylesheet reads data-skin');
});

// ── Where it is offered ──────────────────────────────────────────────────

test('the look is the Look menu\'s first option, and New look\'s switch is gone', () => {
  const src = experimentalSrc();
  assert.match(src, /<option value="">\{t\('settings:experimental\.look\.standard'\)\}<\/option>\s*<option value="brand">\{t\('settings:experimental\.look\.brand'\)\}<\/option>/,
    'right after Standard: it is the one look that keeps the standard pages');
  assert.doesNotMatch(src, /new-look-enabled/, 'no switch of its own');
  assert.doesNotMatch(src, /settings:experimental\.newLook\./, 'and none of the switch\'s words');
  assert.doesNotMatch(src, /review-flow-enabled/, 'the Needs you switch is gone');
});

test('settings.js sets it only through the menu, and paints what is stored', () => {
  const src = settingsJs();
  assert.doesNotMatch(src, /new-look-enabled/, 'no switch is wired');
  assert.doesNotMatch(src, /'brand' : 'standard'/, 'nothing sets brand but the menu\'s own value');
  assert.match(src, /window\.Skin\?\.set\?\.\(e\.target\.value \|\| 'standard'\)/, 'the change is the save');
  assert.match(src, /window\.Skin\?\.onChange\?\.\(/, 'a change in another tab re-paints the menu');
});

test('the look\'s name is English source with a description', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  const entry = en['experimental.look.brand'];
  assert.ok(entry, 'experimental.look.brand exists');
  assert.equal(entry.text, 'Paper, simplified, with brand styling');
  assert.ok(entry.description.trim().length > 20, 'and says where it appears');
  for (const key of ['experimental.newLook.label', 'experimental.newLook.description']) {
    assert.equal(en[key], undefined, `${key} went with the switch`);
  }
});

// ── The app.css rules ────────────────────────────────────────────────────

const HEADING = '/* ── THE BRAND LOOK: PAPER, SIMPLIFIED, WITH BRAND STYLING';
// The look is on where the shell and a framed app agree about the tone, as
// the frame's looks scope their pages. Where they disagree it steps aside.
const FLAG = 'html[data-skin="brand"]';
const LIGHT = `${FLAG}:not(.dark):not([data-app-tone="dark"])`;
const DARK = `${FLAG}.dark:not([data-app-tone="light"])`;
const EITHER = `${FLAG}:is(:not(.dark):not([data-app-tone="dark"]), .dark:not([data-app-tone="light"]))`;

// The look's block: from its heading to the end of the sheet.
function lookBlock() {
  const css = read('public', 'css', 'app.css');
  const at = css.indexOf(HEADING);
  assert.ok(at > 0, 'app.css carries the brand look\'s block');
  return css.slice(at);
}

// The sheet before the look's block, less the one other block that may name
// the look's typefaces: the signed-out pages wear the website's look too,
// between two marks of their own. Where that block is absent, nothing is cut.
function outsideTheLooks() {
  const css = read('public', 'css', 'app.css');
  const before = css.slice(0, css.indexOf(HEADING));
  const a = before.indexOf("/* ── THE WEBSITE'S LOOK ON THE SIGNED-OUT PAGES");
  if (a < 0) return before;
  const end = "/* the website's look on the signed-out pages: end */";
  const b = before.indexOf(end, a);
  assert.ok(b > a, 'the signed-out pages\' look is one block between its two marks');
  return before.slice(0, a) + before.slice(b + end.length);
}

// A selector list, split at its top-level commas (not those inside :is()).
function splitSelectors(head) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(head.slice(from, i).trim()); from = i + 1; }
  }
  out.push(head.slice(from).trim());
  return out.filter(Boolean);
}

// Every rule of the block as { selectors, body }. A media query only narrows
// where a rule applies, so its wrapper is dropped and the rules inside it
// are read like the others.
function lookRules() {
  const block = lookBlock().replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const rules = [];
  for (const chunk of block.split('}').map((r) => r.trim()).filter(Boolean)) {
    const head = chunk.slice(0, chunk.indexOf('{')).trim();
    if (!head || head === '@font-face') continue;
    rules.push({ selectors: splitSelectors(head), body: chunk.slice(chunk.indexOf('{') + 1) });
  }
  return rules;
}
const ruleFor = (needle) => lookRules().filter((rule) => rule.selectors.some((sel) => sel.includes(needle)));
// The one rule whose only selector is exactly this.
const ruleAt = (selector) => lookRules().find((rule) => rule.selectors.length === 1 && rule.selectors[0] === selector);
// A custom property's value in a rule body.
const valueOf = (body, name) => {
  const m = body.match(new RegExp(`${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
};

test('every rule of the look is scoped to the flag, in one of its two modes or in either', () => {
  let selectors = 0;
  const seen = { light: 0, dark: 0, either: 0 };
  for (const rule of lookRules()) {
    for (const sel of rule.selectors) {
      selectors += 1;
      // The longest scope first: the light one is a prefix of none of the others.
      if (sel.startsWith(EITHER)) seen.either += 1;
      else if (sel.startsWith(DARK)) seen.dark += 1;
      else if (sel.startsWith(LIGHT)) seen.light += 1;
      else assert.fail(`"${sel}" must start from the flag, in light, in dark, or in either`);
    }
  }
  assert.ok(selectors > 100, 'the block is read whole');
  assert.ok(seen.either > seen.light + seen.dark, 'most of the look is written once, for both modes');
  assert.ok(seen.light > 10 && seen.dark > 10, 'and each mode has its own tokens and its own utility ramp');
});

test('the block lives last and redeclares none of the counted wallpaper tokens', () => {
  const css = read('public', 'css', 'app.css');
  const block = lookBlock();
  assert.ok(css.trimEnd().endsWith(block.trimEnd()), 'appended at the very end of app.css');
  for (const token of ['--home-washes:', '--home-wallpaper:', '--dc-sheet-fill:', '--dc-frost:']) {
    assert.ok(!block.includes(token), `${token} is counted elsewhere and must not be redeclared here`);
  }
});

// The look's own colours, one set per mode. A rule for either mode names no
// colour of the page, the cards, the bars or the sky: it reads these.
const LOOK_VARS = ['--bl-page', '--bl-card', '--bl-raise', '--bl-label', '--bl-tile-ink', '--bl-bar', '--bl-side',
  '--bl-sun', '--bl-sun-lit', '--bl-on-sun', '--bl-wash', '--bl-sky', '--bl-count', '--bl-on-count', '--bl-solid',
  '--bl-on-solid', '--bl-tint-sun', '--bl-tint-sky', '--bl-tint-leaf', '--bl-on-tint', '--bl-edge', '--bl-pic-line',
  '--bl-lift', '--bl-raise-edge', '--bl-pill-edge', '--bl-pill-edge-down'];

test('each mode sets every one of the look\'s colours, and the shared rules read them', () => {
  const light = ruleAt(LIGHT);
  const dark = ruleAt(DARK);
  assert.ok(light && dark, 'one token rule per mode, on <html>');
  for (const name of LOOK_VARS) {
    assert.ok(valueOf(light.body, name), `light sets ${name}`);
    assert.ok(valueOf(dark.body, name), `dark sets ${name}`);
  }
  // Nothing is read that a mode forgot to set, and nothing is set unread.
  const read_ = new Set([...lookBlock().matchAll(/var\((--bl-[a-z-]+)\)/g)].map((m) => m[1]));
  assert.deepEqual([...read_].sort(), [...LOOK_VARS].sort());
  // The product's tokens every surface draws from move in both modes too.
  for (const token of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-input', '--dc-strip', '--dc-sheet',
    '--dc-sheet-solid', '--dc-strip-solid', '--border', '--border-light', '--text-primary', '--text-secondary',
    '--text-muted', '--text-faint', '--accent', '--accent-ink', '--lit-ink', '--lit-tint', '--brand-ink']) {
    assert.ok(valueOf(light.body, token), `light sets ${token}`);
    assert.ok(valueOf(dark.body, token), `dark sets ${token}`);
  }
  // A rule for either mode carries no colour of its own for those roles.
  for (const rule of lookRules()) {
    if (!rule.selectors.every((sel) => sel.startsWith(EITHER))) continue;
    for (const colour of ['#f6f2d8', '#181127', '#28203c', '#37477b', '#2a2452', '#1a63c4', '#12245a', '#7fbcf7']) {
      assert.ok(!rule.body.includes(colour), `"${rule.selectors[0]}" names ${colour}: read the mode's variable instead`);
    }
  }
});

test('a card differs from the page by its fill, in both modes, with no outline', () => {
  const light = ruleAt(LIGHT).body;
  const dark = ruleAt(DARK).body;
  // Light: white cards on a deeper cream.
  assert.equal(valueOf(light, '--bl-page'), '#f6f2d8');
  assert.equal(valueOf(light, '--bl-card'), '#ffffff');
  assert.equal(valueOf(light, '--bg-secondary'), '#f6f2d8', 'the page');
  assert.equal(valueOf(light, '--bg-primary'), '#ffffff', 'a card');
  assert.doesNotMatch(light, /#fffeea/, 'not the website\'s own cream: white cards would not stand out on it');
  // Dark: a dark purple page, and a card one step lighter in the same hue.
  // The surfaces climb from the page, as in the standard dark.
  assert.equal(valueOf(dark, '--bl-page'), '#181127');
  assert.equal(valueOf(dark, '--bl-card'), '#28203c');
  assert.equal(valueOf(dark, '--bg-primary'), '#181127', 'the page');
  assert.equal(valueOf(dark, '--bg-secondary'), '#28203c', 'a card');
  assert.equal(valueOf(dark, '--text-primary'), '#f2eff7', 'words are a white tinted toward the page');
  // The page is purple, the hue of the standard dark's washes, not the green
  // of the website's ink it was first drawn in: red and blue both above green.
  for (const name of ['--bl-page', '--bl-card', '--bl-raise']) {
    const [r, g, b] = valueOf(dark, name).match(/^#(..)(..)(..)$/).slice(1).map((h) => parseInt(h, 16));
    assert.ok(b > r && r > g, `${name} is a purple`);
  }
  // The outline every card is drawn with is a hairline too faint to read as
  // one; the fill and a lift say where a card ends.
  for (const [mode, ink] of [[LIGHT, '18, 26, 14'], [DARK, '233, 226, 248']]) {
    const line = ruleAt(`${mode}:not([data-contrast="more"])`);
    assert.ok(line, 'the look sets the sheet line, and leaves More contrast its own');
    const alpha = Number(valueOf(line.body, '--app-sheet-line').match(new RegExp(`^rgba\\(${ink}, ([\\d.]+)\\)$`))[1]);
    assert.ok(alpha <= 0.08, 'faint');
  }
  const cards = ruleFor('.dev-ws-strip').find((rule) => /box-shadow:/.test(rule.body));
  assert.ok(cards, 'cards take a lift');
  assert.match(cards.body, /box-shadow:\s*inset 0 0 0 1px var\(--app-sheet-line\), var\(--bl-lift\);/);
  for (const sel of ['.messages-section-card', '.home-challenge-card', '.shadow-\\[inset_0_0_0_1px_var\\(--app-sheet-line\\)\\]']) {
    assert.ok(cards.selectors.some((s) => s === `${EITHER} ${sel}`), `${sel} is one of them`);
  }
  assert.match(valueOf(light, '--bl-lift'), /^0 1px 2px rgba\(18, 26, 14, [\d.]+\), 0 14px 30px -22px rgba\(18, 26, 14, [\d.]+\)$/);
  assert.match(valueOf(dark, '--bl-lift'), /^0 1px 2px rgba\(0, 0, 0, [\d.]+\), 0 14px 30px -22px rgba\(0, 0, 0, [\d.]+\)$/, 'a shadow has to out-darken a dark page');
  // The pane a screen stands on is the page itself, flat.
  const strip = ruleFor('.dc-lift-strip')[0];
  assert.match(strip.body, /background-color:\s*var\(--bl-page\);/);
  assert.match(strip.body, /box-shadow:\s*none;/);
});

test('the sidebar is blue with white words, and the row you are on is sun', () => {
  const css = lookBlock();
  const media = css.match(/@media \(min-width: 768px\) \{([\s\S]*?)\n\}\n/);
  assert.ok(media, 'the sidebar\'s rules apply from 768px, where the bar is a sidebar');
  const bar = ruleAt(`${EITHER} #platform-tabs`);
  assert.ok(bar, 'the bar itself, for either mode');
  assert.match(bar.body, /background:\s*var\(--bl-side\);/);
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-side'), '#1a63c4', 'the deep sky');
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-side'), '#12245a', 'a dark blue in dark, so it does not glare beside a dark page');
  // Its rows draw from the tokens, so hover and focus follow without a rule each.
  assert.match(bar.body, /--text-primary:\s*rgba\(255, 255, 255, 0\.94\);/);
  assert.match(bar.body, /--lit-tint:\s*rgba\(255, 255, 255, 0\.24\);/, 'what is hovered is a wash of white');
  assert.match(bar.body, /--lit-ink:\s*#ffffff;/);
  const here = ruleFor('[aria-current="page"]').find((rule) => /background:\s*var\(--bl-sun\);/.test(rule.body) && rule.selectors[0].includes('#platform-tabs'));
  assert.ok(here, 'the lit row');
  assert.match(here.body, /color:\s*var\(--bl-on-sun\);/, 'ink on sun');
  assert.match(here.selectors[0], /\.platform-rail-community:not\(\[data-rail-open\]\)/, 'a community whose places are open is not lit; its place is');
  for (const mode of [LIGHT, DARK]) {
    assert.equal(valueOf(ruleAt(mode).body, '--bl-sun'), '#ffee6f');
    assert.equal(valueOf(ruleAt(mode).body, '--bl-on-sun'), '#121a0e');
  }
  assert.ok(ruleFor('.platform-rail-nest-in::before').some((rule) => /background:\s*rgba\(255, 255, 255, 0\.45\);/.test(rule.body)),
    'the faint bar beside a community\'s nested rows');
});

test('the top bar is navy, not the sidebar\'s blue, and a community\'s bar keeps its own colour', () => {
  const painted = lookRules().filter((rule) => rule.selectors.some((sel) => /#platform-header#platform-header(::before)?$/.test(sel)));
  assert.ok(painted.length >= 2, 'the top-level bar is restyled');
  for (const rule of painted) {
    for (const sel of rule.selectors) assert.match(sel, /:not\(\[data-community-tint\]\)/, `"${sel}" must leave a project's bar its community's colour`);
  }
  const bar = painted.find((rule) => /background-color:/.test(rule.body));
  assert.match(bar.body, /background-color:\s*var\(--bl-bar\);/);
  assert.match(bar.body, /--brand-ink:\s*#ffffff;/, 'white words');
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-bar'), '#37477b');
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-bar'), '#2a2452');
  for (const mode of [LIGHT, DARK]) {
    assert.notEqual(valueOf(ruleAt(mode).body, '--bl-bar'), valueOf(ruleAt(mode).body, '--bl-side'), 'the two read as two pieces');
  }
  // A phone browser's own rule for the bar is two ids and a `body` deep.
  assert.match(bar.selectors[0], /body:has\(#platform-tabs\) #platform-header#platform-header$/, 'deep enough to outrank it');
  // No other rule that reaches a community's bar gives it a fill.
  for (const rule of lookRules()) {
    for (const sel of rule.selectors) {
      if (!/#platform-header$/.test(sel) || /:not\(\[data-community-tint\]\)/.test(sel)) continue;
      assert.doesNotMatch(rule.body, /(^|[;\s])background(-color)?:/, `"${sel}" sets inks only`);
    }
  }
});

test('on a phone the tab bar is the sidebar\'s blue and its marker sun', () => {
  const css = lookBlock();
  assert.match(css, /@media \(max-width: 767\.98px\) \{/);
  const bar = ruleAt(`${EITHER} .platform-tabs`);
  assert.match(bar.body, /--lit-tint:\s*var\(--bl-sun\);/, 'the marker draws from the lit tint');
  assert.match(bar.body, /--lit-ink:\s*var\(--bl-on-sun\);/, 'and the tab on it is ink');
  assert.ok(ruleFor('.platform-tabs::before').some((rule) => /background:\s*var\(--bl-side\);/.test(rule.body)));
});

test('one accent for "do this", and the old blue as words is the sky', () => {
  const pill = ruleFor('.bg-violet-600').find((rule) => /background-color:\s*var\(--bl-sun\);/.test(rule.body));
  assert.ok(pill, 'the main button is a sun pill');
  assert.match(pill.body, /box-shadow:\s*var\(--bl-pill-edge\);/);
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-pill-edge'), 'inset 0 0 0 1px #121a0e, 0 2px 0 #121a0e', 'on the website\'s ink outline and hard foot');
  assert.match(valueOf(ruleAt(DARK).body, '--bl-pill-edge'), /^0 2px 0 #[0-9a-f]{6}$/, 'in dark the foot alone: an ink outline would vanish');
  const words = ruleFor('.text-violet-600')[0];
  assert.match(words.body, /color:\s*var\(--bl-sky\);/);
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-sky'), '#1a63c4', 'the deep sky on a white card');
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-sky'), '#7fbcf7', 'a light sky, which reads on a dark card');
  // Dark wears its own utilities for the same words.
  assert.ok(words.selectors.includes(`${DARK} .dark\\:text-violet-400`));
  const count = ruleFor('.dev-ws-foryou-pill:not([data-ws-channel-unread])')[0];
  assert.match(count.body, /background:\s*var\(--bl-count\);/);
  assert.match(count.body, /color:\s*var\(--bl-on-count\);/);
});

test('each mode repaints the zinc utilities it wears, and only those', () => {
  const light = lookRules().filter((rule) => rule.selectors.every((sel) => sel.startsWith(LIGHT) && !sel.startsWith(EITHER)));
  const dark = lookRules().filter((rule) => rule.selectors.every((sel) => sel.startsWith(DARK)));
  const names = (rules) => rules.flatMap((rule) => rule.selectors).join('\n');
  for (const cls of ['.bg-zinc-100', '.text-zinc-500', '.border-zinc-200']) assert.ok(names(light).includes(` ${cls}`), `light repaints ${cls}`);
  for (const cls of ['.dark\\:bg-zinc-900', '.dark\\:bg-zinc-800', '.dark\\:text-zinc-400', '.dark\\:border-zinc-800']) {
    assert.ok(names(dark).includes(` ${cls}`), `dark repaints ${cls}`);
  }
  // A light rule that named a dark: utility, or the reverse, would paint the
  // other mode's elements: an element carries both classes.
  assert.doesNotMatch(names(light), /\.dark\\:/, 'no light rule names a dark: utility');
  for (const sel of names(dark).split('\n')) {
    if (/\.(bg|text|border)-zinc-\d/.test(sel.replace(/\.dark\\:[a-z\\:-]+\d+(\\\/\d+)?/g, ''))) assert.fail(`"${sel}" is a dark rule that names a light utility`);
  }
});

test('More contrast keeps its stronger muted words and lines under the look', () => {
  for (const [mode, cls] of [[LIGHT, '.text-zinc-500'], [DARK, '.dark\\:text-zinc-500']]) {
    const tokens = ruleAt(`${mode}[data-contrast="more"]`);
    assert.ok(tokens, 'the mode restates the tokens the standard rule deepens');
    for (const token of ['--text-muted', '--text-faint', '--border', '--border-light']) assert.ok(valueOf(tokens.body, token), token);
    assert.equal(valueOf(tokens.body, '--app-sheet-line'), null, 'the sheet line is left to the standard rule');
    assert.ok(lookRules().some((rule) => rule.selectors[0].startsWith(`${mode}[data-contrast="more"] `) && rule.selectors[0].includes(cls)),
      `and the muted utility ${cls}`);
  }
  // They come after the tokens and the ramps they restate.
  const block = lookBlock();
  assert.ok(block.indexOf(`${DARK}[data-contrast="more"] {`) > block.indexOf(`${DARK} .dark\\:text-zinc-500`));
  assert.ok(block.indexOf(`${LIGHT}[data-contrast="more"] {`) > block.indexOf(`${LIGHT} .text-zinc-500`));
});

test('a label over a group is sentence case', () => {
  const labels = ruleFor('.uppercase').find((rule) => /text-transform:\s*none;/.test(rule.body));
  assert.ok(labels, 'the look undoes the small caps');
  assert.match(labels.body, /letter-spacing:\s*0;/);
  for (const sel of ['.messages-section-head', '.dev-ws-places-head']) {
    assert.ok(labels.selectors.some((s) => s.endsWith(sel)), `${sel} too`);
  }
});

test('Geist loads from our own origin by an absolute path, and only for this look', () => {
  const block = lookBlock();
  assert.match(block, /@font-face\s*\{[^}]*font-family:\s*'Geist'[^}]*url\('\/fonts\/geist\/Geist-Variable\.woff2'\)/,
    'the face points at the self-hosted file by an absolute, same-origin path');
  // Nothing else names the family (the Brand kit look, which also set it, was retired on 12 Nov 2026).
  assert.ok(!/Geist/.test(outsideTheLooks()), 'nothing outside this look and the signed-out pages\' names Geist');
});

test('/fonts/ is a public static prefix, like /vendor/', () => {
  const auth = read('src', 'middleware', 'auth.js');
  const m = auth.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m && /'\/fonts\/'/.test(m[1]), 'signed-out screens fetch the font too');
});

// ── The typeface ─────────────────────────────────────────────────────────

test('Geist is served from our own origin with its licence beside it', () => {
  const dir = path.join(ROOT, 'public', 'fonts', 'geist');
  assert.ok(fs.statSync(path.join(dir, 'Geist-Variable.woff2')).size > 10_000, 'the font file is committed');
  assert.match(read('public', 'fonts', 'geist', 'LICENSE.txt'), /SIL Open Font License/,
    'the OFL travels with the font');
});

test('Geist Mono and Young Serif load from our own origin, with their licences beside them', () => {
  const block = lookBlock();
  for (const [family, file] of [
    ['Geist Mono', '/fonts/geist-mono/GeistMono-Variable.woff2'],
    ['Young Serif', '/fonts/young-serif/young-serif-latin-400-normal.woff2'],
  ]) {
    const face = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'${family}'[^}]*url\\('${file.replace(/[.]/g, '\\.')}'\\)`);
    assert.match(block, face, `${family} points at the self-hosted file by an absolute, same-origin path`);
    assert.ok(fs.statSync(path.join(ROOT, 'public', file)).size > 10_000, `${file} is committed`);
    const licence = path.join(ROOT, 'public', path.dirname(file), 'LICENSE.txt');
    assert.match(fs.readFileSync(licence, 'utf8'), /SIL Open Font License/, `the OFL travels with ${family}`);
  }
  assert.ok(!/Young Serif/.test(outsideTheLooks()), 'nothing outside this look and the signed-out pages\' names Young Serif');
});

test('the empty-state figures are committed beside their provenance, and drawn only by this look', () => {
  for (const name of ['phone.png', 'log.png']) {
    assert.ok(fs.statSync(path.join(ROOT, 'public', 'illustrations', 'people', name)).size > 2_000, `${name} is committed`);
    assert.match(lookBlock(), new RegExp(`url\\('/illustrations/people/${name.replace('.', '\\.')}'\\)`), `${name} is drawn by this look by an absolute path`);
  }
  assert.match(read('public', 'illustrations', 'people', 'README.md'), /onhomeroom\.com/, 'where the figures come from');
  const css = read('public', 'css', 'app.css');
  const before = css.slice(0, css.indexOf(HEADING));
  assert.ok(!before.includes('/illustrations/people/'), 'nothing outside this look loads them');
});
