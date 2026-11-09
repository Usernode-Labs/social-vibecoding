// The look picker beside the bell (frontend/src/features/frame/look-picker
// .tsx): an admin's way to switch the device's look from any screen, in the
// frame's bar under a look and in the platform's header under the standard
// one, so a look can always be left the way it was entered. It is the same
// choice as Settings > Experimental > Look (window.Skin, kept on the
// device), offered to real admins only.
//
// Run with: node --test tests/look-picker.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PICKER = 'frontend/src/features/frame/look-picker.tsx';
const view = (props) => renderComponent(PICKER, 'LookPickerView', { onPick() {}, ...props }, { cache: false });

test('it is one small control: a glyph, and under it the system\'s own menu of looks', () => {
  const html = view({ variant: 'frame', skin: 'glass' });
  assert.match(html, /^<label class="fr-ib fr-look" title="Look" data-look-picker="frame"><svg[^>]*>.*?<\/svg><select aria-label="Look">/s);
  assert.deepEqual([...html.matchAll(/<option value="([a-z]+)"( selected="")?>([^<]+)<\/option>/g)].map((m) => [m[1], m[3], !!m[2]]), [
    ['standard', 'Standard', false], ['glass', 'Glass', true], ['brandkit', 'Brand kit', false], ['workbench', 'Workbench', false],
    ['paper', 'Paper', false], ['pastel', 'Pastel', false], ['mosaic', 'Mosaic', false], ['sunrise', 'Sunrise', false],
    ['today', 'Today', false], ['playground', 'Playground', false],
  ], 'Standard, then the nine looks in the tour\'s order, the device\'s own chosen');
});

test('under the standard look it is drawn with the header\'s own classes, beside its bell', () => {
  const html = view({ variant: 'shell', skin: 'standard' });
  assert.match(html, /^<label class="relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target [^"]*" title="Look" data-look-picker="shell">/);
  assert.match(html, /<select aria-label="Look" class="absolute inset-0 h-full w-full cursor-pointer opacity-0">/);
  assert.match(html, /<option value="standard" selected="">Standard<\/option>/);
  assert.doesNotMatch(html, /fr-ib|fr-look/, 'not the kit\'s disc: the kit\'s rules exist only under a look');
  assert.match(html, /<svg class="fr-ic" width="20" height="20"/, 'the glyph sizes itself, with or without the kit');
});

test('real admins only, and never on the first render', () => {
  const src = read(PICKER);
  assert.match(src, /whenPlatformViewer\(\(\) => setAdmin\(\(window as any\)\.App\?\._realIsAdmin === true\)\)/,
    'the un-masked answer, as Settings reads it: "view as a member" does not take the way back away');
  assert.match(src, /if \(!admin\) return null;/);
  assert.equal(renderComponent(PICKER, 'LookPicker', { variant: 'frame' }, { cache: false, stubs: { '../../lib/platform-viewer': { whenPlatformViewer: () => () => {} } } }), '',
    'the prerendered document and the first client render agree: nothing');
  assert.match(src, /window\.Skin\?\.set\?\.\(next\)/, 'the choice is the head module\'s, kept on the device');
  assert.match(src, /const skin = useLiveSkin\(\);/);
});

test('it sits just before the bell in both bars', () => {
  const frame = read('frontend/src/features/frame/frame-app.tsx');
  assert.match(frame, /<LookPicker variant="frame" \/>\s*<button type="button" className=\{k\('ib'\)\} aria-label=\{t\('core:header\.notifications'\)\}/);
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.match(header, /<LookPicker variant="shell" \/>[\s\S]{0,900}?id="notifications-btn"/);
  assert.ok(header.indexOf('<LookPicker variant="shell" />') < header.indexOf('id="notifications-btn"'));
});

test('under a look the menu lies over the glyph, unseen, and takes the press', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] \.fr-look \{ position: relative; cursor: pointer; \}/);
  assert.match(hand, /html\[data-skin\] \.fr-look > select \{ position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; \}/);
});
