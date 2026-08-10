// The shell's two amber banners after #1078 chunk A converted them to React
// islands. They are the proof slice of step 2, and they are the only place in
// this chunk where BEHAVIOUR changed owner, so they get their own guard rails:
//
//  1. `#offline-banner`'s visibility comes from the visibility store, and its
//     `hidden` class is written through a ref — not rendered — because
//     public/js/platform-ui.js and app.css also write classes onto shell nodes.
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

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BANNERS = read('frontend/src/features/shell/banners.tsx');
const ALERT = read('frontend/@/components/ui/alert.tsx');
const SETTINGS = read('public/js/settings.js');
const INDEX_HTML = read('public/index.html');

test('the offline banner reads the visibility store and writes its class by ref', () => {
  assert.match(BANNERS, /useVisibility\(OFFLINE_BANNER_ID/,
    'the offline banner subscribes to the store lib/offline.ts publishes into');
  assert.match(BANNERS, /useHiddenClass\(ref, !visible\)/,
    'and applies `hidden` through a ref, so a re-render never rewrites `class`');
  // The initial value has to come from the store too, or a ?shot=offline deep
  // link (which pins the state during App.init) renders one frame online.
  assert.match(BANNERS, /offlineBannerVisible\(\)/);
});

test('the offline banner prerenders hidden, with `hidden` leading the class string', () => {
  // `startHidden` is a cva variant declared BEFORE `variant` precisely so the
  // class order matches the hand-written markup byte for byte.
  assert.match(BANNERS, /startHidden/);
  assert.match(ALERT, /startHidden: \{ true: 'hidden', false: '' \}/);
  const decl = ALERT.indexOf('    startHidden:');
  const variant = ALERT.indexOf('    variant: {');
  assert.ok(decl > -1 && variant > -1);
  assert.ok(decl < variant,
    'startHidden must be declared before `variant` — cva emits groups in declaration order');
  const m = INDEX_HTML.match(/<div[^>]*id="offline-banner"[^>]*>/);
  assert.ok(m, 'public/index.html has no #offline-banner — run npm run build:shell');
  assert.match(m[0], /class="hidden shrink-0 /,
    'the prerendered class string should still start `hidden shrink-0 …`');
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
