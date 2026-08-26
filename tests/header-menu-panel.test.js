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
// The bundle's boot seam moved off this island: ./platform-header.tsx is the
// first island in the shell and it never unmounts, so the side-effect imports
// and the init()s that used to ride the drawer live there.
const platformHeaderTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/platform-header.tsx'), 'utf8');
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

test('the touch branch presents a left-side kit panel', () => {
  const body = openBody();
  assert.match(body, /gate:\s*'touch'/, 'still gated on the touch platform');
  assert.match(body, /kind:\s*'panel'/, 'a panel, not a sheet');
  // Streamlined Concept: the drawer mirrors the hamburger, which leads the
  // header's LEFT group now.
  assert.match(body, /side:\s*'left'/, 'a drawer that opens from the bottom is the bug being fixed');
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
  // This used to read the two `btn.setAttribute` pairs literally. THE
  // HAMBURGER IS GONE — the Streamlined Concept deleted #header-menu-btn
  // while the drawer itself survives, presented programmatically by
  // ?shot=menu-nav for the #977 single-motion checks — so all five of those
  // pairs ran against `null` and threw out of onDismiss and close(). That
  // surfaces as "1 console error on load", and a console error on any route
  // fails proposal checks.
  //
  // So the contract is the same one, expressed through ONE guarded helper:
  // the touch branch still announces the expanded state (it returns early,
  // and before that it left the button reading "Open menu" for as long as
  // the drawer was open), every exit path still resets it, and neither
  // throws when the button is not there.
  assert.match(body, /HeaderMenu\._setBtnState\(true\)/,
    'opening must announce the expanded state on the touch path');
  const dismiss = body.slice(body.indexOf('onDismiss: () => {'), body.indexOf('if (adoption) {'));
  assert.match(dismiss, /HeaderMenu\._setBtnState\(false\)/,
    'every exit path routes through onDismiss — reset the state there');

  const helper = headerMenuJs.slice(headerMenuJs.indexOf('  _setBtnState(open) {'));
  const fn = helper.slice(0, helper.indexOf('\n  },'));
  assert.match(fn, /if \(!btn\) return;/,
    'the helper must no-op when the hamburger is absent — that is the whole point');
  assert.match(fn, /aria-expanded'[\s\S]{0,120}?'Close menu'/,
    'it still writes both attributes, both ways');
  assert.ok(!/\bbtn\.setAttribute\(/.test(headerMenuJs.replace(fn, '')),
    'no unguarded btn.setAttribute may survive outside the helper');
});

test('init binds the drawer without needing the hamburger', () => {
  const init = headerMenuJs.slice(headerMenuJs.indexOf('  init() {'));
  const body = init.slice(0, 1200);
  // `if (!btn) return` used to gate this whole function, back when the
  // button was the drawer's only entry point and its absence therefore
  // meant "no drawer here". With the button deleted that early return
  // skipped the close button, the overlay, Escape AND the single-motion
  // link rule (#977) for a drawer that ?shot=menu-nav still opens.
  assert.ok(!/const btn = document\.getElementById\('header-menu-btn'\);\n\s*if \(!btn\) return;/.test(body),
    'the missing hamburger must not gate the rest of the wiring');
  assert.match(body, /getElementById\('header-menu-btn'\)\s*\n?\s*\?\.addEventListener/,
    'the button is just one more conditional binding now');
  assert.match(body, /getElementById\('header-menu-close'\)\s*\n?\s*\?\.addEventListener/,
    'the close button binds whether or not the hamburger shipped');
  assert.match(body, /getElementById\('header-menu-overlay'\)\s*\n?\s*\?\.addEventListener/,
    'and so does the backdrop');
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

test('init() is called from an island, not from App.bindEvents()', () => {
  assert.ok(!/App\.HeaderMenu\.init\(\);/.test(appJs),
    'binding from bindEvents() would run before hydration adopted #header-menu-panel');
  assert.match(platformHeaderTsx, /window\.HeaderMenu\?\.init\(\)/,
    'the header bar island owns the wiring now — it is the earliest one');
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

test("the app's rows are the Improve panel's; alerting is the header's", () => {
  // Streamlined Concept: the board draws ONE app-scoped drawer, so the
  // Notifications and Messages rows became header glyphs and the Your-apps
  // list became the Apps sheet. The app's own rows then merged INTO the
  // Improve panel — one surface for the app's navigation and its work rather
  // than two that half-overlapped — so the drawer no longer renders them.
  // The bell's init runs from the HEADER BAR's layout effect: the earliest
  // island, and one that never unmounts.
  assert.ok(!/<AppContextRows \/>/.test(headerMenuTsx),
    'the drawer no longer renders the app-scoped rows');
  const panelTsx = fs.readFileSync(
    path.join(root, 'frontend/src/features/improve/improve-panel.tsx'), 'utf8');
  assert.match(panelTsx, /id="improve-views"/,
    'the Improve panel renders them instead');
  assert.match(platformHeaderTsx, /window\.Notifications\?\.init\(\)/,
    'and the header bar initialises the module from its layout effect, before DOMContentLoaded');
  for (const gone of ['drawer-row-notifications', 'drawer-row-messages',
    'drawer-your-apps']) {
    assert.equal(headerMenuTsx.indexOf(`id="${gone}"`), -1,
      `#${gone} left the drawer with the Streamlined restructure`);
  }
  assert.ok(html.includes('id="notifications-btn"') && html.includes('id="messages-btn"'),
    'both are header controls now');
  assert.equal(html.indexOf('id="notifications-panel"'), -1,
    'the retired bell panel must not still ship');
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
  // that copy along with the panel it presented. The list has its own sheet
  // again (Streamlined Concept), but the adoption is not this module's: it
  // goes through lib/sheet-controller.js, the one chassis all three sheets
  // share, so there is still exactly one copy of the dance.
  const notifications = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  assert.ok(!/platform-sheet-adopted/.test(notifications),
    'the retired fifth copy of the adoption dance must not linger');
  assert.ok(!/adoptKitSurface/.test(notifications),
    'and this module does not adopt anything itself either');
  assert.match(notifications, /window\.NotificationsSheet\?\.open\?\.\(\)/,
    'show() forwards to the sheet controller that actually presents the list');
  const sheetChassis = fs.readFileSync(
    path.join(root, 'frontend/src/lib/sheet-controller.js'), 'utf8');
  assert.match(sheetChassis, /kind: 'sheet'/,
    'the chassis is where the three sheets ask for the kind');
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

test("the account rows are the drawer's only block, still bottom-anchored", () => {
  // The app rows used to sit above these, taking the free space; they are the
  // Improve panel's now. What the anchoring has to survive is that removal:
  // #drawer-main-rows keeps `mt-auto`, so it hugs the bottom of the column
  // rather than floating at the top of an otherwise empty panel.
  const rowsAt = html.indexOf('id="header-menu-rows"');
  const navAt = html.indexOf('id="drawer-main-rows"');
  assert.ok(rowsAt !== -1 && navAt !== -1, 'both ids survive');
  assert.ok(rowsAt < navAt, 'the account rows sit inside #header-menu-rows');
  assert.ok(html.indexOf('id="drawer-app-rows"') === -1,
    'the app rows left the drawer with the merge');

  const rowsTag = html.slice(rowsAt, html.indexOf('>', rowsAt));
  assert.match(rowsTag, /flex flex-col/,
    '#header-menu-rows stays the column flex the anchoring depends on');

  const navTag = html.slice(navAt, html.indexOf('>', navAt));
  assert.match(navTag, /\bshrink-0\b/, 'the navigation rows keep their height');
  assert.match(navTag, /\bmt-auto\b/, 'and hug the bottom');
  assert.ok(!/\boverflow-y-auto\b/.test(rowsTag),
    '#header-menu-rows itself must not scroll');
});

// ── The follow-up: the SECTION is not collapsible; its GROUPS are ────
//
// #1367 collapsed the whole notifications section behind a disclosure and the
// follow-up took that back out: the useful grain is each app group inside the
// section, not the section itself. Both halves are pinned here — the section
// has no disclosure, and the groups re-fold on every drawer open — because
// each fails silently if it drifts (a section that quietly ships collapsed
// again, or groups that stay expanded from the last visit).

test('the Apps sheet is the app switcher, and the drawer keeps the account rows', () => {
  // Streamlined Concept: switching apps is the board's Apps sheet behind the
  // title tab, not a section inside the drawer.
  for (const id of ['apps-switcher-sheet', 'apps-switcher-create',
    'apps-switcher-list', 'apps-switcher-home', 'apps-switcher-explore']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} ships with the switcher`);
  }
  // What the drawer keeps: the account rows, and only those. The app's own
  // rows (#app-context-row-*) still ship — in the Improve panel.
  for (const id of ['drawer-row-profile', 'drawer-row-settings', 'drawer-row-admin']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} survives in the drawer`);
  }
  for (const id of ['app-context-row-app', 'app-context-row-board',
    'app-context-row-activity']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} ships with the Improve panel`);
  }
  // The panel is a LATER island than the drawer in Shell.tsx, which is why
  // the rows now appear after it in the document — the merge moved them
  // forward in the tree, not backward.
  assert.ok(
    html.indexOf('id="drawer-main-rows"') < html.indexOf('id="improve-views"'),
    'the drawer ships before the panel that took its rows');
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

test('read notifications keep a way back, on the screen', () => {
  const notificationsJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications.js'), 'utf8');
  const screenTsx = fs.readFileSync(
    path.join(root, 'frontend/src/features/notifications/notifications-sheet.tsx'), 'utf8');

  // Streamlined Concept: the list is the #notifications screen. Read rows
  // are always in hand there — the All tab shows them, Unread filters them —
  // so the drawer-era showOlder reveal has no renderer; what survives is
  // that "viewed" stays the EXISTING readAt field (nothing stored, nothing
  // deleted) and the screen's pager keeps the server cursor reachable.
  assert.match(screenTsx, /tab === 'unread' \? unread : all/,
    'the two tabs are a client-side partition of the same rows');
  assert.match(screenTsx, /screenCanLoadMore/,
    'the screen offers the keyset pager');
  assert.match(notificationsJs, /screenList: Notifications\.items\.map\(rowView\)/,
    'the screen list is every fetched row, read and unread');

  // Two DIFFERENT empty states survive as the two tab sentences.
  assert.match(screenTsx, /all caught up/, 'the caught-up state exists');
  assert.match(screenTsx, /Nothing here yet/, 'and the never-had-one state survives');
});
