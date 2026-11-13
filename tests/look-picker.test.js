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
    ['standard', 'Standard', false], ['glass', 'Glass', true],
    ['paper', 'Paper', false], ['pastel', 'Pastel', false], ['mosaic', 'Mosaic', false], ['sunrise', 'Sunrise', false],
  ], 'Standard, then the five looks in the tour\'s order, the device\'s own chosen');
});

test('under the standard look it is drawn with the header\'s own classes, beside its bell', () => {
  const html = view({ variant: 'shell', skin: 'standard' });
  assert.match(html, /^<label class="relative w-7 h-7 flex items-center justify-center rounded-full [^"]*" title="Look" data-look-picker="shell">/);
  assert.doesNotMatch(html, /<label[^>]*un-touch-target/, 'the label brings no hit box of its own');
  assert.match(html, /<select aria-label="Look" class="absolute left-1\/2 top-1\/2 h-11 w-11 -translate-x-1\/2 -translate-y-1\/2 cursor-pointer opacity-0">/);
  assert.match(html, /<option value="standard" selected="">Standard<\/option>/);
  assert.doesNotMatch(html, /fr-ib|fr-look/, 'not the kit\'s disc: the kit\'s rules exist only under a look');
  assert.match(html, /<svg class="fr-ic" width="20" height="20"/, 'the glyph sizes itself, with or without the kit');
});

test('under the standard look the menu itself takes the press', () => {
  // .un-touch-target::after is a 44px box painted above the invisible select,
  // so on the label every press stopped there and the menu never opened
  // (#6648). The select now carries the same 44px square, centred on the
  // 28px disc.
  const html = view({ variant: 'shell', skin: 'standard' });
  const label = html.match(/<label class="([^"]*)" title="Look" data-look-picker="shell">/);
  assert.ok(label, 'the shell variant draws its label');
  assert.doesNotMatch(label[1], /un-touch-target/, 'no hit box sits over the select');
  const select = html.match(/<select aria-label="Look" class="([^"]*)">/);
  assert.ok(select, 'the system\'s own menu is still the control');
  assert.match(select[1], /\bh-11\b/);
  assert.match(select[1], /\bw-11\b/);
  assert.match(select[1], /left-1\/2/, 'centred on the disc');
  assert.match(select[1], /top-1\/2/, 'centred on the disc');
  assert.match(select[1], /-translate-x-1\/2/, 'centred on the disc');
  assert.match(select[1], /-translate-y-1\/2/, 'centred on the disc');
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
  assert.doesNotMatch(view({ variant: 'shell', skin: 'standard', dark: false, onDark() {} }), /fr-lookfold/, 'the standard header keeps its two');
  const dark = view({ variant: 'shell', skin: 'standard', dark: true, onDark() {} });
  assert.match(dark, /<\/label><button type="button" class="relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target [^"]*" aria-pressed="true" aria-label="Dark" title="Dark" data-look-theme="shell">/);
  // The glyph is where a press goes: the moon while it is light, the sun while it is dark.
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
