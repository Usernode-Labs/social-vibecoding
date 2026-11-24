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
    'right after Standard (its work-in-progress copy was removed on 24 Nov 2026, #7071): it is the one look that redraws the standard pages');
  assert.doesNotMatch(src, /new-look-enabled/, 'no switch of its own');
  assert.doesNotMatch(src, /settings:experimental\.newLook\./, 'and none of the switch\'s words');
  assert.doesNotMatch(src, /review-flow-enabled/, 'the Needs you switch is gone');
});

test('settings.js sets it only through the menu, and paints what is stored', () => {
  const src = settingsJs();
  assert.doesNotMatch(src, /new-look-enabled/, 'no switch is wired');
  assert.doesNotMatch(src, /'brand' : 'standard'/, 'nothing sets brand but the menu\'s own value');
  // An entry is a look: the menu's value is the head's own id for it.
  assert.match(src, /window\.Skin\?\.set\?\.\(String\(e\.target\.value \|\| 'standard'\)\);/, 'the change is the save');
  assert.doesNotMatch(src, /setTokens|getTokens/, 'no token set is chosen: the head draws the look with its one');
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
// The standard look's thread page is this look's own rules written a second
// time (scripts/thread-look.js, held by tests/thread-look.test.js): a block
// between two marks just before this one, which is this look, not "outside" it.
function lessTheThreadPage(css) {
  const a = css.indexOf('/* ── THE THREAD PAGE IN THE STANDARD LOOK');
  if (a < 0) return css;
  const end = '/* ── END OF THE THREAD PAGE IN THE STANDARD LOOK. ── */';
  const b = css.indexOf(end, a);
  assert.ok(b > a, 'the thread page\'s block is one block between its two marks');
  return css.slice(0, a) + css.slice(b + end.length);
}
function outsideTheLooks() {
  const css = read('public', 'css', 'app.css');
  const before = lessTheThreadPage(css.slice(0, css.indexOf(HEADING)));
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

test('the brand look\'s phone bar sizes each seat to its own label (#7059)', () => {
  // The word-sized seats used to be the standard look's alone, so the brand
  // look's blue bar cut Home and the long labels mid-word.
  assert.match(read('public', 'css', 'app.css'),
    /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\):not\(\[data-side-strip\]\) #platform-tabs \{ grid-template-columns: repeat\(5, auto\); \}/,
    'the brand look starts each seat from its label');
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
  '--bl-side-end', '--bl-wash-a', '--bl-wash-b', '--bl-wash-c', '--bl-splotch-a', '--bl-splotch-b', '--bl-splotch-c', '--bl-lift-home',
  '--bl-sun', '--bl-sun-lit', '--bl-on-sun', '--bl-wash', '--bl-sky', '--bl-count', '--bl-on-count', '--bl-solid',
  '--bl-on-solid', '--bl-tint-sun', '--bl-tint-sky', '--bl-tint-leaf', '--bl-on-tint', '--bl-edge', '--bl-pic-line',
  '--bl-lift', '--bl-raise-edge', '--bl-field-edge', '--bl-pill-edge', '--bl-pill-edge-down',
  '--bl-bubble-line', '--bl-bubble-line-own', '--bl-card-line', '--bl-row-on', '--bl-row-on-edge'];

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
    for (const colour of ['#f6f2d8', '#0d1421', '#182135', '#37477b', '#232b43', '#1a63c4', '#122a52', '#7fbcf7']) {
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
  // Dark: a very dark navy page, and a card one step lighter in the same
  // blue. The surfaces climb from the page, as in the standard dark.
  assert.equal(valueOf(dark, '--bl-page'), '#0d1421');
  assert.equal(valueOf(dark, '--bl-card'), '#182135');
  assert.equal(valueOf(dark, '--bg-primary'), '#0d1421', 'the page');
  assert.equal(valueOf(dark, '--bg-secondary'), '#182135', 'a card');
  assert.equal(valueOf(dark, '--text-primary'), '#eef2f8', 'words are a white tinted toward the page');
  // Dark keeps to the look's two families, blue and sun. The page was first
  // a green and then a purple, each a third family beside the blue frame;
  // every surface, the sidebar and the bar are blues now: blue above green
  // above red.
  for (const name of ['--bl-page', '--bl-card', '--bl-raise', '--bl-side', '--bl-bar']) {
    const [r, g, b] = valueOf(dark, name).match(/^#(..)(..)(..)$/).slice(1).map((h) => parseInt(h, 16));
    assert.ok(b > g && g > r, `${name} is a blue`);
  }
  // The outline every card is drawn with is a hairline too faint to read as
  // one; the fill and a lift say where a card ends.
  for (const [mode, ink] of [[LIGHT, '18, 26, 14'], [DARK, '220, 230, 248']]) {
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
  // A fade from its top to its foot (Drea's review of #6699): a step lighter
  // and softer than the deep sky it was, so it sits back from the content.
  assert.match(bar.body, /background:\s*linear-gradient\(180deg, var\(--bl-side\), var\(--bl-side-end\)\);/);
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-side'), '#3c7bd8', 'a softened sky at the top');
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-side-end'), '#3370d0', 'a little deeper at the foot');
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-side-end'), '#122a52', 'flat in dark');
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-side'), '#122a52', 'a dark blue in dark, so it does not glare beside a dark page');
  // Its rows draw from the tokens, so hover and focus follow without a rule each.
  assert.match(bar.body, /--text-primary:\s*rgba\(255, 255, 255, 0\.94\);/);
  assert.match(bar.body, /--lit-tint:\s*rgba\(255, 255, 255, 0\.24\);/, 'what is hovered is a wash of white');
  assert.match(bar.body, /--lit-ink:\s*#ffffff;/);
  const here = ruleFor('[aria-current="page"]').find((rule) => /background:\s*var\(--bl-sun\);/.test(rule.body) && rule.selectors[0].includes('#platform-tabs'));
  assert.ok(here, 'the lit row');
  assert.match(here.body, /color:\s*var\(--bl-on-sun\);/, 'ink on sun');
  assert.match(here.selectors[0], /\.platform-rail-community:not\(\[data-rail-open\]\)/, 'a community whose places are open is not lit; its place is');
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-sun'), '#ffee6f');
  // Dark turns the sun down a step and keeps all its colour (oklch .88 .18
  // 100): the full sun glared as a fill on the navy, and a darker one that
  // lost its colour too went olive.
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-sun'), '#f3d920');
  for (const mode of [LIGHT, DARK]) {
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
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-bar'), '#232b43');
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

test('the side panel starts below the flat bar, on the chat column\'s line', () => {
  const rule = ruleAt(`${EITHER}:not([data-community-tint]) body:has(#platform-tabs) .side-panel`);
  assert.ok(rule, 'the look moves the panel below its flat bar');
  const top = valueOf(rule.body, 'top');
  assert.match(top, /\+ \.5rem\)$/, '8px below the bar, not 8px up into its rounded edge');
  // The same arithmetic #ai-screen .ai-main-pane and .dev-ws-side use.
  const css = read('public', 'css', 'app.css');
  const pane = css.match(/#ai-screen \.ai-main-pane \{[\s\S]*?\n\}/);
  assert.ok(pane, '#ai-screen .ai-main-pane is found');
  assert.equal(top, valueOf(pane[0].slice(pane[0].indexOf('{') + 1), 'top'),
    'the panel starts on the line the chat column already starts on');
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
  // In dark an ink outline would vanish, and the deeper-sun foot it had
  // instead read as yellow on gold: the pill is flat.
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-pill-edge'), '0 0 0 transparent');
  assert.equal(valueOf(ruleAt(DARK).body, '--bl-pill-edge-down'), '0 0 0 transparent');
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

test('a title is Geist like every other word: no rule of the look sets the serif', () => {
  // The serif was on every h1, which a heading inside a message is too, and
  // on a project's name on its hub. Nothing names it now, so each title
  // takes the look's own sans at the weight its screen gave it.
  for (const rule of lookRules()) {
    assert.doesNotMatch(rule.body, /Young Serif|\bserif\b(?<!sans-serif)/, `${rule.selectors[0]} sets no serif`);
  }
  assert.deepEqual(ruleFor(' h1'), [], 'no rule of the look restyles an h1');
  assert.ok(!ruleFor('.dev-ws-hero-name').some((rule) => /font-family/.test(rule.body)), 'nor a project\'s name');
  assert.match(ruleAt(EITHER).body, /font-family:\s*'Geist',/, 'the look\'s one family for words');
  // The Workshop's counts keep the mono.
  assert.match(ruleFor('.dev-ws-dash-cell b')[0].body, /font-family:\s*'Geist Mono',/);
});

test('Home\'s pinned apps and the Communities page\'s groups each sit on a card, and the launcher grid keeps its box', () => {
  const COMMUNITY_GRIDS = ':is(#home-communities-section > .grid, .communities-grid)';
  const card = ruleFor('#app-list').find((rule) => /background-color:\s*var\(--bl-card\)/.test(rule.body));
  assert.ok(card, 'the launcher grid is painted');
  assert.deepEqual(card.selectors, [`${EITHER} #app-list`, `${EITHER} ${COMMUNITY_GRIDS}`],
    'the launcher, the Communities page\'s two groups and what Home\'s search finds, in both modes, and nothing else');
  assert.match(card.body, /background-color:\s*var\(--bl-card\);/, 'the mode\'s card: white in light, one step off the page in dark');
  assert.match(card.body, /border-radius:\s*20px;/, 'a card\'s radius');
  assert.match(card.body, /box-shadow:\s*inset 0 0 0 1px var\(--app-sheet-line\), var\(--bl-lift-home\);/, 'and its hairline and Home\'s lift');
  // The launcher's drag overlay mirrors #app-list's padding, and a dropped
  // tile is measured against it (app.css .home-grid-overlay, Home._rectForCell):
  // the look paints the grid and moves nothing.
  for (const rule of ruleFor('#app-list')) {
    assert.doesNotMatch(rule.body, /\b(?:padding|margin|gap|width|height|inset|top|left|right|bottom|display|position)\b[^;]*:/,
      'no rule of the look moves the launcher grid');
  }
  // The communities' grids have no overlay: they take a card's own padding.
  const pad = ruleAt(`${EITHER} ${COMMUNITY_GRIDS}`);
  assert.ok(pad, 'their padding is a rule of its own');
  assert.match(pad.body, /^\s*padding:\s*16px 8px 14px;\s*$/);
  // The grids are the ones the look paints: the sections' own markup.
  assert.match(read('frontend', 'src', 'features', 'home', 'pinned-communities.tsx'),
    /<section id="home-communities-section"[^>]*>\s*<SectionHeading[\s\S]*?<\/SectionHeading>\s*<div className="grid grid-cols-4 /,
    'what Home\'s search finds: the grid is the section\'s direct child, after its label');
  const page = read('frontend', 'src', 'features', 'communities', 'index.tsx');
  assert.match(page, /const GRID = 'communities-grid grid grid-cols-4 /, 'the page\'s two groups share one grid');
  assert.equal((page.match(/<div className=\{(?:pinCards|joinCards) \? CARDS : GRID\}/g) || []).length, 2, 'Pinned and Joined, where they are tiles');
  assert.match(read('frontend', 'src', 'features', 'home', 'app-grid.tsx'), /id="app-list"/);
});

test('a reply box stands out from the card it sits on, in both modes', () => {
  // The sheet a composer sits at the foot of is the card's own colour here,
  // so the box takes the raised fill and an edge firmer than the raised
  // buttons' own.
  const box = ruleAt(`${EITHER} :is(.messages-composer-card, .gc-composer-card)`);
  assert.ok(box, 'both composers, Messages\' and the group chat\'s, in one rule for both modes');
  assert.match(box.body, /background:\s*var\(--bl-raise\);/);
  assert.match(box.body, /box-shadow:\s*var\(--bl-field-edge\);/);
  const edge = (body) => Number(valueOf(body, '--bl-field-edge').match(/inset 0 0 0 1px rgba\([^)]*,\s*([0-9.]+)\)/)[1]);
  const raise = (body) => Number(valueOf(body, '--bl-raise-edge').match(/inset 0 0 0 1px rgba\([^)]*,\s*([0-9.]+)\)/)[1]);
  for (const mode of [LIGHT, DARK]) {
    assert.ok(edge(ruleAt(mode).body) > raise(ruleAt(mode).body), `${mode}: a field's edge is firmer than a raised button's`);
  }
  // Light's raise is the card's own white: the edge is what sets it apart.
  assert.equal(valueOf(ruleAt(LIGHT).body, '--bl-raise'), valueOf(ruleAt(LIGHT).body, '--bl-card'));
  // Focus still rings the box, outside its edge (the composer's own rule).
  const focus = ruleAt(`${EITHER} .messages-composer-card:focus-within`);
  assert.ok(focus, 'the focus ring is restated over the edge');
  assert.match(focus.body, /box-shadow:\s*var\(--bl-field-edge\), 0 0 0 2px var\(--accent\);/);
  assert.match(read('public', 'css', 'app.css'), /\.messages-composer-card:focus-within \{\n  box-shadow: var\(--messages-disc-shadow\), 0 0 0 2px var\(--accent\);/,
    'the standard composer\'s ring, which the look restates');
});

test('the column\'s header beside Homeroom bot\'s page is the card\'s colour, and its ⋯ is raised', () => {
  // The standard header there is the sheet's half-clear fill (a pale band of
  // this look's page): it outranks it with the same :has() and the look's flag.
  assert.match(read('public', 'css', 'app.css'),
    /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel-head \{[^}]*background-color: var\(--dc-sheet-fill\);/);
  const head = ruleAt(`${EITHER} body:has(#ai-screen:not(.hidden)) .side-panel-head`);
  assert.ok(head, 'the header, in both modes');
  assert.match(head.body, /^\s*background-color:\s*var\(--bl-card\);\s*$/);
  const more = ruleAt(`${EITHER} body:has(#ai-screen:not(.hidden)) .side-panel-head .messages-thread-action`);
  assert.ok(more, 'its ⋯ disc');
  assert.match(more.body, /background:\s*var\(--bl-raise\);/);
  assert.match(more.body, /box-shadow:\s*var\(--bl-raise-edge\);/);
});

test('Geist loads from our own origin by an absolute path, and only for this look', () => {
  const block = lookBlock();
  assert.match(block, /@font-face\s*\{[^}]*font-family:\s*'Geist'[^}]*url\('\/fonts\/geist\/Geist-Variable\.woff2'\)/,
    'the face points at the self-hosted file by an absolute, same-origin path');
  // Nothing else names the family (the Brand kit look, which also set it, was retired on 12 Nov 2026),
  // but Standard (WIP)'s brand token config, which names it as that config's typeface and so
  // loads the file only while that config is on.
  const outside = outsideTheLooks().replace(/STANDARD \(WIP\): the standard look[\s\S]*?END OF STANDARD \(WIP\)\./, '');
  assert.ok(!/Geist/.test(outside), 'nothing outside this look, Standard (WIP)\'s brand config and the signed-out pages\' names Geist');
  assert.match(read('public', 'css', 'app.css'), /html:not\(\[data-skin\]\) \{[^}]*--wip-font: 'Geist',/);
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
  // Standard (WIP)'s second brand token set named it too, until it was removed on 20 Nov 2026.
  const outsideSerif = outsideTheLooks().replace(/STANDARD \(WIP\): the standard look[\s\S]*?END OF STANDARD \(WIP\)\./, '');
  assert.ok(!/Young Serif/.test(outsideSerif), 'nothing outside this look and the signed-out pages\' names Young Serif');
});

test('the empty-state figures are committed beside their provenance, and drawn only by this look', () => {
  for (const name of ['phone.png', 'log.png']) {
    assert.ok(fs.statSync(path.join(ROOT, 'public', 'illustrations', 'people', name)).size > 2_000, `${name} is committed`);
    assert.match(lookBlock(), new RegExp(`url\\('/illustrations/people/${name.replace('.', '\\.')}'\\)`), `${name} is drawn by this look by an absolute path`);
  }
  assert.match(read('public', 'illustrations', 'people', 'README.md'), /onhomeroom\.com/, 'where the figures come from');
  const css = read('public', 'css', 'app.css');
  const before = lessTheThreadPage(css.slice(0, css.indexOf(HEADING)));
  assert.ok(!before.includes('/illustrations/people/'), 'nothing outside this look loads them');
});

test('a conversation\'s bubbles have a ground and an edge of their own inside the white thread', () => {
  // 17 Nov 2026: a thread is a white card in this look, and a bubble from the
  // other side was white on it, your own a grey one shade off, and the bot's
  // cards a third white. The other side's words sit on the page's cream and
  // yours on the sky tint, each with a thin line; the bot's cards keep their
  // white with a firmer line.
  const block = lookBlock();
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = (selector, body) => new RegExp(`${esc(EITHER)} ${esc(selector)}[^{]*\\{ ${esc(body)} \\}`);
  assert.match(block, rule(':is(.messages-bubble, .gc-bubble)', 'background: var(--bl-page);'));
  assert.match(block, new RegExp(`${esc(EITHER)} \\.messages-message-self \\.messages-bubble,\\s*${esc(EITHER)} \\.gc-bubble-self \\{ background: var\\(--bl-tint-sky\\); \\}`));
  assert.match(block, new RegExp(`${esc(EITHER)} \\.messages-message-bubble:not\\(\\.messages-message-saved\\) \\.messages-bubble,\\s*${esc(EITHER)} \\.gc-bubble \\{ box-shadow: inset 0 0 0 1px var\\(--bl-bubble-line\\); \\}`),
    'a saved message keeps its accent outline');
  assert.match(block, new RegExp(`${esc(EITHER)} \\.messages-message-bubble\\.messages-message-self:not\\(\\.messages-message-saved\\) \\.messages-bubble,\\s*${esc(EITHER)} \\.gc-bubble-self \\{ box-shadow: inset 0 0 0 1px var\\(--bl-bubble-line-own\\); \\}`));
  assert.match(block, rule('[data-bot-card-state]', 'box-shadow: inset 0 0 0 1px var(--bl-card-line);'));
  // The bot's card is drawn with the attribute the rule reads.
  assert.match(read('frontend', 'src', 'features', 'messages', 'bot-cards', 'card-ui.tsx'), /data-bot-card-state=\{state\}/);
  // The lines are the look's own, set in both modes.
  const light = ruleAt(LIGHT).body;
  const dark = ruleAt(DARK).body;
  assert.equal(valueOf(light, '--bl-bubble-line'), 'rgba(18, 26, 14, 0.14)');
  assert.equal(valueOf(light, '--bl-bubble-line-own'), 'rgba(26, 99, 196, 0.24)');
  assert.equal(valueOf(dark, '--bl-bubble-line'), 'rgba(220, 230, 248, 0.2)');
  assert.equal(valueOf(dark, '--bl-bubble-line-own'), 'rgba(127, 188, 247, 0.42)');
});

// DREA'S REVIEW OF #6699. The page wears the standard wallpaper's washes
// again, in the look's own tints; Home takes Standard (WIP)'s New project
// button and Needs you card in the look's colours; and from 1280px Pinned
// communities are cards that say what is going on in each community.
test('the page is the standard wallpaper\'s washes in the look\'s own tints, and the fixed layer follows', () => {
  const light = ruleAt(LIGHT).body;
  const dark = ruleAt(DARK).body;
  assert.equal(valueOf(light, '--bl-wash-a'), '255, 253, 240', 'a lighter cream where the standard wash is lilac');
  assert.equal(valueOf(light, '--bl-wash-b'), '247, 220, 200', 'a blush where it is pink');
  assert.equal(valueOf(light, '--bl-wash-c'), '251, 230, 175', 'a sun where it is peach');
  for (const name of ['--bl-wash-a', '--bl-wash-b', '--bl-wash-c']) {
    const [r, g, b] = valueOf(dark, name).split(',').map(Number);
    assert.ok(b > g && g > r, `${name} stays a blue round the dark page`);
  }
  // The shared rules, which dark wears; light lays THE SPLOTCHES over them
  // (the next test).
  const ground = ruleFor('body:has(#platform-tabs)')
    .filter((rule) => rule.selectors[0].startsWith(EITHER) && /--look-washes:/.test(rule.body));
  assert.equal(ground.length, 2, 'the phone\'s three washes, and from 640px the seven');
  const wide = ground[1].body;
  for (const at of ['circle at calc(100% - 92px) 115px', 'ellipse 38vw 36vh at 24% 20%', 'ellipse 34vw 28vh at 90% 32%']) {
    assert.ok(wide.includes(at), `a wash ${at}, where the standard wallpaper has it`);
  }
  assert.match(wide, /rgba\(var\(--bl-wash-c\), 0\.75\) 90px/);
  assert.match(ground[0].body, /background:\s*var\(--look-wallpaper\);/);
  assert.match(ground[0].body, /var\(--home-star, none\)/, 'the star falls back to nothing where the route rule does not define it');
  assert.match(ruleFor('body::before')[0].body, /background:\s*var\(--look-wallpaper, var\(--bl-page\)\);/);
});

// EVAN'S WALLPAPER REVIEW, 18 Nov 2026 (option 5b, "scatter, lilac,
// softer"): in light, six small splotches in the standard wallpaper's lilac,
// pink and peach, scattered thin over the cream, sized against the screen.
test('in light the cream wears six scattered lilac splotches, at every width, and dark keeps its washes', () => {
  const light = ruleAt(LIGHT).body;
  assert.equal(valueOf(light, '--bl-splotch-a'), '229, 216, 239', 'the standard wallpaper\'s lilac');
  assert.equal(valueOf(light, '--bl-splotch-b'), '245, 215, 230', 'its pink');
  assert.equal(valueOf(light, '--bl-splotch-c'), '252, 219, 212', 'its peach');
  const rule = ruleAt(`${LIGHT} body:has(#platform-tabs)`);
  assert.ok(rule, 'one light-only rule lays the splotches over the shared washes');
  assert.equal(ruleFor('--bl-splotch').length, 0, 'no selector names them');
  assert.equal(lookRules().filter((r) => /var\(--bl-splotch-/.test(r.body)).length, 1,
    'only that light rule reads them: dark keeps its washes round the navy');
  const washes = valueOf(rule.body, '--look-washes');
  assert.equal((washes.match(/radial-gradient\(circle at /g) || []).length, 6, 'six splotches');
  for (const at of ['24% 14%', '96% 30%', '36% 58%', '86% 86%', '4% 84%', '72% 4%']) {
    assert.ok(washes.includes(`circle at ${at}, rgba(var(--bl-splotch-`), `a splotch at ${at}`);
  }
  assert.match(washes, /rgba\(var\(--bl-splotch-a\), 0\.39\) 6\.44vmin, rgba\(var\(--bl-splotch-a\), 0\.195\) 17\.17vmin, rgba\(var\(--bl-splotch-a\), 0\) 27\.9vmin/,
    'faint, half by the middle stop, gone at the edge');
  assert.doesNotMatch(washes, /\d(px|vw|vh)\b/, 'sized in vmin, so a splotch keeps its size against the screen');
  assert.ok(/var\(--bl-page\)$/.test(washes), 'on the cream');
  // After the 640px rule in the sheet, so the one set holds at every width.
  const block = lookBlock();
  assert.ok(block.indexOf(`${LIGHT} body:has(#platform-tabs) {`) > block.indexOf('ellipse 34vw 28vh at 90% 32%'),
    'the light rule follows the 640px washes');
});

test('Home takes Standard (WIP)\'s New project button and Needs you card, in the look\'s colours', () => {
  const island = read('frontend', 'src', 'features', 'home', 'index.tsx');
  assert.match(island, /const brand = skin === 'brand';/);
  assert.match(island, /\{\(topRow \|\| brand\) && grid\.ready && grid\.create \? \(\s*<WipCta id="home-new-project-top"/);
  assert.match(island, /<WipCard on=\{wip\}>/, 'Pinned apps keeps the look\'s own card, not WIP\'s');
  const home = read('frontend', 'src', 'features', 'home', 'home.js');
  const side = home.slice(home.indexOf('hasSideCard() {'), home.indexOf('_wireRowBudget() {'));
  assert.match(side, /if \(skin !== 'brand' && skin !== 'standard'\) return false;\s*try \{ return !!window\.matchMedia\('\(min-width: 768px\)'\)\.matches; \}/,
    'the grid drops its tile only where the search row shows the button');
  const at = (sel) => ruleAt(`${EITHER} ${sel}`);
  const tokens = at(':is(#home-screen, #communities-screen)').body;
  assert.equal(valueOf(tokens, '--wip-cta-from'), 'var(--bl-sun)', 'the filled action is the sun');
  assert.equal(valueOf(tokens, '--wip-cta-ink'), 'var(--bl-on-sun)');
  assert.equal(valueOf(tokens, '--wip-ink-action'), 'var(--bl-sky)', 'a link is the sky');
  assert.equal(valueOf(tokens, '--wip-card-bg'), 'var(--bl-card)');
  assert.match(at(':is(#home-screen, #communities-screen) .wip-cta').body, /box-shadow:\s*var\(--bl-pill-edge\);/);
  assert.match(lookBlock(), /@media \(max-width: 767\.98px\) \{\s*html\[data-skin="brand"\][^{]*#home-new-project-top \{\s*display: none;/);
  // The order: Pinned apps, Needs you, what a search finds of your communities, the rest, Challenges, Communities to join.
  assert.match(at('#home-screen .home-main > *').body, /order:\s*4;/);
  assert.match(at('#home-screen .home-row > .home-aside').body, /order:\s*1;/);
  assert.match(at('#home-screen .home-main > #home-communities-section').body, /order:\s*2;/);
  assert.match(at('#home-screen .home-row > #home-challenges-section').body, /order:\s*5;/);
  assert.match(at('#home-screen .home-main > #home-join-section').body, /order:\s*6;/);
});

test('Recent threads stands beside Pinned apps on a wide screen, and is a sideways row of cards on a phone', () => {
  const block = lookBlock();
  const at = (sel) => ruleAt(`${EITHER} ${sel}`);
  // Only while the card and the apps section are both drawn: otherwise Home is one column as it was.
  const BOTH = '#home-screen:has(#home-needs-card):has(#home-apps-section:not([hidden]))';
  const wide = block.slice(block.indexOf('RECENT THREADS BESIDE PINNED APPS'), block.indexOf('ON A PHONE NEEDS YOU IS A ROW OF CARDS'));
  assert.ok(block.lastIndexOf('@media (min-width: 1280px) {', block.indexOf('RECENT THREADS BESIDE PINNED APPS')) > 0, 'from 1280px');
  assert.match(at(`${BOTH} .home-body-fill`).body, /display:\s*grid;[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 320px;/);
  assert.match(at(`${BOTH} .home-main`).body, /display:\s*contents;/);
  assert.match(at('#home-screen:has(#home-needs-card) .home-main > #home-apps-section:not([hidden])').body, /grid-column:\s*1;\s*grid-row:\s*1;/);
  const beside = at('#home-screen:has(#home-apps-section:not([hidden])) .home-row > .home-aside:has(#home-needs-card)').body;
  assert.match(beside, /grid-column:\s*2;\s*grid-row:\s*1;/);
  // Pinned apps alone sets the row's height: the column stretches to it and
  // holds its rows to it, so the number of rows the card draws cannot change
  // the box it was worked out from.
  assert.match(beside, /contain:\s*size;/, 'the column adds no height of its own to the row');
  assert.match(beside, /min-height:\s*200px;/, 'a floor of a heading and about two rows');
  assert.match(beside, /overflow:\s*hidden;/);
  // A short list ends after its last row instead of matching Pinned apps' height.
  const card = at('#home-screen:has(#home-apps-section:not([hidden])) #home-needs-card').body;
  const panel = at('#home-screen:has(#home-apps-section:not([hidden])) #home-needs-card > .wip-panel').body;
  assert.doesNotMatch(card, /flex:\s*1 1 auto;/, 'the card is its own height');
  assert.doesNotMatch(panel, /flex:\s*1 1 auto;/, 'and so is its panel');
  assert.match(card, /flex:\s*none;/);
  assert.match(panel, /flex:\s*none;/);
  // 19 Nov 2026: no "N more" row; the heading opens the rest.
  assert.doesNotMatch(wide, /nth-child\(n \+ 6\)/, 'nothing is hidden after the fifth any more');
  assert.doesNotMatch(block, /#home-needs-card \.wip-row-more/);
  // The look sets no --wip-cell-pad, so the kit row's padding fell away: a recent thread's row is padded top and bottom.
  assert.match(block, /@media \(min-width: 768px\) \{\s*html\[data-skin="brand"\][^{]*#home-needs-card \.wip-row \{\s*padding: 0\.5rem 0;/);
  // The launcher grid is repainted, never moved: the card is the box around it.
  assert.match(at('#home-screen:has(#home-needs-card) #home-apps-section:not([hidden]) #app-list').body, /^\s*background-color:\s*transparent;\s*box-shadow:\s*none;\s*$/);
  assert.match(wide, /> \.home-area-label \+ div \{[\s\S]*?background-color:\s*var\(--bl-card\);/);
  // On a phone the list is a row that scrolls and snaps card by card.
  const phone = block.slice(block.indexOf('ON A PHONE NEEDS YOU IS A ROW OF CARDS'));
  assert.match(phone, /^[^{]*\*\/\s*@media \(max-width: 767\.98px\) \{/);
  const rows = at('#home-needs-card .wip-rows').body;
  assert.match(rows, /display:\s*flex;/);
  assert.match(rows, /overflow-x:\s*auto;/);
  assert.match(rows, /scroll-snap-type:\s*x mandatory;/);
  assert.match(at('#home-needs-card .wip-rows > li').body, /flex:\s*0 0 78%;\s*scroll-snap-align:\s*start;/, 'the next card shows at the edge');
});

test('the Communities page wears the look: its button, its cards, and no count on its tab', () => {
  const at = (sel) => ruleAt(`${EITHER} ${sel}`);
  // The kit's tokens are set on Home and on the page, for New community's button.
  const tokens = at(':is(#home-screen, #communities-screen)').body;
  assert.equal(valueOf(tokens, '--wip-cta-from'), 'var(--bl-sun)');
  assert.match(at(':is(#home-screen, #communities-screen) .wip-cta').body, /box-shadow:\s*var\(--bl-pill-edge\);/);
  const page = read('frontend', 'src', 'features', 'communities', 'index.tsx');
  assert.match(page, /\{kit && offerCreate \? \(\s*<WipCta\s+id="communities-new-top"/, 'the filled button, in the looks that draw Home with the kit');
  assert.match(at(':is(#home-create-tile, #communities-new-community) .home-create-glyph').body, /background:\s*var\(--bl-sun\);/, 'and the tile under 768px is the same sun');
  assert.match(at('.communities-discover').body, /background:\s*var\(--bl-card\);/);
  assert.match(at('#platform-tab-workshop :is(.platform-tab-votes, .platform-tab-badge)').body, /display:\s*none;/, 'Home\'s Needs you card says it');
});

test('the Communities page\'s cards wear the look: its card, its inks and its small words, from 1280px, read only where they are drawn', () => {
  const page = read('frontend', 'src', 'features', 'communities', 'index.tsx');
  assert.match(page, /const brandCards = useMinWidth\(1280\);/);
  assert.match(page, /const pinCards = wip \? wideCards : brand && brandCards;/, 'a pin is the big card from 1280px, as the look drew its cards');
  assert.match(page, /const joinCards = wip \|\| \(brand && brandCards\);/, 'and a joined community the compact card');
  assert.match(page, /if \(shown && state\.ready && \(\(pinCards && pinKey\) \|\| \(joinCards && joinedKey\)\)\) void loadHomePinsActivity\(\);/, 'what a card says (a pin\'s, and a joined community\'s week) is read only where one is drawn');
  const store = read('frontend', 'src', 'features', 'home', 'home-pins-store.ts');
  assert.match(store, /readJson\('\/api\/me\/home-pins\/activity'\)/);
  // The card is "A COMMUNITY'S CARD", drawn from tokens: the look sets its own.
  const tokens = lookRules().find((rule) => rule.selectors.length === 1 && rule.selectors[0] === EITHER && /--cm-bg:/.test(rule.body));
  assert.ok(tokens, 'the look sets the card\'s tokens on <html>, in both modes');
  assert.equal(valueOf(tokens.body, '--cm-bg'), 'var(--bl-card)', 'the mode\'s card');
  assert.equal(valueOf(tokens.body, '--cm-radius'), '18px');
  assert.equal(valueOf(tokens.body, '--cm-edge'), 'inset 0 0 0 1px var(--app-sheet-line), var(--bl-lift)', 'its hairline and its lift');
  assert.equal(valueOf(tokens.body, '--cm-edge-on'), 'inset 0 0 0 1px var(--app-sheet-line), var(--bl-lift-home)', 'a stronger lift under the pointer');
  assert.equal(valueOf(tokens.body, '--cm-ink'), 'var(--text-primary)');
  assert.equal(valueOf(tokens.body, '--cm-muted'), 'var(--text-muted)');
  assert.equal(valueOf(tokens.body, '--cm-link'), 'var(--bl-sky)', 'what went live in the sky');
  assert.equal(valueOf(tokens.body, '--cm-small'), '13px');
  assert.equal(valueOf(tokens.body, '--cm-small-line'), '18px');
  assert.equal(valueOf(tokens.body, '--cm-gap'), '14px');
  assert.match(ruleAt(`${EITHER} .cm-card [data-home-community-votes]`).body, /top:\s*-7px;[\s\S]*min-width:\s*20px;/, 'the votes waiting on the icon\'s corner');
  // The old card's parts, and the rules that drew them, are gone.
  for (const needle of ['data-home-community-detail', 'data-home-community-meta', '.home-community-people', '.home-community-news', '.home-community-quiet']) {
    assert.deepEqual(ruleFor(needle), [], `${needle} is not drawn any more`);
  }
  const home = JSON.parse(read('frontend', 'locales', 'en', 'home.json'));
  assert.equal(home['communities.members_other'].text, '{{formatted}} members');
  assert.equal(home['communities.activeWeek_other'].text, '{{formatted}} active this week');
  assert.equal(home['communities.activeShort_other'].text, '{{formatted}} active');
  assert.equal(home['communities.liveThisWeek_other'].text, '{{formatted}} changes live this week');
  assert.equal(home['communities.quietWeek'], undefined, 'a quiet week says nothing');
});

test('the board is calm: Vote and what is running are the sky, and a vote under way is not purple', () => {
  const at = (sel) => ruleAt(`${EITHER} ${sel}`);
  // Vote was the shell's --accent, the ink here: the darkest thing on the
  // page, once a row. Its states (Yes cast, No cast, an earlier Yes) keep
  // their own fills.
  const vote = at('.dev-vote-btn:not(.dev-vote-btn-yes, .dev-vote-btn-no, .dev-vote-btn-prior)');
  assert.ok(vote, 'one rule for the Vote face, in both modes');
  assert.match(vote.body, /background:\s*var\(--bl-count\);/);
  assert.match(vote.body, /color:\s*var\(--bl-on-count\);/);
  assert.ok(at('.dev-vote-btn:not(.dev-vote-btn-yes, .dev-vote-btn-no, .dev-vote-btn-prior):hover'), 'and its hover');
  // A change's own foot keeps the sun pill, by a more specific rule.
  assert.ok(ruleFor('.dev-thread-foot-acts :is(.dev-vote-btn:not(.dev-vote-btn-yes), .dev-request-primary)')
    .some((rule) => /background:\s*var\(--bl-sun\);/.test(rule.body)));
  // Something still running is the sky's pale tint, not the lit (sun) tint.
  const run = at('.dev-ws-tag[data-tone="run"]');
  assert.ok(run);
  assert.match(run.body, /color:\s*var\(--bl-sky\);/);
  assert.match(run.body, /background:\s*var\(--bl-tint-sky\);/);
  // The progress state is the sky in both modes: the look's two families.
  const tokens = lookRules().find((rule) => rule.selectors.length === 1 && rule.selectors[0] === EITHER && /--state-progress:/.test(rule.body));
  assert.ok(tokens, 'set once for both modes');
  assert.equal(valueOf(tokens.body, '--state-progress'), 'var(--bl-sky)');
  assert.equal(valueOf(tokens.body, '--state-progress-bg'), 'var(--bl-tint-sky)');
  // The row open beside the board is outlined, not a block of pale sun.
  const on = at('.dev-ws-wrow[data-on]');
  assert.ok(on, 'one rule for both modes');
  assert.match(on.body, /background:\s*var\(--bl-row-on\);/);
  assert.match(on.body, /box-shadow:\s*inset 0 0 0 1\.5px var\(--bl-row-on-edge\);/);
  assert.doesNotMatch(on.body, /--lit-tint|--bl-sun/);
  for (const mode of [LIGHT, DARK]) {
    assert.ok(valueOf(ruleAt(mode).body, '--bl-row-on'), `${mode} sets the open row's fill`);
    assert.ok(valueOf(ruleAt(mode).body, '--bl-row-on-edge'), `${mode} sets its edge`);
  }
});

test('a vote to close is drawn with the page\'s card and the foot\'s two buttons (#7064)', () => {
  // The card was white on the white thread card, with no edge, and Yes was
  // the sky (the generic Vote face) beside a quiet grey patch: neither is
  // what the page's own buttons look like.
  const src = read('frontend', 'src', 'features', 'dev-board', 'topic', 'thread-changes.tsx');
  assert.doesNotMatch(src, /style=\{sending \? \{ minWidth/, 'neither face carries an inline colour');
  assert.match(src, /className=\{act \? 'dev-vote-btn dev-vote-btn-act' : 'dev-vote-btn dev-vote-btn-quiet'\}/);
  assert.equal((src.match(/const act = !sending && \(on \|\| \(!mine && side === 'up'\)\);/g) || []).length, 2,
    'the request\'s close vote and the decision page\'s card');
  const gate = ruleAt(`${EITHER} .dev-change-pair .dev-change-gate`);
  assert.ok(gate, 'the card is the look\'s own, in both modes');
  assert.match(gate.body, /background:\s*var\(--bl-card\);/);
  assert.match(gate.body, /box-shadow:\s*inset 0 0 0 1px var\(--app-sheet-line\);/);
  const act = ruleAt(`${EITHER} .dev-change-gate-act .dev-vote-btn-act`);
  assert.ok(act, 'the acting face');
  assert.match(act.body, /background:\s*var\(--bl-sun\);/);
  assert.match(act.body, /color:\s*var\(--bl-on-sun\);/);
  assert.match(act.body, /box-shadow:\s*var\(--bl-pill-edge\);/);
  assert.match(ruleAt(`${EITHER} .dev-change-gate-act .dev-vote-btn-act:hover`).body, /background:\s*var\(--bl-sun-lit\);/);
  const quiet = ruleAt(`${EITHER} .dev-change-gate-act .dev-vote-btn-quiet`);
  assert.ok(quiet, 'and the quiet one');
  assert.match(quiet.body, /background:\s*var\(--bl-raise\);/);
  assert.match(quiet.body, /box-shadow:\s*var\(--bl-raise-edge\);/);
  // The standard look's thread page carries the same rules (scripts/thread-look.js).
  const css = read('public', 'css', 'app.css');
  assert.match(css, /:where\(#dev-topic-thread\) \.dev-change-gate-act \.dev-vote-btn-act \{ background: var\(--bl-sun\); color: var\(--bl-on-sun\); box-shadow: var\(--bl-pill-edge\); \}/);
  // Every look keeps the quiet face's old fill, in the base rules.
  assert.match(css, /\.dev-vote-btn-quiet, \.dev-vote-btn-quiet:hover \{ background: var\(--state-neutral-bg\); color: var\(--text-primary\); \}/);
  // Both faces keep even sides, so neither label sits flush with its edge
  // (the base button's 8px end is the caret's room, and these carry no
  // caret).
  assert.match(css, /\.dev-change-gate-act \.dev-vote-btn \{ min-width: 0; padding-inline: 11px; \}/);
});

test('Needs you\'s card is the look\'s white card from 768px, with the page\'s cream on it', () => {
  // The review flow draws from --rf-* tokens, and its page was the page's
  // own ground: a cream card on the cream page.
  const block = lookBlock();
  const at = block.indexOf("NEEDS YOU'S CARD");
  assert.ok(at > 0, 'the block names it');
  assert.match(block.slice(at), /^[^{]*\*\/\s*@media \(min-width: 768px\) \{/, 'a card from 768px; a phone keeps the page\'s ground');
  const tokens = ruleAt(`${EITHER} :is(.rf-run, .rf-page-wrap)`);
  assert.ok(tokens, 'set once for both modes');
  assert.equal(valueOf(tokens.body, '--rf-page'), 'var(--bl-card)');
  assert.equal(valueOf(tokens.body, '--rf-sheet'), 'var(--bl-card)');
  assert.equal(valueOf(tokens.body, '--rf-fill'), 'var(--bl-page)', 'the buttons and the bar\'s disc are the page showing through');
  assert.match(ruleAt(`${EITHER} .rf-page`).body, /box-shadow:\s*0 0 0 1px var\(--app-sheet-line\), var\(--bl-lift-home\);/);
  // The chips not chosen were white, which the card is now.
  assert.match(ruleAt(`${EITHER} .rf-bar [aria-pressed="false"]`).body, /box-shadow:\s*var\(--bl-raise-edge\);/);
  // The review flow's own defaults are untouched.
  assert.match(read('public', 'css', 'app.css'), /\.rf-run, \.rf-page-wrap \{\s*--rf-page: var\(--home-ground\);/);
});

test('Messages on a phone is a white sheet with its rows flush on it', () => {
  // Below 768px Messages is the drawer (features/messages/phone-drawer.tsx),
  // whose list lies on a strip, the page's own cream in this look.
  const at = (sel) => ruleAt(`${EITHER} ${sel}`);
  assert.match(at('.messages-layout.messages-drawer').body, /background-color:\s*var\(--bl-card\);/, 'the look\'s card: white in light, one step off the page in dark');
  assert.match(at('.messages-layout.messages-drawer .messages-section-card').body, /box-shadow:\s*none;/, 'no card edge round rows that lie flush on the sheet');
  const search = at('.messages-layout.messages-drawer .messages-search-input').body;
  assert.match(search, /background:\s*var\(--bl-page\);/, 'the search field is the page\'s cream on the white');
  assert.match(at('.messages-layout.messages-drawer .messages-search-input:focus').body, /border-color:\s*var\(--brand-line\);/);
  assert.match(read('frontend', 'src', 'features', 'messages', 'index.tsx'), /const drawerClass = drawer\.on \? ` messages-drawer/, 'the class the rules key on');
});

test('the vote picker is the look\'s white card, with a sun Yes and a sun send', () => {
  // The picker that opens on Vote is one component in three places: a
  // card's body-mounted popover, the phone's bottom sheet, and Needs you's
  // vote sheet. Each host paints the same parts from the look's colours.
  const HOST = ':is(.dev-vote-pop, .dev-vote-sheet, .dev-ws-vote-form)';
  const at = (sel) => ruleAt(`${EITHER} ${sel}`);
  // The popover is the look's card, not the shell's generic one.
  const pop = at('.dev-vote-pop');
  assert.ok(pop, 'one rule for the popover, in both modes');
  assert.match(pop.body, /background:\s*var\(--bl-card\);/);
  assert.match(pop.body, /border-color:\s*var\(--bl-edge\);/);
  assert.match(pop.body, /box-shadow:\s*var\(--bl-lift-home\);/);
  // The switch sits on the page's cream inside that card.
  assert.match(at(`${HOST} .dev-vote-switch`).body, /background:\s*var\(--bl-page\);/);
  assert.match(at(`${HOST} .dev-vote-switch-opt:not([aria-pressed="true"]):hover`).body,
    /background:\s*var\(--bl-card\);/, 'hover is the card, not the shell\'s page fill');
  // A picked Yes is the sun; the ink outline is light's alone, as every sun
  // pill in this look is flat in dark.
  const yes = at(`${HOST} .dev-vote-switch-yes[aria-pressed="true"]`);
  assert.match(yes.body, /background:\s*var\(--bl-sun\);/);
  assert.match(yes.body, /color:\s*var\(--bl-on-sun\);/);
  assert.match(ruleAt(`${LIGHT} ${HOST} .dev-vote-switch-yes[aria-pressed="true"]`).body,
    /box-shadow:\s*inset 0 0 0 1px var\(--bl-on-sun\);/);
  assert.equal(ruleAt(`${DARK} ${HOST} .dev-vote-switch-yes[aria-pressed="true"]`), undefined,
    'no dark rule: the sun is flat there');
  // Its tally stays readable on the sun.
  assert.match(at(`${HOST} .dev-vote-switch-yes[aria-pressed="true"] .dev-vote-n`).body,
    /color:\s*var\(--bl-on-sun\);/);
  // The send is the page's own Vote pill.
  const send = at(`${HOST} .dev-vote-reason-send-yes`);
  assert.match(send.body, /background:\s*var\(--bl-sun\);/);
  assert.match(send.body, /color:\s*var\(--bl-on-sun\);/);
  assert.match(send.body, /box-shadow:\s*var\(--bl-pill-edge\);/);
  assert.match(at(`${HOST} .dev-vote-reason-send-yes:not(:disabled):hover`).body,
    /background:\s*var\(--bl-sun-lit\);/);
  assert.match(at(`${HOST} .dev-vote-reason-send-yes:not(:disabled):active`).body,
    /box-shadow:\s*var\(--bl-pill-edge-down\);/);
  // The line box wears the page's field edge; the reason chips its raised.
  assert.match(at(`${HOST} .dev-vote-reason-box`).body, /box-shadow:\s*var\(--bl-field-edge\);/);
  assert.match(at(`${HOST} .dev-vote-why-opt`).body, /box-shadow:\s*var\(--bl-raise-edge\);/);
  assert.match(at(`${HOST} .dev-vote-why-opt[aria-checked="true"]`).body, /box-shadow:\s*none;/,
    'the picked reason keeps its own fill and drops the edge');
  // The quiet words above the parts read the look's label ink.
  assert.match(at(`${HOST} :is(.dev-vote-switch-label, .dev-vote-uncounted, .dev-vote-reason-label)`).body,
    /color:\s*var\(--bl-label\);/);
  // Paint only: the three hosts are all covered, no size, padding or type
  // moves, and a No keeps the app's own red.
  const pieces = ['.dev-vote-pop', '.dev-vote-sheet', '.dev-ws-vote-form', '.dev-vote-switch',
    '.dev-vote-why', '.dev-vote-reason', '.dev-vote-uncounted'];
  const picker = lookRules().filter((rule) => rule.selectors.some((sel) => pieces.some((piece) => sel.includes(piece))));
  assert.ok(picker.length >= 10, 'the picker\'s rules are all in the block');
  for (const rule of picker) {
    for (const sel of rule.selectors) {
      assert.ok(['.dev-vote-pop', '.dev-vote-sheet', '.dev-ws-vote-form'].some((host) => sel.includes(host)),
        `"${sel}" is scoped to the picker's three hosts`);
    }
    assert.doesNotMatch(rule.body, /\bheight:|padding|font-size|font:/, `"${rule.selectors[0]}" changes no size or type`);
    assert.doesNotMatch(rule.body, /--state-blocked/, `"${rule.selectors[0]}" leaves a No its own red`);
  }
});
