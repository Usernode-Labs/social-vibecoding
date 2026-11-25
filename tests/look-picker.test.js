// The look picker in the frame's bar (frontend/src/features/frame/look-picker
// .tsx): an admin's way to switch the device's look from under a look, so a
// look can always be left the way it was entered. Under the standard header,
// Settings > Experimental > Look is where a look is chosen. It is the same
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
  const html = view({ variant: 'frame', skin: 'brand' });
  assert.match(html, /^<label class="fr-ib fr-look" title="Look" data-look-picker="frame"><svg[^>]*>.*?<\/svg><select aria-label="Look">/s);
  assert.deepEqual([...html.matchAll(/<option value="([a-z]+)"( selected="")?>([^<]+)<\/option>/g)].map((m) => [m[1], m[3], !!m[2]]), [
    ['standard', 'Standard', false], ['brand', 'Paper, simplified, with brand styling', true],
  ], 'two looks (24 Nov 2026, #7071): Standard and Paper simplified, the device\'s own chosen');
  // Paper, the frame's last look, is offered no more: a head that still answered it reads as Standard.
  assert.match(view({ variant: 'frame', skin: 'paper' }), /<option value="standard" selected="">/);
});

test('the menu reads the look that is on, and an unknown one as Standard', () => {
  // "Paper, simplified, with brand styling" is the frame's own look.
  const html = view({ variant: 'frame', skin: 'brand' });
  assert.match(html, /<option value="brand" selected="">Paper, simplified, with brand styling<\/option>/);
  assert.doesNotMatch(html, /<option value="standard" selected="">/);
  assert.match(view({ variant: 'frame', skin: 'neon' }), /<option value="standard" selected="">/, 'an unknown look reads as Standard');
});

test('real admins only, and never on the first render', () => {
  const src = read(PICKER);
  assert.match(src, /whenPlatformViewer\(\(\) => setAdmin\(\(window as any\)\.App\?\._realIsAdmin === true\)\)/,
    'the un-masked answer, as Settings reads it: "view as a member" does not take the way back away');
  assert.match(src, /if \(!admin\) return null;/);
  assert.equal(renderComponent(PICKER, 'LookPicker', { variant: 'frame' }, { cache: false, stubs: { '../../lib/platform-viewer': { whenPlatformViewer: () => () => {} } } }), '',
    'the prerendered document and the first client render agree: nothing');
  assert.match(src, /window\.Skin\?\.set\?\.\(next\)/, 'the choice is the head module\'s, kept on the device');
  assert.match(src, /window\.Skin\?\.set\?\.\(next\);[\s\S]{0,400}?window\.scrollTo\(0, 0\)/, 'and the page starts at its top under the new look\'s bar');
  assert.match(src, /const skin = useLiveSkin\(\);/);
});

test('the head module is the one place a pick is written', () => {
  // The picker and Settings only hand the look to window.Skin, which owns
  // data-skin, storage and the address. Nothing else repaints <html> or
  // keeps a second copy, so the fix lives in one place.
  for (const src of [read(PICKER), read('frontend/src/features/settings/settings.js')]) {
    assert.doesNotMatch(src, /setAttribute\(\s*['"]data-skin/, 'no control writes data-skin itself');
  }
  assert.doesNotMatch(read(PICKER), /localStorage/, 'the picker keeps no copy of the look');
  assert.match(read(PICKER), /window\.Skin\?\.set\?\.\(next\);/, 'the picker\'s pick goes through the head module');
});

test('it sits just before the bell in the frame\'s bar, and the header draws none', () => {
  const frame = read('frontend/src/features/frame/frame-app.tsx');
  assert.match(frame, /<LookPicker variant="frame" \/>\s*<button type="button" className=\{k\('ib'\)\} aria-label=\{t\('core:header\.notifications'\)\}/);
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.doesNotMatch(header, /LookPicker/, 'the platform header keeps only its bell at that end');
});

test('under a look the menu lies over the glyph, unseen, and takes the press', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] \.fr-look \{ position: relative; cursor: pointer; \}/);
  assert.match(hand, /html\[data-skin\] \.fr-look > select \{ position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; \}/);
});

test('beside the look, one press flips light and dark', () => {
  // A look is judged in both: the toggle sits with the picker, between it
  // and the bell, and says which one is on.
  const light = view({ variant: 'frame', skin: 'glass', dark: false, onDark() {} });
  assert.match(light, /<\/label><button type="button" class="fr-ib fr-d" aria-pressed="false" aria-label="Dark" title="Dark" data-look-theme="frame"><svg[^>]*>.*?<\/svg><\/button><span class="fr-lookfold fr-p" data-look-fold="">/s);
  // On a phone the two are one disc (the pair is the kit's "desktop only",
  // the disc its "phone only"), so the bar's title has room; its small menu,
  // closed until pressed, holds Look and Theme.
  assert.match(light, /^<label class="fr-ib fr-look fr-d" title="Look" data-look-picker="frame">/);
  assert.match(light, /<span class="fr-lookfold fr-p" data-look-fold=""><button type="button" class="fr-ib" aria-haspopup="true" aria-expanded="false" aria-label="Look and theme" title="Look and theme"><svg[^>]*>.*?<\/svg><\/button><\/span>$/s);
  const picker = read('frontend/src/features/frame/look-picker.tsx');
  assert.match(picker, /data-look-fold-look=""[\s\S]*?<select aria-label=\{t\('settings:experimental\.look\.label'\)\} value=\{value\}/, 'the menu\'s Look row is the system\'s own menu of looks');
  assert.match(picker, /data-look-fold-theme="" onClick=\{onDark\}/, 'and its Theme row flips light and dark');
  // The glyph is where a press goes: the moon while it is light, the sun while it is dark.
  const dark = view({ variant: 'frame', skin: 'glass', dark: true, onDark() {} });
  const icons = read('frontend/@/components/ui/kit-icons.ts');
  const d = (name) => icons.match(new RegExp(`^  ${name}: "(.*)",?$`, 'm'))[1].replace(/\\"/g, '"');
  assert.ok(light.includes(d('moon')) && !light.includes(d('sun')));
  assert.ok(dark.includes(d('sun')) && !dark.includes(d('moon')));
});

test('the toggle is the theme\'s own switch, and follows it wherever it is changed', () => {
  const src = read(PICKER);
  assert.match(src, /window\.Theme\?\.set\?\.\(dark \? 'light' : 'dark'\)/, 'an explicit choice, kept on the device as Settings > Theme keeps it');
  assert.match(src, /useSyncExternalStore\(subscribeTheme, isDark, \(\) => false\)/);
  assert.match(src, /document\.documentElement\.classList\.contains\('dark'\)/, 'what is on screen, so "System" reads as what the device shows');
  assert.equal((src.match(/window\.Theme\?\.onChange\?\.\(/g) || []).length, 1, 'one listener, however many pickers are mounted');
});

test('"Homeroom brand kit (WIP)" is offered no more, and a device still answering it reads as Standard', () => {
  const html = renderComponent(PICKER, 'LookPickerView', { variant: 'frame', skin: 'wip', onPick() {} }, { cache: false });
  const options = [...html.matchAll(/<option value="([a-z0-9:]+)"( selected="")?>([^<]+)<\/option>/g)].map((m) => [m[1], m[3], !!m[2]]);
  assert.deepEqual(options, [
    ['standard', 'Standard', true], ['brand', 'Paper, simplified, with brand styling', false],
  ]);
  assert.doesNotMatch(html, /data-look-tokens/, 'no second menu for token sets');
  const src = read(PICKER);
  assert.doesNotMatch(src, /wipTokens|setTokens|onTokens|'wip:|wip:/, 'nothing of the removed look is named');
});
