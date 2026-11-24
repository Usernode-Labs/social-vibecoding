// The Android navigation bar under the platform's bottom surfaces (#7061).
//
// The bug: on an Android phone where Homeroom fills the whole screen (the
// installed app, or the native app) the page draws under the system
// navigation bar. Chrome there can report `safe-area-inset-bottom` as 0
// while `safe-area-max-inset-bottom` (Chrome 135+) carries the bar's height,
// so every bottom-anchored surface — the tab bar, sheets, action menus,
// toasts, composers — sat under the navigation buttons.
//
// #2755 fixed this for the shell's own `--platform-safe-bottom` alone, and
// only in a standalone display mode. #7061 is the bottom twin of #5970: the
// two env() values are maxed into `--un-safe-inset-bottom` on <html>, on an
// installed Android app AND in the native WebView but never in a browser tab
// (#2509). Every bottom-inset rule already reads that token — the kit's
// sheets, panels, toasts and `.un-safe-bottom*` classes, and the shell's own
// `--platform-safe-bottom` — so one declaration reaches them all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const APP_CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');

// Comments carry prose that names the selectors and values this file pins,
// so they are stripped before every structural read.
const CSS = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const BOTTOM_VALUE = 'max(env(safe-area-inset-bottom, 0px), env(safe-area-max-inset-bottom, 0px))';
const VALUE_RE = new RegExp(BOTTOM_VALUE.replace(/[()]/g, '\\$&'));

// Every `selector { declarations }` pair, in source order.
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('an installed Android app takes the larger of the two bottom insets', () => {
  const media = [...CSS.matchAll(
    /@media \(display-mode: standalone\), \(display-mode: fullscreen\) \{([\s\S]*?)\n\}/g
  )].map((m) => m[1]);

  assert.ok(media.length > 0, 'the installed-app media query still exists');
  const rule = rules.find((r) =>
    /^html\.un-android:not\(\.un-kb\)$/.test(r.selector)
    && r.body.includes('--un-safe-inset-bottom')
    && media.some((block) => block.includes(r.selector)));

  assert.ok(rule, 'html.un-android:not(.un-kb) inside the standalone/fullscreen '
    + 'media query must set --un-safe-inset-bottom');
  assert.match(rule.body, VALUE_RE,
    'the bottom inset is max(safe-area-inset-bottom, safe-area-max-inset-bottom), '
    + 'so a late or zero inset still reserves the navigation bar');
});

test('the native WebView takes the larger of the two bottom insets too', () => {
  const rule = rules.find((r) =>
    r.selector === 'html.un-android.in-native-webview:not(.web-browser-chrome):not(.un-kb)');

  assert.ok(rule, 'the native WebView selector must set the bottom inset');
  assert.match(rule.body, VALUE_RE,
    'the WebView is edge to edge even outside a standalone display mode');
});

test('no browser tab reserves the navigation bar', () => {
  // In a browser tab the max variable is the height the inset grows to when
  // the browser chin collapses; reserving it would stack a second gap on a
  // strip the browser already keeps clear (#2509).
  // `:not(.web-browser-chrome)` EXCLUDES a tab, so it is not an offender.
  const applied = (selector) => selector.replace(/:not\([^)]*\)/g, '');
  const offenders = rules.filter((r) =>
    applied(r.selector).includes('.web-browser-chrome')
    && r.body.includes('--un-safe-inset-bottom'));

  assert.deepEqual(offenders.map((r) => r.selector), [],
    'a web-browser-chrome selector must never set --un-safe-inset-bottom');

  // And #2509's own rule stays exactly as it was.
  const zeroed = rules.find((r) => r.selector === 'html.web-browser-chrome');
  assert.ok(zeroed, 'html.web-browser-chrome still exists');
  assert.match(zeroed.body, /--platform-safe-top:\s*0px/,
    'a browser tab still zeroes the top token');
});

test('the keyboard stands the max down in both rules', () => {
  // With the keyboard up the kit pads by `--un-kb-inset`, measured from the
  // layout viewport's bottom edge, which already includes the navigation-bar
  // strip. Counting both would push a composer up twice.
  for (const selector of [
    'html.un-android:not(.un-kb)',
    'html.un-android.in-native-webview:not(.web-browser-chrome):not(.un-kb)',
  ]) {
    const rule = rules.find((r) => r.selector === selector);
    assert.ok(rule, `${selector} must exist`);
    assert.ok(rule.body.includes('--un-safe-inset-bottom'),
      `${selector} must set the bottom token`);
    assert.ok(selector.includes(':not(.un-kb)'),
      `${selector} must stand down while the keyboard is open`);
  }
});

test('the value cannot reference itself', () => {
  const declarations = [...CSS.matchAll(/--un-safe-inset-bottom:\s*([^;}]+)/g)]
    .map((m) => m[1].trim());

  assert.ok(declarations.length > 0, 'at least one rule sets the token');
  for (const value of declarations) {
    assert.ok(!value.includes('var(--un-safe-inset-bottom'),
      `a self-referencing custom property is invalid: ${value}`);
  }
});

test('iOS keeps its own, smaller share of the bottom inset', () => {
  // `un-android` never lands on iOS, so nothing here may overwrite the
  // home-indicator token or the 14px trim #2766 gives the tab bar.
  const ios = rules.filter((r) => r.selector.includes('un-ios'));
  assert.ok(ios.length > 0, 'the iOS rule still exists');
  for (const rule of ios) {
    assert.ok(!rule.body.includes('--un-safe-inset-bottom'),
      `iOS must not take the Android max: ${rule.selector}`);
  }
  const trim = ios.find((r) => r.body.includes('--platform-tabs-inset'));
  assert.ok(trim, 'iOS still gets its own tab-bar share');
  assert.match(trim.body,
    /--platform-tabs-inset:\s*max\(0px, calc\(var\(--platform-safe-bottom, 0px\) - 14px\)\)/,
    'all but 14px of the home-indicator strip, never negative');
});

test('the shell and the kit read the token, so one declaration reaches them', () => {
  // The shell's own token resolves through the kit's, and the platform
  // surface restates it the same way; the app surface still zeroes it
  // because frames get the inset by forwarding instead.
  assert.match(APP_CSS,
    /--platform-safe-bottom: var\(--un-safe-inset-bottom, env\(safe-area-inset-bottom, 0px\)\);/,
    ':root and the platform surface read the kit token');
  assert.match(APP_CSS,
    /#app-view\[data-app-surface="app"\]\s*\{\s*--platform-safe-bottom: 0px;/,
    'an app frame still reserves nothing of its own');

  const kit = read('public/usernode-native/v1/native.css');
  assert.match(kit, /\.un-sheet\s*\{[^}]*var\(--un-safe-inset-bottom/,
    'the kit sheet reads the token');
  assert.match(kit, /\.un-toast\s*\{[^}]*var\(--un-safe-inset-bottom/,
    'the kit toast reads the token');
});

test('the pretend-phone review state still overrides the rule', () => {
  // ?safe-bottom=1 writes the property as an inline style on <html>, which
  // wins over any stylesheet declaration.
  const fn = APP_JS.slice(
    APP_JS.indexOf('_applySafeAreaShot() {'),
    APP_JS.indexOf('// Screenshot-state deep link `?shot=settings-back`')
  );
  assert.match(fn, /root\.style\.setProperty\('--un-safe-inset-bottom'/,
    'the shot inset must still be written inline so the review state wins');
});
