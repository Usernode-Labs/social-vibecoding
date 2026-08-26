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

test('#1436: the CHIP reflects the expanded state, on both paths, guarded', () => {
  const body = openBody();
  // The trigger is #app-switcher-btn now. Writing to the retired
  // #header-menu-btn unguarded threw `Cannot read properties of null` on every
  // open and every dismiss — the "1 console error on load" three declared
  // checks caught on ?shot=menu-nav.
  assert.match(headerMenuJs, /_setTriggerExpanded\(expanded\)\s*\{/,
    'one guarded helper owns the trigger state');
  const helper = headerMenuJs.slice(headerMenuJs.indexOf('  _setTriggerExpanded(expanded) {'));
  assert.match(helper.slice(0, 400), /getElementById\('app-switcher-btn'\)/,
    'it resolves the chip, not the retired hamburger');
  assert.match(helper.slice(0, 400), /if \(trigger\)/,
    'and GUARDS it — the chip is absent on the platform\'s own screens, where '
    + 'there is no app to name, and the menu is still openable by deep link');

  // aria-label is deliberately NOT written: the chip is React-owned and
  // renders its own ("Switch app — currently <app>"), so a write here would be
  // reconciled away and would say the wrong thing until it was.
  assert.ok(!/'Close menu'|'Open menu'/.test(headerMenuJs),
    'the controller must not fight React for the chip\'s label');

  // The touch branch used to return before the aria writes; it still must not.
  assert.match(body, /_setTriggerExpanded\(true\)[\s\S]{0,120}?return;/,
    'opening announces the expanded state on the touch path too');
  const dismiss = body.slice(body.indexOf('onDismiss: () => {'), body.indexOf('if (adoption) {'));
  assert.match(dismiss, /_setTriggerExpanded\(false\)/,
    'every exit path routes through onDismiss — reset the state there');
});

test('#1436: init() binds the drawer even with no hamburger to hang it on', () => {
  // It resolved #header-menu-btn and `return`ed when it was missing. With the
  // button retired that early return killed everything after it — the ✕, the
  // overlay click, Escape, and the single-motion nav-arm rule #977's checks
  // are about — while the drawer still OPENED, because its trigger is the
  // chip's own React onClick. Silent, and exactly the shape of bug the
  // declared checks exist to catch.
  const init = headerMenuJs.slice(headerMenuJs.indexOf('  init() {'));
  const head = init.slice(0, 1400);
  assert.ok(!/getElementById\('header-menu-btn'\)/.test(head),
    'init must not depend on the retired button');
  assert.match(head, /getElementById\('header-menu-panel'\)[\s\S]{0,80}?if \(!panel\) return;/,
    'the PANEL is what has to exist for the drawer to be wired');
  assert.match(init, /header-menu-close[\s\S]{0,120}?addEventListener/,
    'and the close button is bound');
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

test('#1436: notifications LEFT the drawer, and the bell came back', () => {
  // THE UI OVERHAUL merged the bell in here on the reasoning that two
  // top-right drawers opening the same way one slot apart were one affordance
  // too many. #1436 does not undo that merge, it finishes it: the hamburger is
  // gone entirely — the surface is opened by the labelled app-switcher chip on
  // the LEFT — so the bell is no longer a second drawer beside a first one.
  assert.equal(headerMenuTsx.indexOf('<NotificationsBody />'), -1,
    'the drawer must not render the notifications body any more');
  assert.equal(headerMenuTsx.indexOf('id="drawer-notifications"'), -1,
    'nor carry the region it lived in');
  assert.match(html, /id="notifications-panel"/,
    'the bell panel is back, as its own sheet');
  assert.match(html, /id="notifications-btn"/, 'with its own control');
  assert.match(html, /id="notifications-badge"/,
    'carrying the red unread count it was named for');
  assert.equal(html.indexOf('id="header-menu-btn"'), -1,
    'and the hamburger button is gone');
  assert.match(html, /id="app-switcher-btn"/,
    'replaced by the chip that opens the same surface');
});

test('#1436: the drawer keeps its surface, and its module keeps its boot role', () => {
  // The re-aim is deliberately NOT a rewrite. #header-menu-panel, its
  // controller and its kit `panel` adoption are untouched, which is what lets
  // this island keep the side-effect imports that install window.AiCredit,
  // NodePill, WalletSheet and NativeAppVersion — it is still the earliest
  // island in the bundle, and their init() calls still run in its layout
  // effect, inside flushSync(hydrateRoot) and before DOMContentLoaded.
  assert.match(html, /id="header-menu-panel"/, 'the surface survives');
  assert.match(headerMenuTsx, /window\.NodePill\?\.init\(\)/, 'node pill still boots here');
  assert.match(headerMenuTsx, /window\.WalletSheet\?\.init\(\)/, 'wallet too');
  assert.match(headerMenuTsx, /window\.NativeAppVersion\?\.init\(\)/, 'and the app version');
  assert.match(headerMenuTsx, /window\.HeaderMenu\?\.init\(\)/, 'and the drawer wiring itself');
  // The notifications module's init moved WITH the list, to the sheet.
  assert.equal(headerMenuTsx.indexOf('window.Notifications?.init()'), -1,
    'notifications init moved to the sheet that renders the list');
});

test('#1436: Messages is a row in the switcher menu, with its own count', () => {
  // It briefly had a header control of its own beside the bell. That put two
  // inboxes in the bar and broke the rule this menu holds: it lists the things
  // with their own PAGE — home, your apps, Discover, Messages, Profile,
  // Settings — and Messages has one. A page reachable two ways, one of them a
  // header slot, is the header growing back.
  assert.match(headerMenuTsx, /id="drawer-row-messages"/, 'the Messages row is in the menu');
  assert.match(html, /id="drawer-row-messages" href="#messages"/, 'and points at its page');
  assert.equal(html.indexOf('id="messages-btn"'), -1,
    'and there is no header control competing with it');
  // Same id, so the Messages store paints the count unchanged.
  assert.match(html, /id="drawer-messages-badge"/,
    'the unread count rides the row, not the bar');
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
  // that copy along with the panel it presented. #1436 gave the list its own
  // sheet back, and the copy did NOT come back with it: the presentation lives
  // in ../notifications/sheet-controller.js and goes through the shared
  // adoptKitSurface, like every other surface.
  const notifications = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  assert.ok(!/platform-sheet-adopted/.test(notifications),
    'the retired fifth copy of the adoption dance must not linger');
  assert.match(notifications, /window\.NotificationsSheet\?\.open\?\.\(\)/,
    'show() forwards to the controller that actually presents the list');
  const sheetController = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/sheet-controller.js'), 'utf8');
  assert.ok(!/platform-sheet-adopted/.test(sheetController),
    'and the new controller does not re-introduce the hand-written class either');
  assert.match(sheetController, /adoptKitSurface\(/,
    'it uses the shared lift');
  assert.match(sheetController, /kind: 'sheet'/, 'asking for the sheet kind');
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

// ── #1367: what the drawer looks like the moment it opens ────────────
//
// Two changes, both about where your eye and your thumb land. Neither has a
// runtime assertion that would catch a regression — a collapsed section that
// quietly ships expanded, or an anchor that quietly reverts to a top-stacked
// list, both still render — so each strand is pinned against the source and
// against the prerendered document in the style of the contracts above.

test('#1436: the sheet holds one scroller, and the drawer keeps its nav rows', () => {
  // Both halves of what #1367 settled, carried across the move rather than
  // re-decided. The sheet inherits the scrolling rule; the drawer keeps the
  // anchoring one.
  //
  // WHY THE SCROLL IS ON THE WRAPPER, not on #notifications-list: the saved
  // and invites sections are capped at `max-h-48` EACH, so on a short viewport
  // those two caps alone can consume the whole block and leave the list at
  // zero height — the notifications themselves, invisible, in the
  // notifications panel. One scroller over all three lets them share the space
  // in the order they are written.
  const panelAt = html.indexOf('id="notifications-panel"');
  const scrollAt = html.indexOf('id="notifications-body-scroll"');
  const listAt = html.indexOf('id="notifications-list"');
  assert.ok(panelAt !== -1 && scrollAt !== -1 && listAt !== -1, 'all three ids ship');
  assert.ok(panelAt < scrollAt && scrollAt < listAt, 'panel > scroller > list');

  const scrollTag = html.slice(scrollAt, html.indexOf('>', scrollAt));
  assert.match(scrollTag, /\bflex-1\b/, 'the scroller takes what the header leaves');
  assert.match(scrollTag, /\bmin-h-0\b/,
    'and may shrink below its content, which is what lets it scroll');
  assert.match(scrollTag, /\boverflow-y-auto\b/, 'and is the element that scrolls');

  // The drawer's own rows are unchanged by the move.
  const rowsAt = html.indexOf('id="header-menu-rows"');
  const navAt = html.indexOf('id="drawer-main-rows"');
  assert.ok(rowsAt !== -1 && navAt !== -1, 'the drawer keeps its structure');
  assert.match(html.slice(rowsAt, html.indexOf('>', rowsAt)), /flex flex-col/,
    '#header-menu-rows stays the column flex');
});

test('#1436: the notifications SECTION still has no disclosure of its own', () => {
  // #1367 collapsed the whole section behind a disclosure and its follow-up
  // took that back out: the useful grain is each app GROUP inside the section,
  // not the section itself. That decision travels with the list to the sheet,
  // and is pinned here because it fails silently if it drifts.
  const block = html.slice(
    html.indexOf('id="notifications-panel"'),
    html.indexOf('id="notifications-list"') + 200,
  );
  assert.ok(!/<div class="hidden">/.test(block),
    'the section body must not ship inside a hidden wrapper');
  const sheetTsx = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications-sheet.tsx'), 'utf8');
  assert.ok(!/notificationsOpen/.test(sheetTsx),
    'no section-collapse state in the island that renders it');
  assert.ok(!/sv:notifications-expand/.test(sheetTsx), 'and no expand channel for it');
});

test('each drawer open starts on what is NEW', () => {
  const notificationsJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  // This used to assert a second thing too: that every app GROUP re-folded on
  // the same announcement. #1385 flattened the list, so there is nothing left
  // to fold — the show-older reset is the whole of the drawer-open contract now.
  assert.match(notificationsJs, /addEventListener\('sv:drawer-open'/,
    'the module listens for the drawer-open announcement');
  const at = notificationsJs.indexOf("addEventListener('sv:drawer-open'");
  const body = notificationsJs.slice(at, notificationsJs.indexOf('});', at));
  assert.match(body, /_setShowOlder\(false\)/,
    'and resets to the unread list, so a visit never opens on last time\u2019s "older"');
  assert.doesNotMatch(body, /_foldAllGroups/, 'nothing folds any more — there are no groups');
  // The announcement is still dispatched once, above the touch/desktop fork.
  assert.match(headerMenuJs, /dispatchEvent\(new CustomEvent\('sv:drawer-open'\)\)/);
});

test('read notifications leave the list, with a way back to them', () => {
  const notificationsJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  const listTsx = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications-list.tsx'), 'utf8');

  // "Viewed" is the EXISTING readAt field — nothing new is stored and nothing
  // is deleted, which is what lets the older view bring them all back.
  const at = notificationsJs.indexOf('  _bellItems() {');
  const body = notificationsJs.slice(at, notificationsJs.indexOf('\n  },', at));
  assert.match(body, /filter\(\(n\) => !n\.readAt\)/,
    'the default list is the unread ones');
  assert.match(body, /if \(Notifications\.showOlder\) return Notifications\.items;/,
    'and the older view is every one of them');

  // Per drawer OPEN, so a visit always starts on what is new.
  assert.match(notificationsJs, /_setShowOlder\(false\)/,
    'the older view resets when the drawer opens');

  // Two DIFFERENT empty states. "You have never had a notification" and "you
  // have dealt with all of them" are not the same sentence, and showing the
  // first to somebody with a month of history reads as lost data.
  assert.match(listTsx, /id="notifications-caught-up"/, 'the caught-up state exists');
  assert.match(listTsx, /id="notifications-empty"/, 'and the never-had-one state survives');
  assert.match(notificationsJs, /caughtUp: olderCount > 0 && !Notifications\.showOlder/,
    'caught-up means nothing unread but something behind the toggle');
  assert.match(notificationsJs, /olderCount === 0/,
    'and the original empty hint now requires there be no history either');

  // The toggle only renders when it would reveal something.
  assert.match(listTsx, /state\.olderCount > 0 \?/,
    'no older button when there is nothing older');
});
