// The hamburger drawer's TOUCH presentation: a kit side panel
// (unNative.presentPanel via PlatformUI.panel), not a bottom sheet.
//
// It used to come up from the bottom as a 70vh-capped sheet, which is both
// the wrong idiom for persistent navigation and the reason the
// bottom-anchored #drawer-footer was pushed below the fold. Desktop already
// slid in from the right, so the two form factors disagreed about what this
// menu was.
//
// Everything here is a wiring contract that fails SILENTLY if it drifts —
// the drawer just reverts to a sheet, or opens once and never again because
// the adopted node was left detached — so each strand is pinned against the
// shipped source, in the static-assertion style of
// tests/ai-credit-drawer.test.js and tests/header-status-pane.test.js.
//
// Run with: node --test tests/header-menu-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const platformUiJs = fs.readFileSync(path.join(root, 'public/js/platform-ui.js'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// The HeaderMenu.open() body, up to the end of its touch branch.
function openBody() {
  const at = appJs.indexOf('    open() {');
  assert.ok(at !== -1, 'App.HeaderMenu.open() went missing');
  return appJs.slice(at, appJs.indexOf('THEME_MODES', at));
}

test('the touch branch presents a right-side kit panel', () => {
  const body = openBody();
  assert.match(body, /PlatformUI\.isTouch\(\)/, 'still gated on the touch platform');
  assert.match(body, /PlatformUI\.panel\(\{/, 'routes through the PlatformUI seam, never window.unNative');
  assert.match(body, /side:\s*'right'/, 'a drawer that opens from the bottom is the bug being fixed');
  assert.match(body, /contentEl:\s*panel/,
    'the shell panel itself is adopted so its row listeners ride along');
});

test('the touch branch no longer reaches for the bottom sheet', () => {
  const body = openBody();
  assert.ok(!/PlatformUI\.sheet\(/.test(body),
    'HeaderMenu must not present a bottom sheet any more');
  assert.ok(!/platform-sheet-adopted/.test(body),
    'the sheet adoption class would re-impose the 70vh cap on the drawer');
});

test('the adopted node is restored on dismissal, and the handle cleared', () => {
  const body = openBody();
  assert.match(body, /panel\.classList\.add\('platform-panel-adopted'\)/);
  assert.match(body, /panel\.classList\.remove\('platform-panel-adopted'\)/,
    'the class must come off or the panel stays flattened for the desktop path');
  assert.match(body, /document\.body\.appendChild\(panel\)/,
    'the drawer lives in <body> between opens — leaving it detached breaks every later open');
  assert.match(body, /App\.HeaderMenu\._panel = null/,
    'a stale handle would make close() dismiss an already-torn-down panel');
  // The fallback path: a kit that failed to load returns null, and the
  // legacy CSS slide-over must not inherit the flattening class.
  assert.match(body, /if \(kitPanel\)[\s\S]{0,400}?panel\.classList\.remove\('platform-panel-adopted'\)/,
    'when PlatformUI.panel() returns null the class must be undone before falling through');
});

test('a re-open during the exit spring keeps the drawer in the NEW panel', () => {
  const body = openBody();
  // Teardown is deferred behind the exit spring, so tapping ☰ again mid-exit
  // can adopt the drawer into a second kit panel before the first one's
  // onDismiss runs. Without this guard that stale teardown appends the node
  // back to <body> and the freshly-opened panel renders empty.
  assert.match(body, /App\.HeaderMenu\._panel !== handle\) return/,
    'onDismiss must no-op when a newer open already took ownership of the node');
});

test('the hamburger reflects its expanded state on the touch path too', () => {
  const body = openBody();
  // The touch branch returns early, so before this it left the button
  // reading "Open menu" / aria-expanded=false for the whole time the
  // drawer was open.
  assert.match(body, /aria-expanded',\s*'true'[\s\S]{0,200}?'Close menu'/,
    'opening must announce the expanded state on the touch path');
  const dismiss = body.slice(body.indexOf('onDismiss:'), body.indexOf('if (kitPanel)'));
  assert.match(dismiss, /aria-expanded',\s*'false'/,
    'every exit path routes through onDismiss — reset the state there');
  assert.match(dismiss, /'Open menu'/, 'the label must go back too');
});

test('close() and Escape both defer to the kit handle', () => {
  const close = appJs.slice(appJs.indexOf('    close() {'));
  assert.match(close.slice(0, 400), /App\.HeaderMenu\._panel[\s\S]{0,120}?\.dismiss\(\)/,
    'close() must dismiss through the kit so onDismiss (and the node restore) runs');
  const keydown = appJs.slice(appJs.indexOf("e.key === 'Escape'"));
  assert.match(keydown.slice(0, 400), /App\.HeaderMenu\._panel\) return/,
    "the kit's modal stack owns Escape while adopted — double-handling would also close a modal above the drawer");
});

test('the renamed handle leaves no _sheet references behind', () => {
  const at = appJs.indexOf('  HeaderMenu: {');
  assert.ok(at !== -1, 'App.HeaderMenu went missing');
  assert.ok(!/HeaderMenu\._sheet/.test(appJs),
    'a surviving _sheet reference reads/writes a handle nothing sets any more');
  assert.match(appJs.slice(at, at + 200), /_panel:\s*null/,
    'the handle field is declared on HeaderMenu');
});

test('PlatformUI exposes panel() with the same null-degradation contract', () => {
  assert.match(platformUiJs, /panel\(opts\)\s*\{/, 'the seam method exists');
  const fn = platformUiJs.slice(platformUiJs.indexOf('panel(opts) {'));
  assert.match(fn.slice(0, 300), /typeof un\.presentPanel !== 'function'\) return null/,
    'a kit predating presentPanel must yield null, not throw — that is what keeps the legacy path alive');
});

test('.platform-panel-adopted fills the drawer instead of capping it', () => {
  const at = appCss.indexOf('.platform-panel-adopted {');
  assert.ok(at !== -1, 'app.css lost the panel adoption class');
  const block = appCss.slice(at, appCss.indexOf('}', at));
  assert.match(block, /height:\s*100%/, 'the drawer must fill the kit panel top to bottom');
  assert.match(block, /max-height:\s*none/,
    'any cap here re-creates the bug: #drawer-footer stops reaching the bottom of the screen');
  assert.ok(!/70vh/.test(block),
    'the 70vh sheet cap is exactly what this class exists to not do');
  // The legacy fixed slide-over chrome must be neutralised while adopted.
  for (const prop of ['position: static', 'transform: none', 'transition: none',
    'box-shadow: none', 'background: transparent', 'display: flex']) {
    assert.ok(block.includes(prop), `.platform-panel-adopted must set ${prop}`);
  }
});

test('.platform-sheet-adopted survives for the surfaces still using it', () => {
  assert.ok(appCss.includes('.platform-sheet-adopted {'),
    'notifications, the work drawer and the dev console still ride bottom sheets');
  // #1079 chunk B moved the dev console into the React bundle; the sheet
  // idiom came with it (see presentSheetIfTouch in the store).
  for (const file of ['public/js/notifications.js', 'public/js/work-drawer.js',
    'frontend/src/features/dev-console/store.ts']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /platform-sheet-adopted/,
      `${file} is expected to keep the sheet idiom (deferred work, not a leftover)`);
  }
});

test('a dapp check pins the drawer to the panel on a forced-touch route', () => {
  // ?un-platform=ios is what makes the capture/check browser take the
  // touch branch at all — the phone capture frame is a viewport resize,
  // not a touch-UA emulation.
  const checks = (dapp.tests || []).filter(
    (t) => t.path && t.path.includes('shot=menu') && t.path.includes('un-platform=ios')
  );
  assert.ok(checks.length >= 1,
    'without a forced-touch check the drawer could silently revert to a sheet');
  assert.ok(checks.some((t) => /\.un-panel/.test(t.expectSelector || '')),
    'at least one check must assert the kit panel actually wraps the drawer');
  assert.ok(checks.some((t) => /platform-panel-adopted/.test(t.expectSelector || '')),
    'and that the drawer is the adopted content, not an empty panel');
});
