// Request #6984: Settings › Appearance gets a Template Chooser card under
// Theme, offering Standard and the Sunrise style (a Light and a Dark picture
// of the real Home screen, each a radio choice that applies the style at
// once). Sunrise is a template, not a data-skin look: window.Skin sets
// data-template="sunrise" and no data-skin, so the standard pages stay and
// app.css changes only the token values.
//
// Run with: node --test tests/template-chooser.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const THEME = 'frontend/src/features/settings/sections/theme.tsx';

test('the card ships under Theme, with Standard and Sunrise in light and dark', () => {
  const html = renderComponent(THEME, 'ThemeSection');

  assert.match(html, /Template Chooser/, 'its heading');
  assert.match(html, /Choose a visual style for your space\./, 'its one sentence');
  assert.match(html, /Sunrise/, 'the style is named');

  // Three radio choices: Standard, then the two pictures. The prerender has
  // nothing checked (the live look and appearance are client-only) and the
  // first is the one tab stop, exactly as the shared radio-group promise says.
  const options = ['standard', 'sunrise-light', 'sunrise-dark'];
  options.forEach((option, i) => {
    const btn = html.match(new RegExp(`<button[^>]*data-template-choice="${option}"[^>]*>`));
    assert.ok(btn, `${option} choice missing`);
    assert.match(btn[0], new RegExp(`tabindex="${i === 0 ? 0 : -1}"`), `${option} tabindex`);
    assert.match(btn[0], /aria-checked="false"/, `${option} starts unchecked`);
  });
  assert.match(html, /role="radiogroup"/);

  // The two pictures are real static files, each under the card's own origin
  // and small enough to load with the settings screen.
  for (const [file, alt] of [
    ['sunrise-light.webp', /alt="The Home screen in Sunrise, light appearance"/],
    ['sunrise-dark.webp', /alt="The Home screen in Sunrise, dark appearance"/],
  ]) {
    assert.match(html, new RegExp(`src="/brand/templates/${file.replace('.', '\\.')}"`), `${file} is drawn`);
    assert.match(html, alt, `${file} says what it shows`);
    // Width and height are declared, and the picture is NOT lazy: the card
    // sits below the fold, and a lazy image is never fetched by a capture
    // that does not scroll, so it would show blank and look like a 404.
    const img = html.match(new RegExp(`<img[^>]*src="/brand/templates/${file.replace('.', '\\.')}"[^>]*>`));
    assert.ok(img, `${file} renders an <img>`);
    assert.match(img[0], /width="160"/, `${file} declares its width`);
    assert.match(img[0], /height="190"/, `${file} declares its height`);
    assert.doesNotMatch(img[0], /loading="lazy"/, `${file} loads without a scroll`);
    const full = path.join(ROOT, 'public', 'brand', 'templates', file);
    assert.ok(fs.existsSync(full), `public/brand/templates/${file} exists`);
    assert.ok(fs.statSync(full).size < 60 * 1024, `${file} is under 60 KB`);
  }
});

test('a pick applies the template and its appearance at once', () => {
  const src = read(THEME);
  const at = src.indexOf('function TemplateChooser()');
  assert.ok(at > 0, 'the chooser component is located');
  const choose = src.slice(src.indexOf('const choose = useCallback(', at), src.indexOf('const keys = radioGroupKeys', at));
  assert.ok(choose, 'the pick handler is located');
  // Standard goes back to today's look and leaves the appearance alone.
  assert.match(choose, /if \(next === 'standard'\) \{\s*window\.Skin\?\.set\?\.\('standard'\);\s*\} else \{/);
  // Sunrise sets the appearance first, then the style.
  assert.match(choose, /window\.Theme\?\.set\?\.\(next === 'sunrise-dark' \? 'dark' : 'light'\);/);
  assert.match(choose, /window\.Skin\?\.set\?\.\('sunrise'\);/);
  assert.ok(choose.indexOf("window.Theme?.set?.") < choose.indexOf("window.Skin?.set?.('sunrise')"),
    'the appearance is set before the style');

  // The highlight follows the device's look and appearance, from every door.
  assert.match(src, /window\.Skin\?\.onChange\?\.\(sync\)/);
  assert.match(src, /window\.Theme\?\.onChange\?\.\(sync\)/);
  assert.match(src, /useWindowEvent\('usernode:settings-section', sync\)/);
  assert.match(src, /currentSkin\(\)/);
  assert.match(src, /classList\.contains\('dark'\)/);
});

test('Sunrise draws the standard pages from token values, never from data-skin', () => {
  const css = read('public/css/app.css');
  const light = css.indexOf('html[data-template="sunrise"]:not([data-skin]) {');
  assert.ok(light > 0, 'the light token block');
  const dark = css.indexOf('html[data-template="sunrise"]:not([data-skin]).dark {');
  assert.ok(dark > light, 'the dark token block follows it');
  const block = css.slice(light, dark + 600);
  for (const token of ['--accent:', '--text-primary:', '--dc-sheet-solid:', '--app-sheet-line:', '--lit-ink:']) {
    assert.ok(block.includes(token), `${token} is part of Sunrise`);
  }
  assert.ok(!css.includes('data-skin="sunrise"'), 'there is no data-skin="sunrise" anywhere');

  // Every control on the card is a finger-sized target on a phone (#6984's
  // review): the Standard row and each picture tile are at least 44px tall.
  const opt = css.slice(css.indexOf('#settings-root .tc-opt {'), css.indexOf('#settings-root .tc-style {'));
  assert.match(opt, /min-height: 44px;/, 'the Standard row is 44px tall');
  const tile = css.slice(css.indexOf('#settings-root .tc-tile {'), css.indexOf('#settings-root .tc-tile.tc-tile-on'));
  assert.ok(/height: 190px;/.test(css.slice(css.indexOf('#settings-root .tc-pic {'))), 'the tiles carry a 190px picture');

  const head = read('frontend/src/head.html');
  assert.match(head, /root\.setAttribute\('data-template', 'sunrise'\)/);
  assert.match(head, /skin !== 'sunrise'/,
    'sunrise is left out of the data-skin branch too');
});
