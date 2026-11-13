// Tests for the brand look, "Paper, simplified, with brand styling": one of
// the Look menu's looks (Settings › Experimental › Look, an admin's
// preview). The head's window.Skin keeps the choice on the device and sets
// data-skin="brand" on <html> before first paint; app.css draws the look
// from that attribute in light mode only. It keeps the standard pages and
// redraws them in the website's colours and typefaces.
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
const FLAG = 'html[data-skin="brand"]:not(.dark):not([data-app-tone="dark"])';

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

test('every rule of the look is scoped to the flag, in light mode only', () => {
  let selectors = 0;
  for (const rule of lookRules()) {
    for (const sel of rule.selectors) {
      selectors += 1;
      assert.ok(sel.startsWith(FLAG), `"${sel}" must start from the flag, outside dark mode and dark apps`);
    }
  }
  assert.ok(selectors > 60, 'the block is read whole');
});

test('the block lives last and redeclares none of the counted wallpaper tokens', () => {
  const css = read('public', 'css', 'app.css');
  const block = lookBlock();
  assert.ok(css.trimEnd().endsWith(block.trimEnd()), 'appended at the very end of app.css');
  for (const token of ['--home-washes:', '--home-wallpaper:', '--dc-sheet-fill:', '--dc-frost:']) {
    assert.ok(!block.includes(token), `${token} is counted elsewhere and must not be redeclared here`);
  }
});

test('a card differs from the page by its fill: a deeper cream page, white cards, no outline', () => {
  const root = lookRules().find((rule) => rule.selectors.length === 1 && rule.selectors[0] === FLAG);
  assert.ok(root, 'the look sets its tokens on <html>');
  assert.match(root.body, /--bg-secondary:\s*#f6f2d8;/, 'the page');
  assert.match(root.body, /--bg-primary:\s*#ffffff;/, 'a card');
  assert.match(root.body, /--dc-sheet-solid:\s*#ffffff;/);
  assert.doesNotMatch(root.body, /#fffeea/, 'not the website\'s own cream: white cards would not stand out on it');
  // The outline every card is drawn with is a hairline too faint to read as
  // one; the fill and a soft lift say where a card ends.
  const line = lookRules().find((rule) => /--app-sheet-line:/.test(rule.body));
  assert.ok(line, 'the look sets the sheet line');
  assert.match(line.selectors[0], /:not\(\[data-contrast="more"\]\)$/, 'More contrast keeps its darker lines');
  const alpha = Number(line.body.match(/--app-sheet-line:\s*rgba\(18, 26, 14, ([\d.]+)\)/)[1]);
  assert.ok(alpha <= 0.08, 'faint');
  const cards = ruleFor('.dev-ws-strip').find((rule) => /box-shadow:/.test(rule.body));
  assert.ok(cards, 'cards take a lift');
  assert.match(cards.body, /box-shadow:\s*inset 0 0 0 1px var\(--app-sheet-line\), 0 1px 2px rgba\([^)]*\), 0 14px 30px -22px/);
  for (const sel of ['.messages-section-card', '.home-challenge-card', '.shadow-\\[inset_0_0_0_1px_var\\(--app-sheet-line\\)\\]']) {
    assert.ok(cards.selectors.some((s) => s.endsWith(sel)), `${sel} is one of them`);
  }
  // The pane a screen stands on is the page itself, flat.
  const strip = ruleFor('.dc-lift-strip')[0];
  assert.match(strip.body, /background-color:\s*#f6f2d8;/);
  assert.match(strip.body, /box-shadow:\s*none;/);
});

test('the sidebar is the deep sky with white words, and the row you are on is sun', () => {
  const css = lookBlock();
  const media = css.match(/@media \(min-width: 768px\) \{([\s\S]*?)\n\}\n/);
  assert.ok(media, 'the sidebar\'s rules apply from 768px, where the bar is a sidebar');
  const bar = ruleFor('#platform-tabs').find((rule) => rule.selectors[0] === `${FLAG} #platform-tabs`);
  assert.ok(bar, 'the bar itself');
  assert.match(bar.body, /background:\s*#1a63c4;/);
  // Its rows draw from the tokens, so hover and focus follow without a rule each.
  assert.match(bar.body, /--text-primary:\s*rgba\(255, 255, 255, 0\.94\);/);
  assert.match(bar.body, /--lit-tint:\s*rgba\(255, 255, 255, 0\.24\);/, 'what is hovered is a wash of white');
  assert.match(bar.body, /--lit-ink:\s*#ffffff;/);
  const here = ruleFor('[aria-current="page"]').find((rule) => /background:\s*#ffee6f;/.test(rule.body) && rule.selectors[0].includes('#platform-tabs'));
  assert.ok(here, 'the lit row');
  assert.match(here.body, /color:\s*#121a0e;/, 'ink on sun');
  assert.match(here.selectors[0], /\.platform-rail-community:not\(\[data-rail-open\]\)/, 'a community whose places are open is not lit; its place is');
  assert.ok(ruleFor('.platform-rail-nest-in::before').some((rule) => /background:\s*rgba\(255, 255, 255, 0\.45\);/.test(rule.body)),
    'the faint bar beside a community\'s nested rows');
});

test('the top bar is navy, darker than the sidebar, and a community\'s bar keeps its own colour', () => {
  const painted = lookRules().filter((rule) => rule.selectors.some((sel) => /#platform-header#platform-header(::before)?$/.test(sel)));
  assert.ok(painted.length >= 2, 'the top-level bar is restyled');
  for (const rule of painted) {
    for (const sel of rule.selectors) assert.match(sel, /:not\(\[data-community-tint\]\)/, `"${sel}" must leave a project's bar its community's colour`);
  }
  const bar = painted.find((rule) => /background-color:/.test(rule.body));
  assert.match(bar.body, /background-color:\s*#37477b;/);
  assert.match(bar.body, /--brand-ink:\s*#ffffff;/, 'white words');
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

test('on a phone the tab bar is the deep sky and its marker sun', () => {
  const css = lookBlock();
  assert.match(css, /@media \(max-width: 767\.98px\) \{/);
  const bar = lookRules().find((rule) => rule.selectors[0] === `${FLAG} .platform-tabs`);
  assert.match(bar.body, /--lit-tint:\s*#ffee6f;/, 'the marker draws from the lit tint');
  assert.match(bar.body, /--lit-ink:\s*#121a0e;/, 'and the tab on it is ink');
  assert.ok(ruleFor('.platform-tabs::before').some((rule) => /background:\s*#1a63c4;/.test(rule.body)));
});

test('one accent for "do this", and the old blue as words is the deep sky', () => {
  const pill = ruleFor('.bg-violet-600').find((rule) => /background-color:\s*#ffee6f;/.test(rule.body));
  assert.ok(pill, 'the main button is a sun pill');
  assert.match(pill.body, /box-shadow:\s*inset 0 0 0 1px #121a0e, 0 2px 0 #121a0e;/, 'on the website\'s ink outline and hard foot');
  const words = ruleFor('.text-violet-600')[0];
  assert.match(words.body, /color:\s*#1a63c4;/);
  const count = ruleFor('.dev-ws-foryou-pill:not([data-ws-channel-unread])')[0];
  assert.match(count.body, /background:\s*#1a63c4;/);
  assert.match(count.body, /color:\s*#ffffff;/);
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
