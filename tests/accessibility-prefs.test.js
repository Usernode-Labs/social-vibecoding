// Tests for the text size and high contrast accessibility prefs (#3969).
//
// Static-assertion style (cf. tests/theme-mode.test.js): read the shipped
// source files and assert the wiring is present, so the feature can't
// silently regress.
//
// Run with: node --test tests/accessibility-prefs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const headSrc = () =>
  fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'head.html'), 'utf8');
const cssSrc = () =>
  fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
const sectionSrc = () =>
  fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'features', 'settings', 'sections', 'accessibility.tsx'),
    'utf8',
  );
const settingsJs = () =>
  fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'features', 'settings', 'settings.js'),
    'utf8',
  );

// ── The inline head module ───────────────────────────────────────────────

test('the inline head module exposes the Display API', () => {
  const src = headSrc();
  assert.match(src, /window\.Display\s*=/, 'head.html must assign window.Display');
  for (const fn of ['getTextSize', 'setTextSize', 'getContrast', 'setContrast', 'apply', 'onChange']) {
    assert.match(src, new RegExp(`function ${fn}\\b`), `the Display module must define ${fn}()`);
  }
});

test('the Display module implements the storage contract', () => {
  const src = headSrc();
  // 'large' / 'larger' stored explicitly; Normal removes the key. Contrast
  // stores 'more'; off removes the key. Unknown stored values read as the
  // defaults, and blocked storage answers the defaults too.
  assert.match(src, /'homeroom:text-size'/, "the size key must be 'homeroom:text-size'");
  assert.match(src, /'homeroom:contrast'/, "the contrast key must be 'homeroom:contrast'");
  assert.match(src, /setItem\(\s*SIZE_KEY/, 'setTextSize() must persist the key for large/larger');
  assert.match(src, /removeItem\(\s*SIZE_KEY/, 'setTextSize() must remove the key for Normal');
  assert.match(src, /setItem\(\s*CONTRAST_KEY/, 'setContrast() must persist the key when on');
  assert.match(src, /removeItem\(\s*CONTRAST_KEY/, 'setContrast() must remove the key when off');
  assert.match(src, /getContrast[\s\S]*?===\s*'more'/, "contrast is stored as 'more'");
  assert.match(src, /try\s*\{/, 'localStorage access must be wrapped in try/catch');
});

test('the Display module applies before first paint and on cross-tab changes', () => {
  const src = headSrc();
  // The module IS the no-flash guard: it ends by calling apply(), inline in
  // <head>, ahead of the stylesheets that read its attributes.
  const at = src.indexOf('window.Display =');
  const applyAt = src.indexOf('apply();\n', at);
  assert.ok(applyAt > at, 'the Display module must call apply() before first paint');
  const displayAt = src.indexOf('window.Display =');
  const cssAt = src.indexOf('<link rel="stylesheet"');
  assert.ok(cssAt > 0 && displayAt < cssAt,
    'the Display module must run before the first stylesheet link');
  // It writes the attributes on <html>, outside React's body tree.
  assert.match(src.slice(at, applyAt), /documentElement/,
    'apply() writes its attributes on <html>');
  assert.match(
    src,
    /addEventListener\(\s*'storage'/,
    'the Display module must listen for cross-tab storage changes',
  );
});

// ── The app.css rules ────────────────────────────────────────────────────

test('app.css scales the root font for the two presets', () => {
  const css = cssSrc();
  assert.match(css, /html\[data-text-size="large"\]\s*\{\s*font-size:\s*112\.5%/,
    'Large is 112.5%');
  assert.match(css, /html\[data-text-size="larger"\]\s*\{\s*font-size:\s*125%/,
    'Larger is 125%');
});

// The body of the first top-level rule whose selector list is exactly
// `selector` (not the last line of a longer list).
function cssRule(css, selector) {
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    if (css[at - 1] !== ',') return css.slice(at, css.indexOf('}', at));
  }
  assert.fail(`app.css has a ${selector} rule of its own`);
}

test('Messages\' words are sized in rem, so Text size reaches them, at the same sizes by default', () => {
  // Text size scales rem. These were fixed pixels, so at 150% the page's
  // headings grew and the messages themselves did not.
  const css = cssSrc();
  const sizes = {
    '.messages-row-name': 15,
    '.messages-row-preview': 13,
    '.messages-row-time': 13,
    '.messages-unread': 13,
    '.messages-message-head': 17,
    '.messages-markdown.gc-msg-content': 17,
    '.messages-bubble': 17,
    '.messages-edit textarea': 17,
    '.messages-composer-input': 17,
  };
  for (const [selector, px] of Object.entries(sizes)) {
    const size = /font-size: ([\d.]+)rem;/.exec(cssRule(css, selector));
    assert.ok(size, `${selector} is sized in rem`);
    assert.equal(Number(size[1]) * 16, px, `${selector} is ${px}px at the default size`);
  }
  assert.match(css, /\n\.messages-message-head time,\n\.messages-message-head time ~ span \{[^}]*font-size: 0\.9375rem;/,
    'a message\'s time is 15px at the default size');
  // What you type is the size it will be drawn at, at every text size: the
  // composer's leading scales with its text (22px at the default size).
  assert.match(cssRule(css, '.messages-composer-input'), /line-height: 1\.375rem;/);
  // A long name gives way before the time is pushed past the column's edge.
  assert.match(cssRule(css, '.messages-message-head'), /max-width: 100%;/);
});

test('on a phone, a Home icon is never wider than its cell, so large text sizes cannot make icons meet', () => {
  const css = cssSrc();
  const at = css.indexOf('html:not([data-skin]) #app-list > .app-card > .relative { width: min(');
  assert.ok(at >= 0, 'the phone grid bounds the icon by its cell');
  assert.ok(css.lastIndexOf('@media (max-width: 639.98px) {', at) > css.lastIndexOf('\n}\n', at),
    'inside the phone block, not the wider grids\'');
  assert.match(css.slice(at), /^[^}]*width: min\(3\.5rem, calc\(100% - 0\.1875rem\)\); height: auto; aspect-ratio: 1 \/ 1; \}/,
    '3.5rem at the default size, and less only when the cell is narrower');
  assert.match(css, /html:not\(\[data-skin\]\) #app-list > \.app-card > \.relative > \.app-icon-tile \{ width: 100%; height: 100%; border-radius: min\(1\.25rem, 36%\); \}/);
});

// ── The slider's steps (#6510) ───────────────────────────────────────────

// The head's Display module, run alone against a fake page.
function loadDisplay(stored = {}) {
  const src = headSrc();
  const at = src.indexOf('window.Display = (function');
  const block = src.slice(at, src.indexOf('</script>', at));
  const attrs = {};
  const store = { ...stored };
  const window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    addEventListener() {},
  };
  const document = {
    documentElement: {
      getAttribute: (n) => (n in attrs ? attrs[n] : null),
      setAttribute: (n, v) => { attrs[n] = String(v); },
      removeAttribute: (n) => { delete attrs[n]; },
    },
  };
  new Function('window', 'document', block)(window, document);
  return { Display: window.Display, attrs, store };
}

test('every stop of the slider is stored, applied and sized by app.css', () => {
  const css = cssSrc();
  const percents = { large: '112.5', larger: '125', xlarge: '137.5', xxlarge: '150' };
  const { Display, attrs, store } = loadDisplay();
  assert.equal(Display.getTextSize(), 'normal');
  for (const [size, percent] of Object.entries(percents)) {
    Display.setTextSize(size);
    assert.equal(store['homeroom:text-size'], size, `${size} is stored by name`);
    assert.equal(Display.getTextSize(), size);
    assert.equal(attrs['data-text-size'], size, `${size} lands on <html>`);
    assert.match(
      css,
      new RegExp(`html\\[data-text-size="${size}"\\]\\s*\\{\\s*font-size:\\s*${percent.replace('.', '\\.')}%`),
      `${size} is ${percent}%`,
    );
  }
  Display.setTextSize('normal');
  assert.equal('homeroom:text-size' in store, false, 'Normal removes the key');
  assert.equal('data-text-size' in attrs, false);
});

test('a size stored before the slider still applies, and an unknown one reads as Normal', () => {
  for (const preset of ['large', 'larger']) {
    const { Display, attrs } = loadDisplay({ 'homeroom:text-size': preset });
    assert.equal(Display.getTextSize(), preset);
    assert.equal(attrs['data-text-size'], preset, 'applied before first paint');
  }
  const odd = loadDisplay({ 'homeroom:text-size': 'gigantic' });
  assert.equal(odd.Display.getTextSize(), 'normal');
  assert.equal('data-text-size' in odd.attrs, false);
  odd.Display.setTextSize('gigantic');
  assert.equal('homeroom:text-size' in odd.store, false, 'an unknown size is never stored');
});

test('app.css carries both contrast modes, scoped per theme', () => {
  const css = cssSrc();
  assert.match(css, /html:not\(\.dark\)\[data-contrast="more"\]\s*\{/,
    'the light contrast block is scoped to html:not(.dark)');
  assert.match(css, /html\.dark\[data-contrast="more"\]\s*\{/,
    'the dark contrast block is scoped to html.dark');
  // Secondary ink and hairlines, both modes.
  assert.match(css, /html:not\(\.dark\)\[data-contrast="more"\]\s*\{[^}]*--text-muted:\s*#3a3a3c/);
  assert.match(css, /html\.dark\[data-contrast="more"\]\s*\{[^}]*--text-muted:\s*#e3e3e6/);
  // The Tailwind utilities, whose literals live in tailwind.config.js, are
  // darkened by attribute-prefixed rules in app.css, which outrank them.
  assert.match(css, /html:not\(\.dark\)\[data-contrast="more"\]\s+\.text-zinc-400/);
  assert.match(css, /html\.dark\[data-contrast="more"\]\s+\.dark\\:text-zinc-400/);
});

test('every colour in the contrast block is one the app already uses', () => {
  const css = cssSrc();
  const block = css.slice(css.indexOf('/* ── Accessibility: text size'), css.indexOf('usernode-native kit theming'));
  const hexes = [...new Set((block.match(/#[0-9a-f]{6}/gi) || []).map((h) => h.toLowerCase()))];
  assert.ok(hexes.length > 0, 'the block declares its colours');
  const elsewhere = css.replace(block, '');
  for (const hex of hexes) {
    assert.ok(
      elsewhere.toLowerCase().includes(hex),
      `${hex} must already exist in app.css outside the contrast block (no new palette)`,
    );
  }
});

// ── The settings pane ────────────────────────────────────────────────────

test('the Accessibility section reads and writes through window.Display', () => {
  const src = sectionSrc();
  assert.match(src, /window\.Display\?\.getTextSize\?\.\(\)/, 'the control must read Display.getTextSize()');
  assert.match(src, /window\.Display\?\.setTextSize\?\.\(next\)/, 'and call Display.setTextSize()');
  assert.match(src, /window\.Display\?\.getContrast\?\.\(\)/, 'the switch must read Display.getContrast()');
  assert.match(src, /window\.Display\?\.setContrast\?\.\(next\)/, 'and call Display.setContrast()');
  assert.match(src, /window\.Display\?\.onChange\?\.\(sync\)/,
    'a cross-tab storage change must re-read here too');
});

test('the pane renders no selection in its initial markup', () => {
  const src = sectionSrc();
  // Storage is client-only; reading it during render would mismatch the
  // prerendered document. The layout effect fills the values in.
  assert.match(src, /useState<TextSize \| null>\(null\)/,
    'the size starts null, exactly as the prerender ships');
  assert.match(src, /useState\(false\)/,
    'the switch starts off, which is the default');
});

test('the size control is a labelled slider of five stops (#6510)', () => {
  const src = sectionSrc();
  assert.match(src, /id="settings-text-size-track"/);
  assert.match(src, /TEXT_SIZES = \['normal', 'large', 'larger', 'xlarge', 'xxlarge'\] as const/,
    'the two presets keep their names and their places');
  // The size applies on the browser's own change (release, or a key press),
  // not on every input event of a drag.
  assert.match(src, /addEventListener\('change', apply\)/);
  assert.match(src, /removeEventListener\('change', apply\)/);
  assert.doesNotMatch(src, /onChange=\{[^}]*setTextSize/,
    'React onChange is the input event: it must not resize the page mid-drag');
  // The slider is the shipped markup, so render the pane the way the
  // browser hydrates it.
  const html = renderComponent(
    'frontend/src/features/settings/sections/accessibility.tsx',
    'AccessibilitySection',
  );
  const track = html.match(/<div id="settings-text-size-track"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(track, 'the text size track is missing from the rendered pane');
  const input = track[0].match(/<input[^>]*>/);
  assert.ok(input, 'the track holds the slider');
  assert.match(input[0], /type="range"/);
  assert.match(input[0], /min="0"/);
  assert.match(input[0], /max="4"/);
  assert.match(input[0], /step="1"/);
  assert.match(input[0], /value="0"/, 'it ships at Normal (storage is read in an effect)');
  const name = message('settings:accessibility.textSize.controlName');
  assert.ok(input[0].includes(`aria-label="${name}"`), 'a screen reader hears its name');
  assert.ok(input[0].includes('aria-valuetext="100%"'), 'and the size as a percentage');
  assert.equal(message('settings:accessibility.textSize.percent'), '{{percent}}%');
  assert.match(track[0], /<span[^>]*aria-hidden="true"[^>]*data-text-size-value=""[^>]*>100%<\/span>/,
    'the figure beside it is for the eye only: the slider already says it');
  assert.doesNotMatch(track[0], /role="radio/, 'the three segments are gone');
  assert.ok(html.includes('id="settings-high-contrast"'),
    'the High contrast switch renders');
});

// ── The registry ─────────────────────────────────────────────────────────

// #5285 left Theme alone on Appearance, so Accessibility follows it directly.
test('Accessibility is a one-part page in Preferences, right after Appearance', () => {
  const settings = settingsJs();
  const list = settings.slice(settings.indexOf('SECTIONS: ['), settings.indexOf('    PAGES: {'));
  const prev = list.indexOf("{ key: 'theme'");
  const entry = list.indexOf("{ key: 'accessibility', label: 'settings:nav.part.accessibility', group: 'settings:nav.group.preferences' }");
  assert.ok(entry !== -1, 'the accessibility part is registered');
  assert.ok(prev !== -1 && entry > prev, 'it sits after theme');
  assert.ok(!/\{ key: '[a-z-]+'/.test(list.slice(list.indexOf('\n', prev), entry)),
    'with no part between them');
  assert.ok(entry < list.indexOf("{ key: 'language'"), 'and before Language');
  assert.equal(message('settings:nav.part.accessibility'), 'Accessibility');
  assert.match(settings, /accessibility: 'settings:nav\.keywords\.accessibility',/);
  assert.equal(message('settings:nav.keywords.accessibility'),
    'text size font bigger larger zoom read contrast high normal accessible vision motion animation reduce');
});

// ── The catalog ──────────────────────────────────────────────────────────

test('the pane\'s catalog ids resolve', () => {
  for (const id of [
    'settings:accessibility.textSize.title',
    'settings:accessibility.textSize.intro',
    'settings:accessibility.textSize.controlName',
    'settings:accessibility.textSize.percent',
    'settings:accessibility.textSize.sample',
    'settings:accessibility.contrast.label',
    'settings:accessibility.contrast.description',
  ]) {
    assert.ok(message(id), `${id} resolves in the English catalog`);
  }
  assert.equal(message('settings:accessibility.contrast.description'),
    'Darker text and clearer lines, in light and dark.');
});

// ── What a screen reader is told (#6510) ─────────────────────────────────

test('each switch is read with the sentence under it', () => {
  const html = renderComponent(
    'frontend/src/features/settings/sections/accessibility.tsx',
    'AccessibilitySection',
  );
  const seen = new Set();
  for (const [id, key] of [
    ['settings-high-contrast', 'contrast'],
    ['settings-reduce-motion', 'motion'],
    ['settings-card-previews', 'previews'],
  ]) {
    const sw = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(sw, `${id} renders`);
    const noteId = (sw[0].match(/aria-describedby="([^"]+)"/) || [])[1];
    assert.ok(noteId, `${id} names its description`);
    assert.ok(!seen.has(noteId), 'each switch has its own');
    seen.add(noteId);
    const start = html.indexOf(`<p id="${noteId}"`);
    assert.ok(start >= 0, `${id}: the description carries that id`);
    const note = html.slice(html.indexOf('>', start) + 1, html.indexOf('</p>', start))
      .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.equal(note, message(`settings:accessibility.${key}.description`), `${id} is described by its own sentence`);
  }
});

test('the project page is the main landmark, like every other screen', () => {
  const html = renderComponent('frontend/src/features/app-frame/app-view-island.tsx', 'AppViewIsland');
  const root = html.match(/<div id="app-view"[^>]*>/);
  assert.ok(root, '#app-view is still a div');
  assert.match(root[0], /role="main"/);
  assert.equal((html.match(/role="main"|<main\b/g) || []).length, 1, 'and holds no second one');
});
