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
// #1079 chunk B made #header-menu-panel a React island and moved App.HeaderMenu
// out of public/js/app.js and into the bundle beside it, as
// frontend/src/features/header/header-menu-controller.js. Every contract below
// is the same one; only the file it is read from changed. (app.js keeps a thin
// App.HeaderMenu forwarder for its own call sites — that is a forwarder, not
// the behaviour, so asserting against it would prove nothing.)
//
// #1120 slice 3 did the same thing to the ADOPTION half: the adopted class,
// the restore to <body> and the rollback when the kit refuses were four
// hand-written copies, and are now one — frontend/src/lib/kit-surface.ts.
// Every contract below still holds; the ones about the drawer's intent (touch
// gate, right side, which node is adopted, what its teardown does to
// HeaderMenu's own state) are read from the open() body, and the ones about
// the mechanics are read from the shared lift.
//
// Run with: node --test tests/header-menu-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const headerMenuJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/header-menu-controller.js'), 'utf8');
const headerMenuTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/header-menu.tsx'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const platformUiJs = fs.readFileSync(path.join(root, 'public/js/platform-ui.js'), 'utf8');
const kitSurfaceTs = fs.readFileSync(
  path.join(root, 'frontend/src/lib/kit-surface.ts'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// The HeaderMenu.open() body, up to the close() that follows it.
function openBody() {
  const at = headerMenuJs.indexOf('  open() {');
  assert.ok(at !== -1, 'HeaderMenu.open() went missing');
  return headerMenuJs.slice(at, headerMenuJs.indexOf('  close() {', at));
}

test('the touch branch presents a right-side kit panel', () => {
  const body = openBody();
  assert.match(body, /gate:\s*'touch'/, 'still gated on the touch platform');
  assert.match(body, /kind:\s*'panel'/, 'a panel, not a sheet');
  assert.match(body, /side:\s*'right'/, 'a drawer that opens from the bottom is the bug being fixed');
  assert.match(body, /contentEl:\s*panel/,
    'the shell panel itself is adopted so its row listeners ride along');
  // …and the gate and the seam are what the shared lift means by those two.
  assert.match(kitSurfaceTs, /ui\.isTouch\(\)/, 'the touch gate is still a real isTouch() call');
  assert.match(kitSurfaceTs, /host\.PlatformUI/,
    'routes through the PlatformUI seam, never window.unNative');
  assert.match(kitSurfaceTs, /const presentFn = ui\[options\.kind\]/,
    "kind: 'panel' has to reach PlatformUI.panel()");
});

test('the touch branch no longer reaches for the bottom sheet', () => {
  const body = openBody();
  assert.ok(!/PlatformUI\.sheet\(/.test(body),
    'HeaderMenu must not present a bottom sheet any more');
  assert.ok(!/kind:\s*'sheet'/.test(body),
    'the sheet kind stamps platform-sheet-adopted, which re-imposes the 70vh cap');
  assert.ok(!/platform-sheet-adopted/.test(body),
    'the sheet adoption class would re-impose the 70vh cap on the drawer');
});

test('the adopted node is restored on dismissal, and the handle cleared', () => {
  const body = openBody();
  assert.match(body, /home:\s*'body'/,
    'the drawer lives in <body> between opens — leaving it detached breaks every later open');
  assert.match(body, /HeaderMenu\._panel = null/,
    'a stale handle would make close() dismiss an already-torn-down panel');
  assert.match(body, /if \(adoption\) \{/,
    'a kit that failed to load returns null and the legacy slide-over below runs instead');
  // The three mechanics, in the one place all four surfaces get them from.
  assert.match(kitSurfaceTs, /flagEl\.classList\.add\(adoptedClass\)/);
  assert.match(kitSurfaceTs, /flagEl\.classList\.remove\(adoptedClass\)/,
    'the class must come off or the panel stays flattened for the desktop path');
  assert.match(kitSurfaceTs, /document\.body\.appendChild\(contentEl\)/,
    "home: 'body' has to actually re-home the node");
  // The fallback path: a kit that refuses returns null, and the legacy CSS
  // slide-over must not inherit the flattening class. This is the copy that
  // only ONE of the four hand-written versions got right — see the module
  // header — so it is pinned as its own strand.
  assert.match(kitSurfaceTs, /if \(!handle\) \{\n\s*undo\(\);\n\s*return null;/,
    'when the kit declines the adopted class must be undone before the caller falls through');
});

test('a re-open during the exit spring keeps the drawer in the NEW panel', () => {
  const body = openBody();
  // Teardown is deferred behind the exit spring, so tapping ☰ again mid-exit
  // can adopt the drawer into a second kit panel before the first one's
  // onDismiss runs. Without this guard that stale teardown appends the node
  // back to <body> and the freshly-opened panel renders empty.
  assert.match(body, /stillOwns: \(\) => !adoption \|\| HeaderMenu\._panel === adoption/,
    'onDismiss must no-op when a newer open already took ownership of the node');
  // …and the shared lift has to honour that by touching NOTHING when it is
  // told it no longer owns the node — before the restore, not after.
  assert.match(kitSurfaceTs, /if \(options\.stillOwns && !options\.stillOwns\(\)\) return;\n\s*undo\(\);/);
  // The dismiss waiters resolve regardless, or a superseded teardown strands
  // whoever chained a presentation behind close() until the safety cap.
  assert.match(body, /onDismissStart: \(\) => \{[\s\S]{0,400}?_resolveDismissWaiters\(\)/);
  assert.ok(kitSurfaceTs.indexOf('options.onDismissStart?.()')
    < kitSurfaceTs.indexOf('options.stillOwns()'),
    'onDismissStart must run BEFORE the ownership guard can bail out');
});

test('the hamburger reflects its expanded state on the touch path too', () => {
  const body = openBody();
  // The touch branch returns early, so before this it left the button
  // reading "Open menu" / aria-expanded=false for the whole time the
  // drawer was open.
  assert.match(body, /aria-expanded',\s*'true'[\s\S]{0,200}?'Close menu'/,
    'opening must announce the expanded state on the touch path');
  const dismiss = body.slice(body.indexOf('onDismiss: () => {'), body.indexOf('if (adoption) {'));
  assert.match(dismiss, /aria-expanded',\s*'false'/,
    'every exit path routes through onDismiss — reset the state there');
  assert.match(dismiss, /'Open menu'/, 'the label must go back too');
});

test('close() and Escape both defer to the kit handle', () => {
  const close = headerMenuJs.slice(headerMenuJs.indexOf('  close() {'));
  assert.match(close.slice(0, 400), /HeaderMenu\._panel[\s\S]{0,120}?\.dismiss\(\)/,
    'close() must dismiss through the kit so onDismiss (and the node restore) runs');
  const keydown = headerMenuJs.slice(headerMenuJs.indexOf("e.key === 'Escape'"));
  assert.match(keydown.slice(0, 400), /HeaderMenu\._panel\) return/,
    "the kit's modal stack owns Escape while adopted — double-handling would also close a modal above the drawer");
});

test('the renamed handle leaves no _sheet references behind', () => {
  const at = headerMenuJs.indexOf('const HeaderMenu = {');
  assert.ok(at !== -1, 'the HeaderMenu controller went missing');
  assert.ok(!/HeaderMenu\._sheet/.test(headerMenuJs),
    'a surviving _sheet reference reads/writes a handle nothing sets any more');
  assert.match(headerMenuJs.slice(at, at + 200), /_panel:\s*null/,
    'the handle field is declared on HeaderMenu');
});

// ── The move itself (#1079 chunk B) ────────────────────────────────────

test('the drawer controller lives in the bundle, not in app.js', () => {
  // What is left in app.js is a FORWARDER — no kit adoption, no listeners, no
  // presentation state. A second copy of any of that would be a fork of the
  // module, and forks of this one fail silently (see the header note).
  for (const gone of ['PlatformUI.panel({', 'platform-panel-adopted',
    '_dismissWaiters', 'LEGACY_CLOSE_MS', '_navArmedAt =']) {
    assert.ok(!appJs.includes(gone),
      `app.js still carries "${gone}" — the drawer's behaviour moved to `
      + 'frontend/src/features/header/header-menu-controller.js');
  }
  assert.match(headerMenuJs, /window\.HeaderMenu = HeaderMenu/,
    'the publication is what keeps app.js, native-chrome.js, node-pill.js and '
    + 'wallet-sheet.js working untouched');
  assert.match(headerMenuJs, /typeof window !== 'undefined'/,
    'the SSG prerender pass evaluates this module in Node — an unguarded '
    + 'window write throws the whole build');
  assert.match(appJs, /open\(\) \{ window\.HeaderMenu\?\.open\(\); \}/,
    'app.js keeps a forwarder for its own call sites');
  assert.match(appJs, /return window\.HeaderMenu\s*\n?\s*\?\s*window\.HeaderMenu\.close\(\)/,
    'close() is awaited by the Node/Wallet sheets — the forwarder must stay thenable');
});

test('init() is called from the island, not from App.bindEvents()', () => {
  assert.ok(!/App\.HeaderMenu\.init\(\);/.test(appJs),
    'binding from bindEvents() would run before hydration adopted #header-menu-panel');
  assert.match(headerMenuTsx, /window\.HeaderMenu\?\.init\(\)/,
    'the island owns the wiring now');
  assert.match(headerMenuJs, /if \(HeaderMenu\._bound\) return/,
    'a layout effect can run twice (StrictMode, remount) and these listeners '
    + 'sit on nodes that outlive the component — binding twice double-closes');
});

test('the theme segments are React state, with no legacy writer left', () => {
  assert.ok(!/_renderThemeButtons/.test(appJs),
    'the DOM-writing renderer moved into ThemeControl');
  assert.ok(!/theme-seg|data-theme-mode|drawer-theme/.test(headerMenuJs),
    'the controller announces the open instead of writing the segments itself');
  assert.match(headerMenuJs, /usernode:header-menu-open/,
    'open() must still make the control re-read Theme.get() — that is what '
    + 'catches a cross-tab change made while the drawer was closed');
  assert.match(headerMenuTsx, /useWindowEvent\('usernode:header-menu-open'/);
  // Hydration equality: the first render must be the shipped markup, which
  // has no active segment at all.
  assert.match(headerMenuTsx, /useState<ThemeMode \| null>\(null\)/,
    'reading Theme.get() during render would mismatch the prerendered markup');
  assert.match(headerMenuTsx, /setProperty\(\s*\n?\s*'--theme-caret-index'/,
    'the caret still moves by custom property, written imperatively — a rendered '
    + 'style attribute would not match the prerender');
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
  // idiom came with it (see presentSheetIfTouch in the store). #1120 slice 3
  // then moved the CLASS out of two of these three and into the shared lift,
  // which spells it `platform-${kind}-adopted` — so the sheet surfaces are
  // now identified by the kind they ask for, not by the literal.
  for (const file of ['frontend/src/features/work-drawer/work-drawer.js',
    'frontend/src/features/dev-console/store.ts']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /kind: 'sheet'/,
      `${file} is expected to keep the sheet idiom (deferred work, not a leftover)`);
  }
  assert.match(kitSurfaceTs, /`platform-\$\{options\.kind\}-adopted`/,
    "and kind: 'sheet' is what still produces the class app.css styles");
  // notifications.js is the fifth copy of the adoption dance and was NOT part
  // of slice 3's four — it still writes the class itself, on purpose.
  const notifications = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  assert.match(notifications, /platform-sheet-adopted/,
    'notifications.js is expected to keep the sheet idiom (deferred work, not a leftover)');
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
