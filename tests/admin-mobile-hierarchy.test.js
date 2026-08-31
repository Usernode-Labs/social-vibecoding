// Mobile two-level admin console — the phone layout of the #admin screen.
//
// Below md the console is no longer one flat page behind a horizontally
// scrolling tab strip: level 1 is the grouped section menu (bare #admin),
// level 2 is one section (#admin/<key>) with the platform header's back
// button flipped to an arrow and its title set to the section label.
// Desktop (md and up) keeps the sidebar, the instant switching and the
// historical URLs — that half is pinned by admin-console-page.test.js.
//
// Contract pinned here:
//  - ONE breakpoint constant, read through matchMedia, in step with the
//    `md:` classes the shell still emits;
//  - the isAdmin gate runs BEFORE the "already open → route()" early
//    return, so an in-console hash navigation can't slip past it;
//  - the header back button consults AdminConsole.handleBack() behind
//    App._inAdmin and otherwise still goes home, and the arrow icon is
//    handed back on exit;
//  - handleBack() only calls history.back() for an entry we pushed
//    ourselves — a deep-linked section replaces instead, so back can
//    never walk the viewer off the console or into a bounce loop;
//  - returning to the menu tears the outgoing section down (the #860
//    poll-lifecycle rule, which a level change is a new way to break).
//
// Run with: node --test tests/admin-mobile-hierarchy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
const islandTsx = fs.readFileSync(path.join(root, 'frontend/src/features/admin/index.tsx'), 'utf8');

test('one breakpoint constant, read through matchMedia, in step with the md: classes', () => {
  assert.match(consoleJs, /DESKTOP_MEDIA: '\(min-width: 768px\)'/,
    'the sidebar breakpoint is declared once, as 768px (Tailwind md)');
  const isMobile = consoleJs.slice(consoleJs.indexOf('  _isMobile()'));
  assert.match(isMobile.slice(0, 300), /matchMedia\(AdminConsole\.DESKTOP_MEDIA\)/,
    '_isMobile reads the constant, never a hardcoded width');
  assert.match(isMobile.slice(0, 300), /catch \{ return false; \}/,
    'no matchMedia degrades to the desktop layout, not a phone layout');
  // If the shell stopped using md: the constant would silently disagree
  // with where the sidebar actually appears. Those two class strings are on
  // the React-owned chassis since #1082 chunk E — same classes, and the
  // disagreement they guard against is exactly as easy to introduce there.
  assert.match(islandTsx, /hidden md:block md:w-64/,
    'the sidebar still switches at md — the constant must match it');
  assert.match(islandTsx, /md:flex md:items-start md:gap-6/,
    'the shell row still switches at md');
});

test('level state and the viewport listener exist', () => {
  assert.match(consoleJs, /_level: 1,/, 'the console tracks which level is showing');
  assert.match(consoleJs, /_pushedFromMenu: false,/,
    'and whether the current level-2 entry was pushed by a menu tap');
  assert.match(consoleJs, /_ensureMediaListener\(\)\s*\{/,
    'a viewport listener re-resolves the layout on a breakpoint crossing');
  const openFn = consoleJs.slice(consoleJs.indexOf('  open(section, opts) {'));
  assert.match(openFn.slice(0, 900), /_ensureMediaListener\(\)/,
    'the listener is bound lazily on the first open');
  assert.match(openFn.slice(0, 900), /_pushedFromMenu = false/,
    'per-mount push state resets on entry — the stack below us is not ours');
});

test('a bare #admin means the MENU on mobile, Overview on desktop', () => {
  const openFn = consoleJs.slice(consoleJs.indexOf('  open(section, opts) {'));
  const head = openFn.slice(0, 1600);
  assert.match(head, /if \(AdminConsole\._isMobile\(\) && !valid\)/,
    'mobile + no section segment lands on level 1');
  assert.match(head, /AdminConsole\._level = 1;/,
    'that branch sets level 1 (never resurrects a last-visited section)');
  // Desktop's overview → #admin mapping survives; mobile spells it out so
  // level 1 and Overview stay distinguishable in the address bar.
  const writeHash = consoleJs.slice(consoleJs.indexOf('  _writeHash(key) {'));
  assert.match(writeHash.slice(0, 500),
    /key === 'overview' && !AdminConsole\._isMobile\(\)/,
    'only desktop collapses overview onto bare #admin');
  assert.match(writeHash.slice(0, 500), /location\.hash\.startsWith\(`\$\{target\}\/`\)/,
    'sections owning a second hash level (seasons, campaigns) are left alone');
});

test('a mobile drill-in is a real hash navigation, so device back works', () => {
  const openSection = consoleJs.slice(consoleJs.indexOf('  _openSection(key) {'));
  const body = openSection.slice(0, 800);
  assert.match(body, /location\.hash = target/,
    'the drill-in pushes a history entry via a real hash navigation');
  assert.match(body, /_pushedFromMenu = true/,
    'and records that the entry below us is our own menu');
  // A same-value assignment fires no hashchange — that case must still route.
  assert.match(body, /if \(location\.hash === target\)/,
    'a same-value hash assignment routes by hand instead of silently doing nothing');
});

test('handleBack pops only what we pushed, and replaces otherwise', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  handleBack() {'));
  const body = fn.slice(0, 1400);
  assert.match(body, /if \(!AdminConsole\._isMobile\(\) \|\| AdminConsole\._level !== 2\) return false;/,
    'desktop and level 1 fall through to the header button\'s normal home behaviour');
  const guardAt = body.indexOf('if (AdminConsole._pushedFromMenu)');
  const backAt = body.indexOf('history.back()');
  const replaceAt = body.indexOf('history.replaceState');
  assert.ok(guardAt > -1, 'the push guard exists');
  assert.ok(backAt > guardAt, 'history.back() is only reached under the guard');
  assert.ok(replaceAt > backAt,
    'a deep-linked section REPLACES its entry with the menu — no forward entry to bounce on');
  assert.match(body, /'pop'/, 'the manual path animates as a pop, not a push');
});

test('route() picks the transition direction from the level change', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  route(section, opts) {'));
  const body = fn.slice(0, 2000);
  assert.match(body, /targetLevel === 2 \? 'push' : 'pop'/,
    '1→2 pushes, 2→1 pops');
  assert.match(body, /targetLevel === AdminConsole\._level\s*\n?\s*\? 'none'/,
    'a same-level repaint is instant — the kit forbids animating those');
  assert.match(body, /const mobile = AdminConsole\._isMobile\(\);[\s\S]*if \(!mobile\) \{/,
    'desktop degenerates to the historical setSection path');
  assert.match(body, /_visibleSections\(\)/,
    'route re-validates the requested key against what this viewer may see');
});

test('route() is idempotent, so a duplicate dispatch never repaints twice', () => {
  // #1102, and the reason it is fixed here as well as in settings.js: both
  // screens are two-level consoles reached through the same hash router, and
  // a history traversal fires popstate AND hashchange. The second call
  // resolves the same target, so it asks the kit for type 'none' — which
  // runs SYNCHRONOUSLY — and repaints the level before the first call's View
  // Transition has captured the outgoing page, animating the new level
  // against a copy of itself.
  const fn = consoleJs.slice(consoleJs.indexOf('  route(section, opts) {'));
  const body = fn.slice(0, 2000);

  assert.match(
    body, /if \(targetLevel === AdminConsole\._level && targetSection === AdminConsole\._section\) \{/,
    'route() compares the resolved (level, section) target against current state',
  );
  const guardAt = body.search(/if \(targetLevel === AdminConsole\._level &&/);
  for (const mutation of ['AdminConsole.setSection(', 'AdminConsole._transition(']) {
    const at = body.indexOf(mutation);
    assert.ok(at > -1, `route() still performs ${mutation}`);
    assert.ok(guardAt < at, `the early-out must precede ${mutation}`);
  }
  // The public-mode flag is the exception that has to be applied BEFORE the
  // comparison: _visibleSections() reads it, so it decides what "the same
  // target" even means.
  const publicAt = body.indexOf('AdminConsole._public = ');
  assert.ok(publicAt > -1 && publicAt < guardAt,
    'opts.public is applied before the comparison — it changes which sections are visible, '
    + 'and therefore which section a bare #admin resolves to');
});

test('the header back button defers to the console, then goes home', () => {
  const handler = appJs.slice(appJs.indexOf("document.getElementById('back-btn').addEventListener"));
  // Wide enough for every screen hook the handler chains (admin, settings,
  // browse, the dev session), the follow-the-href step and the navigateHome
  // fallthrough below them.
  const body = handler.slice(0, 1800);
  assert.match(body, /App\._inAdmin && window\.AdminConsole\?\.handleBack\?\.\(\)/,
    'the console only gets a say while the admin screen is actually mounted');
  assert.match(body, /window\.location\.hash = href/,
    'a screen that named a parent goes THERE — the arrow\'s href is the answer');
  assert.match(body, /App\.navigateHome\(\)/,
    'and home is the fallback for a screen that named none');
});

test('the back button has both icons and one named toggle', () => {
  // TWO icons, exactly one shown. #back-icon-home retired in #1443 — Home is
  // a row of the chip's menu, so a house an inch to its left answered one
  // question twice — and came back when the rule became "every page has a
  // back or a home button, except Home": that retirement left the app itself,
  // Profile, Settings, Admin and Messages with nothing in the bar at all.
  //
  // BOTH SHIP IN THE COLD DOCUMENT and one carries `hidden`. Rendering only
  // the active glyph would take an id out of the shipped inventory whenever
  // the initial mode is the other one, and that inventory is a contract
  // (tests/shell-id-inventory.test.js, plus the dapp.json selectors).
  assert.ok(html.includes('id="back-icon-home"'), 'the house ships');
  assert.ok(html.includes('id="back-icon-arrow"'), 'the chevron ships');
  // #1036 widened it to setBackIcon(mode, href): the control is a real
  // anchor now, so the same choke point that owns which icon shows also
  // owns where it points.
  assert.match(appJs, /setBackIcon\(mode, href\)\s*\{/, 'App.setBackIcon owns the toggle');
  const fn = appJs.slice(appJs.indexOf('  setBackIcon(mode, href) {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  // The slot is React's, so the toggle PUBLISHES first — a rendered
  // className belongs to React and it rewrites the attribute from its own
  // props on every render of that island, which silently undid the
  // classList writes below once the header gained state (the app glyph,
  // the session status pill). See features/header/back-button-store.js.
  assert.match(body, /UsernodeReact\?\.backButton\?\.set\?\.\(/,
    'setBackIcon publishes the slot state rather than only writing to the DOM');
  assert.ok(body.indexOf('backButton') < body.indexOf('back-btn'),
    'the publish comes first; the DOM writes are the pre-hydration fallback');
  // The pre-hydration fallback toggles all three nodes again: the anchor for
  // 'none', and one glyph each for which of the two remaining modes it is.
  assert.match(body, /back-icon-home/, 'the fallback toggles the house');
  assert.match(body, /back-icon-arrow/, 'and the chevron');
  assert.match(body, /back-btn/, 'it toggles the anchor itself');
  // 'none' is what hides the slot now — NOT 'home', which draws a house.
  // The distinction is the whole point: a screen that publishes the default
  // gets a way out, and only Home publishes 'none'.
  assert.match(body, /slot === 'none'/,
    "the anchor hides on 'none' alone");
  assert.match(body, /setAttribute\('href'/, 'and retargets the anchor (#1036)');
  // Leaving the console must hand the button back, or every later screen
  // inherits a chevron that means "home" — but NOT from _exitAdminConsole
  // itself: that ran before the outgoing page had been captured by the
  // View Transition (#979). The shared screen-swap primitive resets it
  // inside the transition callback instead, so every screen entry (and
  // going home) hands the chevron back on exactly one code path.
  const exit = appJs.slice(appJs.indexOf('  _exitAdminConsole() {'));
  assert.ok(!exit.slice(0, exit.indexOf('\n  },')).includes('setBackIcon'),
    '_exitAdminConsole leaves the icon to _showOnlyScreen');
  const swap = appJs.slice(appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {'));
  assert.match(swap.slice(0, swap.indexOf('\n  },')), /App\.setBackIcon\('home'\)/,
    '_showOnlyScreen restores the home icon on every screen swap');
});

test('the admin gate runs before the already-open route() shortcut', () => {
  const fn = appJs.slice(appJs.indexOf('  navigateToAdminConsole('));
  const head = fn.slice(0, 1600);
  const gateAt = head.indexOf('if (!isAdmin && !publicMode)');
  const routeAt = head.indexOf('AdminConsole.route(section');
  assert.ok(gateAt > -1, 'the isAdmin/publicMode gate is present');
  assert.ok(routeAt > -1, 'the already-open shortcut is present');
  assert.ok(gateAt < routeAt,
    'the gate must come FIRST — otherwise an in-console hash navigation bypasses it');
  assert.match(head, /App\._inAdmin && window\.AdminConsole\?\.isOpen\?\.\(\)/,
    'the shortcut only fires when the console is genuinely mounted');
});

test('returning to the menu tears the active section down', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  _renderContent() {'));
  const body = fn.slice(0, 1200);
  const teardownAt = body.indexOf('_teardownActiveSection()');
  const menuAt = body.indexOf('_renderMobileMenu(host)');
  assert.ok(teardownAt > -1,
    'the menu path tears down — a back press out of Health & status must stop its 5s poll');
  assert.ok(menuAt > teardownAt, 'teardown happens BEFORE the menu replaces the DOM');
  assert.match(body, /_renderSection\(\)/, 'every other case renders a section');
});

test('the mobile menu is a list, not a tab set, with real tap targets', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  _mobileMenuHtml() {'));
  const body = fn.slice(0, 2000);
  assert.match(body, /min-h-\[44px\]/, 'rows meet the 44px touch-target floor');
  assert.match(body, /data-admin-section="\$\{s\.key\}"/,
    'rows reuse the existing section-button contract');
  assert.match(body, /aria-label="Admin sections"/, 'the list is a labelled nav');
  assert.ok(!/role="tab"/.test(body), 'menu rows are not tabs — no role="tab"');
  assert.ok(!/aria-selected/.test(body), 'and carry no aria-selected');
});

test('mobile section presses drill in; desktop presses switch in place', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  _wireSectionButtons(root) {'));
  const body = fn.slice(0, 700);
  assert.match(body, /if \(AdminConsole\._isMobile\(\)\) AdminConsole\._openSection\(key\)/,
    'mobile drills in (pushing history)');
  assert.match(body, /else AdminConsole\.setSection\(key\)/,
    'desktop keeps the in-place sidebar switch');
});

test('the header becomes the section nav bar on mobile level 2 only', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  _syncChrome() {'));
  const body = fn.slice(0, 900);
  assert.match(body, /AdminConsole\._isMobile\(\) && AdminConsole\._level === 2/,
    'only a mobile section view borrows the header');
  // #1036: the second argument is the anchor's href — inside a section
  // the chevron pops to the console's own menu, so that is where it points.
  // LEVEL 2 ONLY. The root's arrow (which pointed at Profile) is gone with the
  // other two account screens': Admin, Settings and Profile are reached from
  // the Home account row and left through it, and a header arrow duplicating
  // the row one tap below it read as chrome. The mobile drill-in keeps its
  // chevron because it is the only way up a level INSIDE this screen.
  assert.match(body, /setBackIcon\(inSection \? 'arrow' : 'home', inSection \? '#admin' : undefined\)/,
    'the chevron is the section view\'s alone; the root draws no back control');
  assert.match(body, /App\.setHeaderTitle\(s \? s\.label : /,
    'the title becomes the section label (which also feeds the native AppBar)');
  assert.match(body, /'Platform status'/,
    'public mode keeps its own console title at level 1');
});
