// The shell's banners after #1078 chunk A converted them to React islands,
// and the header's connection status that replaced the offline strip (the
// native-offline proposal, 18 Nov 2026). Their guard rails:
//
//  1. `#connection-status` follows lib/offline.ts's status store, and its
//     `hidden` class is written through a ref — not rendered — because
//     public/js/platform-ui.js and app.css also write classes onto shell nodes.
//     It shows nothing of the state until mounted, so the hydrating render
//     matches the prerender even under a ?shot=offline pin.
//  2. `#view-as-non-admin-banner`'s "Switch back" control moved out of
//     settings.js (which bound it by id) into the component. Exactly one owner:
//     if settings.js binds it again, the admin gets two reloads for one click.
//  3. That banner's class string keeps BOTH `hidden` and `flex`. app.css
//     reveals it from a body class with id+class specificity, and tailwind-merge
//     treats the pair as one group — so this string must never go through `cn`.
//  4. Both roots survive into the built document with their prerendered state,
//     which is what dapp.json's `:not(.hidden)` checks select against.
//
// Run with: node --test tests/shell-banners.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BANNERS = read('frontend/src/features/shell/banners.tsx');
const STATUS = read('frontend/src/features/header/connection-status.tsx');
const SHELL = read('frontend/src/Shell.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const INDEX_HTML = read('public/index.html');

test("the header's connection status follows the status store and writes its class by ref", () => {
  assert.match(STATUS, /useStoreState\(connectionStatusStore\)/,
    'it subscribes to the store lib/offline.ts publishes into');
  assert.match(STATUS, /useHiddenClass\(ref, !shown\)/,
    'and applies `hidden` through a ref, so a re-render never rewrites `class`');
  assert.match(STATUS, /const shown = mounted && status !== 'online'/,
    'nothing of the state shows before it has mounted: the first render matches the prerender');
  assert.match(SHELL, /<Island name="ConnectionStatus"><ConnectionStatus \/><\/Island>/,
    'the shell renders it beside the header, which is clipped to its own box on most screens');
  assert.match(STATUS, /fixed left-1\/2[\s\S]*top-\[calc\(var\(--browser-banner-h,0px\)\+var\(--platform-header-h\)\+var\(--platform-safe-top\)/,
    'fixed at the header\'s foot');
  assert.doesNotMatch(BANNERS, /OFFLINE_BANNER_ID|offline-banner"/, 'the strip is gone from the banners');
});

test('the status says connecting, no internet, or updating, never as an error', () => {
  assert.equal(message('core:status.connecting'), 'Connecting…');
  assert.equal(message('core:status.noInternet'), 'No internet');
  assert.equal(message('core:banner.restart.text'), 'Updating Homeroom...');
  assert.equal(message('core:status.updatedAt', { time: '12:41' }), 'Updated 12:41');
  assert.doesNotMatch(STATUS, /\b(red|amber|rose)-\d/, 'being offline is a condition, not an error');
});

test('the connection status prerenders hidden, saying "Connecting…"', () => {
  const m = INDEX_HTML.match(/<div[^>]*id="connection-status"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(m, 'public/index.html has no #connection-status — run npm run build:shell');
  assert.match(m[0], /class="connection-status hidden /, '`hidden` from the first byte');
  assert.match(m[0], /data-status="online"/);
  assert.match(m[0], /Connecting…/);
  assert.doesNotMatch(INDEX_HTML, /id="offline-banner"/, 'the old strip is not in the shell');
});

test('"Switch back" is owned by the banner component, and only by it', () => {
  assert.match(BANNERS, /id="view-as-non-admin-disable"/);
  assert.match(BANNERS, /localStorage\.removeItem\('viewAsNonAdmin'\)/);
  assert.match(BANNERS, /window\.location\.reload\(\)/);
  assert.ok(!SETTINGS.includes('view-as-non-admin-disable'),
    'settings.js must not bind #view-as-non-admin-disable any more — the island owns it');
  // settings.js still owns the Settings *toggle* that sets the flag; only the
  // banner's own escape hatch moved.
  assert.match(SETTINGS, /localStorage\.setItem\('viewAsNonAdmin', '1'\)/);
});

test('the view-as banner keeps its deliberate hidden+flex pair out of cn()', () => {
  const start = BANNERS.indexOf('id="view-as-non-admin-banner"');
  assert.ok(start > -1);
  const el = BANNERS.slice(start, start + 400);
  assert.match(el, /className="hidden bg-amber-500\/15/,
    'a literal class string, not a cn() call — tailwind-merge would drop one of hidden/flex');
  assert.match(el, /flex items-center justify-center gap-2"/);
  assert.ok(!/cn\(/.test(el), 'this string must not be composed through cn()');
  // And the CSS that makes the pair meaningful is still there.
  assert.match(read('public/css/app.css'),
    /body\.is-view-as-non-admin #view-as-non-admin-banner/);
  // The built document carries both classes, in that order.
  const m = INDEX_HTML.match(/<div[^>]*id="view-as-non-admin-banner"[^>]*>/);
  assert.ok(m);
  assert.match(m[0], /class="hidden bg-amber-500\/15[^"]*\bflex\b/);
});
