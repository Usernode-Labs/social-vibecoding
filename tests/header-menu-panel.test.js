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
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
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

test('the theme segments left the drawer entirely', () => {
  // THE UI OVERHAUL made Theme a SETTING — the first one. A live control that
  // changes how the whole product looks is not navigation, and this drawer is
  // navigation plus notifications now. tests/theme-mode.test.js owns the
  // control's own contract; what matters HERE is that no half of it stayed
  // behind, because two owners of one --theme-caret-index is the exact
  // conflict the migration rule exists to prevent.
  assert.ok(!/_renderThemeButtons/.test(appJs),
    'the DOM-writing renderer is long gone');
  assert.ok(!/theme-seg|data-theme-mode|drawer-theme/.test(headerMenuJs),
    'the drawer controller writes no segments');
  assert.ok(!/theme-seg|data-theme-mode|drawer-theme|ThemeControl/.test(headerMenuTsx),
    'and the drawer markup renders none');
  // The controller may still NAME the retired event in the comment that
  // records where it went; what must be gone is the dispatch.
  assert.ok(!/dispatchEvent\([\s\S]{0,80}usernode:header-menu-open/.test(headerMenuJs),
    'the open announcement went with the control it existed for — the settings '
    + 'screen dispatches usernode:settings-section in its place');
  const settingsJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/settings/settings.js'), 'utf8');
  assert.match(settingsJs, /usernode:settings-section/,
    'and the settings screen makes that announcement in its place');
});

test('notifications lead the drawer, and the bell is gone', () => {
  // The merge: two top-right drawers that opened the same way, one slot apart,
  // became one. The LIST is rendered here from the same store, so the module
  // is unchanged; what had to move is the init, because the island that used
  // to own it is retired.
  assert.match(headerMenuTsx, /<NotificationsBody \/>/,
    'the drawer renders the notifications body');
  assert.match(headerMenuTsx, /window\.Notifications\?\.init\(\)/,
    'and initialises the module from its layout effect, before DOMContentLoaded');
  assert.match(headerMenuTsx, /id="drawer-notifications"/, 'inside its own region');
  assert.equal(html.indexOf('id="notifications-panel"'), -1,
    'the retired bell panel must not still ship');
  assert.equal(html.indexOf('id="notifications-btn"'), -1,
    'nor the button that opened it');
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
    'the dev console and the Improve panel still ride bottom sheets');
  // #1079 chunk B moved the dev console into the React bundle; the sheet
  // idiom came with it (see presentSheetIfTouch in the store). #1120 slice 3
  // then moved the CLASS into the shared lift, which spells it
  // `platform-${kind}-adopted` — so the sheet surfaces are identified by the
  // kind they ask for, not by the literal. THE UI OVERHAUL retired the work
  // drawer and added the Improve panel, which asks for the same kind: on
  // touch it is a real kit bottom sheet, which is half of "side panel on
  // desktop, bottom sheet on mobile".
  for (const file of ['frontend/src/features/improve/improve-controller.js',
    'frontend/src/features/dev-console/store.ts']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /kind: 'sheet'/,
      `${file} is expected to keep the sheet idiom (deferred work, not a leftover)`);
  }
  assert.match(kitSurfaceTs, /`platform-\$\{options\.kind\}-adopted`/,
    "and kind: 'sheet' is what still produces the class app.css styles");
  // notifications.js was the fifth copy of the adoption dance and was NOT part
  // of slice 3's four — it wrote the class itself. THE UI OVERHAUL removed
  // that copy along with the panel it presented: the list renders inside the
  // hamburger now, and the hamburger's own adoption is the only one left.
  const notifications = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  assert.ok(!/platform-sheet-adopted/.test(notifications),
    'the retired fifth copy of the adoption dance must not linger');
  assert.match(notifications, /window\.HeaderMenu\?\.open\?\.\(\)/,
    'show() forwards to the drawer that actually presents the list');
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

// ── #1363: what the drawer looks like the moment it opens ────────────
//
// Two changes, both about where your eye and your thumb land. Neither has a
// runtime assertion that would catch a regression — a collapsed section that
// quietly ships expanded, or an anchor that quietly reverts to a top-stacked
// list, both still render — so each strand is pinned against the source and
// against the prerendered document in the style of the contracts above.

test('the drawer opens with notifications COLLAPSED, on every open', () => {
  // Collapsed by default, from a CONSTANT initial value: the SSG pass renders
  // this island in Node, so anything read from storage or the store here would
  // disagree with the client's first pass and console.error — which fails
  // proposal checks on every route.
  assert.match(headerMenuTsx, /useState\(false\)/,
    'the notifications section must start collapsed, from a constant');

  // "By DEFAULT" means on every open, not just the first — the panel is never
  // unmounted, so without this an expansion would persist for the whole visit
  // and quietly undo the change for whoever expanded it once.
  assert.match(headerMenuTsx, /addEventListener\('sv:drawer-open'/,
    'and re-collapse when the drawer is opened again');
  assert.match(headerMenuTsx, /removeEventListener\('sv:drawer-open'/,
    'with the listener torn down, not leaked');

  // The event is dispatched ONCE, above the touch/desktop fork, because both
  // presentations are the drawer becoming visible.
  assert.match(headerMenuJs, /dispatchEvent\(new CustomEvent\('sv:drawer-open'\)\)/);
  const body = openBody();
  assert.match(body, /HeaderMenu\._announceOpen\(\);/,
    'open() must announce itself before it presents either way');

  // COLLAPSED WITH A CLASS, NEVER BY UNMOUNTING. Three things inside are
  // resolved once by id and would not survive a teardown: the kit's
  // pull-to-refresh on #notifications-list, and notifications.js's click
  // listener AND `disabled` write on #notifications-mark-all.
  const block = html.slice(
    html.indexOf('id="drawer-notifications"'),
    html.indexOf('id="drawer-main-rows"'),
  );
  assert.ok(block.includes('<div class="hidden">'),
    'the body is hidden by class, so its ids stay mounted');
  assert.ok(block.includes('id="notifications-list"'),
    '#notifications-list must still be in the prerendered document');
  assert.ok(block.includes('id="notifications-mark-all"'),
    '#notifications-mark-all must still be in the prerendered document');
  assert.match(block, /aria-expanded="false"/,
    'and the disclosure control must say it is collapsed');
});

test('notifications anchor to the top of the drawer, the nav rows to the bottom', () => {
  // Opposite ends of one column flex. #drawer-notifications is a SIBLING of
  // #drawer-main-rows now rather than its first child — that nesting is what
  // made independent anchoring impossible.
  const rowsAt = html.indexOf('id="header-menu-rows"');
  const notifAt = html.indexOf('id="drawer-notifications"');
  const navAt = html.indexOf('id="drawer-main-rows"');
  assert.ok(rowsAt !== -1 && notifAt !== -1 && navAt !== -1, 'all three ids survive');
  assert.ok(rowsAt < notifAt && notifAt < navAt,
    'notifications first, navigation rows after, both inside #header-menu-rows');

  const rowsTag = html.slice(rowsAt, html.indexOf('>', rowsAt));
  assert.match(rowsTag, /flex flex-col/,
    '#header-menu-rows stays the column flex the anchoring depends on');

  // `mt-auto` collects the free space ABOVE the nav rows. It degrades on its
  // own when there is none (a short viewport, an expanded list), which is why
  // there is no measurement anywhere in this feature.
  const navTag = html.slice(navAt, html.indexOf('>', navAt));
  assert.match(navTag, /\bmt-auto\b/, 'the navigation rows must hug the bottom');
  const notifTag = html.slice(notifAt, html.indexOf('>', notifAt));
  assert.match(notifTag, /\bshrink-0\b/,
    'and the notifications block must not be squeezed to make room');
  assert.ok(!/\bmt-auto\b/.test(notifTag),
    'nothing may push the notifications block off the top');
});
