// Header slim-down: the fork label, the platform version, the kudos
// badge, the trophy and the admin shield all left the header for the slide-out
// drawer. #1101 later added the installed mobile-app version directly to it and
// removed the unrelated per-dApp SHA.
//
// The load-bearing property for the moved slots is that they kept their ids
// while changing parent — renderers across app.js / app-view.js / kudos.js
// resolve them with getElementById. A well-meaning rename or a "tidy up the
// header" edit that re-adds a slot would break the pane silently, so all of it
// is pinned here.
//
// Static-assertion style (cf. tests/theme-mode.test.js): read the
// shipped source files and assert the wiring is present.
//
// Run with: node --test tests/header-status-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const kudosJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/kudos.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

const header = html.slice(0, html.indexOf('</header>'));
const DRAWER_SLOTS = [
  'platform-version-pill-slot',
  'native-app-version-slot',
  'app-fork-badge-slot',
  'kudos-budget-slot',
];

// ─── The slots moved, and kept their ids ─────────────────────────────────

// The sidebar reorg (#913) split the old status pane in two: the budget
// slots (kudos, AI credit) stayed in #drawer-status-pane at the top,
// while the version pills + fork badge moved to the anchored
// #drawer-footer at the bottom of the panel. Same load-bearing property
// as before: every slot keeps its id, exactly once, in its region.
test('each drawer status slot exists exactly once in its assigned region', () => {
  const paneStart = html.indexOf('id="drawer-status-pane"');
  assert.ok(paneStart > -1, '#drawer-status-pane is missing from the shell');
  // The pane runs until the first drawer navigation row after it.
  const paneEnd = html.indexOf('id="drawer-row-node"');
  assert.ok(paneEnd > paneStart, 'the status pane sits above the Node row');
  const footerStart = html.indexOf('id="drawer-footer"');
  assert.ok(footerStart > paneEnd, '#drawer-footer sits below the nav rows');

  const PANE_SLOTS = ['kudos-budget-slot'];
  const FOOTER_SLOTS = [
    'platform-version-pill-slot', 'native-app-version-slot',
    'app-fork-badge-slot',
  ];
  for (const id of DRAWER_SLOTS) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
    const at = html.indexOf(`id="${id}"`);
    if (PANE_SLOTS.includes(id)) {
      assert.ok(at > paneStart && at < paneEnd,
        `#${id} lives inside #drawer-status-pane`);
    } else {
      assert.ok(FOOTER_SLOTS.includes(id), `#${id} is assigned a region`);
      assert.ok(at > footerStart, `#${id} lives inside #drawer-footer`);
    }
  }
});

test('none of the drawer status slots are duplicated in the header', () => {
  for (const id of DRAWER_SLOTS) {
    assert.ok(!header.includes(`id="${id}"`), `#${id} has left the header`);
  }
  assert.ok(!header.includes('id="leaderboard-btn"'),
    'the trophy left the header (it is #drawer-row-leaderboard now)');
  assert.ok(!header.includes('id="admin-dashboard-btn"'),
    'the admin shield left the header (it is #drawer-row-admin now)');
});

test('the header keeps navigation + alerting only, hamburger last', () => {
  // THE UI OVERHAUL took four controls out of this group — #app-mode-switch,
  // #feedback-btn, #work-drawer-btn and #dev-console-btn — and put the whole
  // of what they did behind #improve-btn. What is left is Improve, the bell
  // and the hamburger, in that order.
  const order = ['improve-btn', 'notifications-btn', 'header-menu-btn'];
  let prev = -1;
  for (const id of order) {
    const at = header.indexOf(`id="${id}"`);
    assert.ok(at > -1, `#${id} is still in the header`);
    assert.ok(at > prev, `#${id} comes after the previous header control`);
    prev = at;
  }
  // The hamburger is the catch-all menu now, so it owns the last slot.
  const menu = header.indexOf('id="header-menu-btn"');
  const bell = header.indexOf('id="notifications-btn"');
  assert.ok(menu > bell, 'the hamburger is the rightmost header control');
  // The retired four must not creep back in as a second way to do the same
  // things — that split is exactly what the overhaul removed.
  for (const id of ['app-mode-switch', 'feedback-btn', 'work-drawer-btn',
    'dev-console-btn']) {
    assert.equal(header.indexOf(`id="${id}"`), -1,
      `#${id} was retired into the Improve panel and must not return to the header`);
  }
});

// ─── The deploy dot ──────────────────────────────────────────────────────

// ─── Badge geometry ──────────────────────────────────────────────────────

test("the work badge sits exactly where the bell's unread one does", () => {
  // #notifications-badge-ai used to ride the work cog. The cog is retired, so
  // it rides the hamburger — same badge, same writer, new parent. The geometry
  // rule below is unchanged and is the whole point of the test.
  const cog = header.match(/<span id="notifications-badge-ai"[^>]*>/);
  const bell = header.match(/<span id="notifications-badge"[^>]*>/);
  assert.ok(cog, '#notifications-badge-ai is on the hamburger');
  assert.ok(bell, '#notifications-badge is on the bell');

  // Two badges side by side in the same header read as one convention
  // only if their geometry matches. Colour is the ONLY intended
  // difference (emerald = your work in flight, red = unread), so diff
  // the class lists with the colour token dropped and require equality —
  // that catches a corner, size or padding drift on either one.
  const classesOf = (tag) => tag.match(/class="([^"]*)"/)[1]
    .split(/\s+/).filter((c) => c && !/^bg-(emerald|red)-500$/.test(c)).sort();
  assert.deepEqual(classesOf(cog[0]), classesOf(bell[0]),
    'the two header badges must differ only in colour');

  // Pin the corner explicitly so the equality check above can't be
  // satisfied by moving BOTH badges somewhere unintended.
  assert.match(cog[0], /-top-1 -right-1/, 'the work badge is top-right');
  assert.match(bell[0], /-top-1 -right-1/, 'the bell badge is top-right');
  // …and keep the colours themselves distinct.
  assert.match(cog[0], /bg-emerald-500/, 'the cog badge stays green');
  assert.match(bell[0], /bg-red-500/, 'the bell badge stays red');
});

test('the hamburger carries the amber deploy dot, hidden by default', () => {
  const dot = header.match(/<span id="header-menu-deploy-dot"[^>]*>/);
  assert.ok(dot, 'the hamburger carries #header-menu-deploy-dot');
  assert.match(dot[0], /class="hidden /, 'ships hidden');
  assert.match(dot[0], /bg-amber-/, 'renders amber, matching the deploying pill');
  const btn = header.match(/<button id="header-menu-btn"[^>]*>/);
  assert.match(btn[0], /relative/, 'the button is a positioning context for the dot');
});

test('the deploy dot is derived from the rendered pills, not a duplicate flag', () => {
  // #1079 chunk B moved App.DrawerStatus into the React bundle, beside the
  // drawer markup it drives; app.js keeps a forwarder for its call sites.
  const headerMenuJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/header-menu-controller.js'), 'utf8');
  assert.match(headerMenuJs, /refreshDeployDot\(\)\s*\{/, 'DrawerStatus.refreshDeployDot is defined');
  const fn = headerMenuJs.slice(headerMenuJs.indexOf('  refreshDeployDot() {'));
  // Post-#913 the version rows live in #drawer-footer and signal a
  // rolling deploy with .drawer-ver--deploying instead of the pill class.
  assert.match(fn.slice(0, 600), /#drawer-footer \.drawer-ver--deploying/,
    'reads the deploying state off the rendered pills — the single source of truth');
  // The platform-revision renderer and the drawer lifecycle both synchronize
  // the dot. dApp deploy pills live on home cards and are out of scope.
  const calls = (appJs.match(/DrawerStatus\.refreshDeployDot\(\)/g) || []).length
    + (headerMenuJs.match(/DrawerStatus\.refreshDeployDot\(\)/g) || []).length;
  assert.ok(calls >= 2,
    `refreshDeployDot is called from the revision renderer and lifecycle (found ${calls})`);
});

// ─── App-scoped row lifecycle ────────────────────────────────────────────

test('the mobile app version and fork rows ship hidden', () => {
  const nativeRow = html.match(/<div id="drawer-row-native-app-version"[^>]*>/);
  const forkRow = html.match(/<div id="drawer-row-app-fork"[^>]*>/);
  assert.ok(nativeRow, '#drawer-row-native-app-version exists');
  assert.ok(forkRow, '#drawer-row-app-fork exists');
  assert.match(nativeRow[0], /class="hidden /,
    'the mobile app version ships hidden until the native bridge answers');
  assert.match(forkRow[0], /class="hidden /, 'the fork row ships hidden');

  // Hidden from every navigate* that leaves an app behind — one call per
  // site that also hides #drawer-row-share.
  const hides = (appJs.match(/DrawerStatus\.setAppOpen\(false\)/g) || []).length;
  const shareHides = (appJs.match(/if \(_drs\) _drs\.classList\.add\('hidden'\);/g) || []).length;
  assert.ok(hides > shareHides,
    'setAppOpen(false) runs everywhere the Share row is hidden, plus navigateHome');
  assert.match(appJs, /DrawerStatus\.setAppOpen\(true\)/,
    'the app-open lifecycle still drives the header mode switch');
  assert.match(appViewJs, /DrawerStatus\.setAppOpen\(false\)/,
    'AppView.close() clears app-scoped lineage too');
});

test('version information contains no particular dApp version', () => {
  assert.doesNotMatch(html, /drawer-row-app-version|app-version-pill-slot|dApp version/);
  assert.doesNotMatch(appViewJs, /\b(?:refreshVersionPill|applyHeaderDeployProgress)\b/,
    'opening a dApp no longer fetches or paints its SHA into the drawer');
  assert.match(html, /Platform version/,
    'the platform build row carries the #1211 "Platform version" label');
  assert.match(html, /Mobile app version/,
    'the semantic version/build is labelled as the installed mobile app');
});

test('the fork row visibility is driven by renderForkBadge', () => {
  // Anchored on the next member, not on `_forkSource`: that field moved into
  // the fork dialog's island in #1078 chunk I and survives here only in the
  // comment explaining where it went.
  const fn = appViewJs.slice(
    appViewJs.indexOf('  renderForkBadge() {'),
    appViewJs.indexOf('  promptFork(source) {')
  );
  assert.ok(fn.length > 0, 'renderForkBadge located');
  assert.match(fn, /setRow\(false\)/, 'a non-fork hides the row');
  assert.match(fn, /setRow\(true\)/, 'a fork reveals it');
  assert.match(fn, /DrawerStatus\.setForkVisible/, 'through DrawerStatus.setForkVisible');
});

// ─── Status-pane rows are not clickable containers ───────────────────────

test('status-pane rows are plain divs — the pills carry their own anchors', () => {
  // renderPlatformVersionPill's stale state renders a <button
  // onclick="location.reload()">, and the live state an <a>. Nesting
  // those inside a clickable row would be invalid markup.
  for (const id of ['drawer-row-platform-version',
    'drawer-row-native-app-version', 'drawer-row-app-fork', 'drawer-row-kudos',
    'drawer-row-ai-budget']) {
    const row = html.match(new RegExp(`<(\\w+) id="${id}"`));
    assert.ok(row, `${id} exists`);
    assert.equal(row[1], 'div', `${id} is a <div>, never an <a>/<button>`);
  }
});

// ─── AI-credit row (#555) ────────────────────────────────────────────────

// Every signed-in user sees their own daily AI allowance here. The row
// ships hidden because its audience isn't known until the me-scoped
// fetch answers. Pinned here alongside the older slots.
//
// A sibling admin-only "Anthropic credits" row shipped in the same pane
// and was removed again (it could only ever read "Not set up"); the
// balance lives solely in the console's Spend limits section now.

test('the AI-credit row lives in the status pane and ships hidden', () => {
  const paneStart = html.indexOf('id="drawer-status-pane"');
  const paneEnd = html.indexOf('id="drawer-row-node"');
  const id = 'drawer-row-ai-budget';
  const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at > paneStart && at < paneEnd, `#${id} lives inside #drawer-status-pane`);
  const row = html.match(new RegExp(`<div id="${id}"[^>]*>`));
  assert.ok(row, `#${id} is a <div>`);
  assert.match(row[0], /class="hidden /, `#${id} ships hidden`);
  // Its slot is resolved by getElementById, same contract as the older
  // pills — a rename would break the renderer silently.
  assert.equal((html.match(/id="ai-budget-slot"/g) || []).length, 1,
    'exactly one #ai-budget-slot in the shell');
});

test('the Anthropic-credits row is gone from the shell and from renderAdminButton', () => {
  // Removed deliberately — it could only ever read "Not set up" on a
  // deployment with no recorded balance. Guard against it drifting back
  // in through the markup or the admin-visibility helper.
  assert.ok(!/drawer-row-anthropic-credits/.test(html),
    'no #drawer-row-anthropic-credits row in the shell');
  assert.ok(!/anthropic-credits-slot/.test(html),
    'no #anthropic-credits-slot in the shell');
  const fn = appJs.slice(appJs.indexOf('  renderAdminButton() {'));
  const body = fn.slice(0, 800);
  assert.ok(!/anthropic/i.test(body),
    'renderAdminButton owns only the console row now');
  assert.match(body, /App\.user\?\.isAdmin/,
    'still gated on isAdmin — view-only admins are part of the audience');
  assert.ok(!/canAdminWrite/.test(body),
    'never gated on canAdminWrite, which would exclude view-only admins');
});

// ─── CSS: the mobile collapse must no longer hide the moved slots ────────

test('the ≤640px collapse rule no longer hides the drawer slots', () => {
  // There are several max-width:640px blocks in the sheet — isolate the
  // pill-collapse one by its section comment.
  const from = css.indexOf('── Mobile pill collapse ');
  assert.ok(from > -1, 'the Mobile pill collapse section is present');
  const mq = css.slice(css.indexOf('@media (max-width: 640px)', from));
  const block = mq.slice(0, mq.indexOf('\n}\n'));
  assert.ok(!block.includes('#platform-version-pill-slot'),
    'the platform pill renders at every width now — it is in the drawer');
  // The home-card class slot still collapses: those pills DO crowd the
  // app name on a narrow card.
  assert.ok(block.includes('.app-version-pill-slot:not(:has(.app-version-pill--deploying))'),
    'the home-card pill slot still collapses on narrow viewports');
});

test('the drawer constrains a long pill so it cannot widen the 15rem panel', () => {
  // Post-#913 the version rows are .drawer-ver entries in the footer;
  // the width constraint moved onto that class (max-width + ellipsis).
  assert.match(css, /\.drawer-ver \{[^}]*max-width/,
    'version rows in the drawer footer are width-capped');
  assert.match(css, /\.drawer-ver \{[^}]*text-overflow:\s*ellipsis/,
    'and their value truncates rather than overflowing');
});

// ─── One scroller, with the theme control and status pane inside it ──────

test('the drawer body is one scroller holding the theme control and status pane', () => {
  const scroller = html.match(/<div id="header-menu-rows"[^>]*>/);
  assert.ok(scroller, '#header-menu-rows exists');
  assert.match(scroller[0], /overflow-y-auto/, 'the drawer body scrolls');
  assert.match(scroller[0], /min-h-0/,
    'min-h-0 is required for a flex child to actually scroll rather than grow');
  const at = html.indexOf('id="header-menu-rows"');
  for (const id of ['drawer-row-theme', 'drawer-status-pane', 'drawer-row-admin']) {
    assert.ok(html.indexOf(`id="${id}"`) > at, `#${id} is inside the scroller`);
  }
});

// ─── The kudos badge no longer pokes at header layout ────────────────────

test('the kudos badge stopped driving the header title measurement', () => {
  assert.ok(!/HeaderLayout\?\.refresh/.test(kudosJs),
    'the badge is in the drawer now — it cannot affect the centred header title');
  assert.match(kudosJs, /getElementById\('kudos-budget-slot'\)/,
    'and still resolves its slot by the unchanged id');
});
