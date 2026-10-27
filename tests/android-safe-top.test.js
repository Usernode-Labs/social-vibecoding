// The Android status bar over the platform header (issue #5970).
//
// The bug: on an Android phone where Homeroom fills the whole screen (the
// installed app, or the native app) the page draws under the system status
// bar. Chrome there can report `safe-area-inset-top` as 0 while
// `safe-area-max-inset-top` (Chrome 135+) carries the bar's height, so the
// header's padding fell back to its ordinary 8px and the Homeroom title and
// the bell were drawn under the clock and the battery icons.
//
// The fix is the top twin of #2755's bottom rule: the two env() values are
// maxed into `--un-safe-inset-top` on <html>, on an installed Android app
// and in the native WebView but never in a browser tab (#2509), where the
// strip belongs to the browser chrome. Every top-inset rule in the shell
// already reads that token, so one declaration reaches the header, the
// landing bar, `--platform-safe-top` and the kit's `.un-safe-top*` classes.

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

const TOP_VALUE = 'max(env(safe-area-inset-top, 0px), env(safe-area-max-inset-top, 0px))';

// Every `selector { declarations }` pair, in source order.
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('an installed Android app takes the larger of the two top insets', () => {
  const media = [...CSS.matchAll(
    /@media \(display-mode: standalone\), \(display-mode: fullscreen\) \{([\s\S]*?)\n\}/g
  )].map((m) => m[1]);

  assert.ok(media.length > 0, 'the installed-app media query still exists');
  const rule = rules.find((r) =>
    /^html\.un-android$/.test(r.selector)
    && r.body.includes('--un-safe-inset-top')
    && media.some((block) => block.includes(r.selector)));

  assert.ok(rule, 'html.un-android inside the standalone/fullscreen media query '
    + 'must set --un-safe-inset-top');
  assert.match(rule.body,
    new RegExp(`--un-safe-inset-top:\\s*${TOP_VALUE.replace(/[()]/g, '\\$&')}`),
    'the top inset is max(safe-area-inset-top, safe-area-max-inset-top), so a '
    + 'late or zero inset still reserves the status bar');
});

test('the native WebView takes the larger of the two top insets too', () => {
  const rule = rules.find((r) =>
    r.selector === 'html.un-android.in-native-webview:not(.web-browser-chrome)');

  assert.ok(rule, 'the native WebView selector must set the top inset');
  assert.match(rule.body,
    new RegExp(`--un-safe-inset-top:\\s*${TOP_VALUE.replace(/[()]/g, '\\$&')}`),
    'the WebView is edge to edge even outside a standalone display mode');
});

test('no browser tab reserves the status bar', () => {
  // In a browser tab the max variable is the height the inset grows to when
  // the browser chrome collapses; reserving it would stack a second gap on a
  // strip the browser already keeps clear (#2509).
  // `:not(.web-browser-chrome)` EXCLUDES a tab, so it is not an offender.
  const applied = (selector) => selector.replace(/:not\([^)]*\)/g, '');
  const offenders = rules.filter((r) =>
    applied(r.selector).includes('.web-browser-chrome')
    && r.body.includes('--un-safe-inset-top'));

  assert.deepEqual(offenders.map((r) => r.selector), [],
    'a web-browser-chrome selector must never set --un-safe-inset-top');

  // And #2509's own rules stay exactly as they were.
  const zeroed = rules.find((r) => r.selector === 'html.web-browser-chrome');
  assert.ok(zeroed, 'html.web-browser-chrome still exists');
  assert.match(zeroed.body, /--platform-safe-top:\s*0px/,
    'a browser tab still zeroes the top token');

  const clamp = rules.find((r) =>
    r.selector.includes('html.web-browser-chrome #platform-header.un-safe-top-extend'));
  assert.ok(clamp, 'the browser-tab header clamp still exists');
  assert.match(clamp.body, /padding-top:\s*0\.5rem !important/,
    'a browser tab still draws the ordinary 8px pad');
});

test('the value cannot reference itself', () => {
  const declarations = [...CSS.matchAll(/--un-safe-inset-top:\s*([^;}]+)/g)]
    .map((m) => m[1].trim());

  assert.ok(declarations.length > 0, 'at least one rule sets the token');
  for (const value of declarations) {
    assert.ok(!value.includes('var(--un-safe-inset-top'),
      `a self-referencing custom property is invalid: ${value}`);
  }
});

test('the pretend-phone review state still overrides the rule', () => {
  // ?safe-bottom=1 writes the property as an inline style on <html>, which
  // wins over any stylesheet declaration.
  const fn = APP_JS.slice(
    APP_JS.indexOf('_applySafeAreaShot() {'),
    APP_JS.indexOf('// Screenshot-state deep link `?shot=settings-back`')
  );
  assert.match(fn, /root\.style\.setProperty\('--un-safe-inset-top'/,
    'the shot inset must still be written inline so the review state wins');
});
