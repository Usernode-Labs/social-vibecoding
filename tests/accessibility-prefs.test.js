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

test('the size control is a labelled radiogroup reusing the theme segments', () => {
  const src = sectionSrc();
  assert.match(src, /id="settings-text-size-track"/);
  assert.match(src, /role="radiogroup"/);
  assert.match(src, /theme-seg/,
    'the track reuses the .theme-seg classes app.css keys the recessed look off');
  // The segments are the shipped markup, so render the pane the way the
  // browser hydrates it and assert the buttons are there.
  const html = renderComponent(
    'frontend/src/features/settings/sections/accessibility.tsx',
    'AccessibilitySection',
  );
  const track = html.match(/<div id="settings-text-size-track"[^>]*>/);
  assert.ok(track, 'the text size track is missing from the rendered pane');
  assert.match(track[0], /role="radiogroup"/, 'the track is a radiogroup');
  for (const size of ['normal', 'large', 'larger']) {
    const btn = html.match(new RegExp(`<button[^>]*data-text-size-option="${size}"[^>]*>`));
    assert.ok(btn, `a segment button for ${size} must exist`);
    assert.match(btn[0], /role="radio"/, `the ${size} segment carries role=radio`);
    assert.doesNotMatch(btn[0], /theme-seg-active/,
      `the ${size} segment ships unselected (storage is read in an effect)`);
  }
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
    'text size font bigger larger zoom read contrast');
});

// ── The catalog ──────────────────────────────────────────────────────────

test('the pane\'s catalog ids resolve', () => {
  for (const id of [
    'settings:accessibility.textSize.title',
    'settings:accessibility.textSize.intro',
    'settings:accessibility.textSize.controlName',
    'settings:accessibility.textSize.normal',
    'settings:accessibility.textSize.large',
    'settings:accessibility.textSize.larger',
    'settings:accessibility.contrast.label',
    'settings:accessibility.contrast.description',
  ]) {
    assert.ok(message(id), `${id} resolves in the English catalog`);
  }
  assert.equal(message('settings:accessibility.textSize.larger'), 'Larger');
  assert.equal(message('settings:accessibility.contrast.description'),
    'Darker text and clearer lines, in light and dark.');
});
