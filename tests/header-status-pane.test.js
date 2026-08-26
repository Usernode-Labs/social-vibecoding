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
// THE UI OVERHAUL emptied the drawer of everything that was not navigation or
// notifications. These four slots are the load-bearing survivors, and where
// each one now lives is the thing this file pins:
//
//   #platform-version-pill-slot  → the Improve panel's footer (app-scoped
//   #native-app-version-slot        reference information, which is what the
//   #app-fork-badge-slot            panel is for)
//   #kudos-budget-slot           → RETIRED with the drawer's status pane. The
//                                  kudos figure lives on the Leaderboard,
//                                  which the home screen's Challenges area
//                                  links to.
//   #ai-budget-slot              → Settings → Anthropic API key
//
// The load-bearing property is unchanged and is why they are pinned at all:
// each kept its id while changing parent, because renderers across app.js /
// app-view.js / kudos.js resolve them with getElementById. A well-meaning
// rename would break the value silently.
const IMPROVE_SLOTS = [
  'platform-version-pill-slot',
  'native-app-version-slot',
  'app-fork-badge-slot',
];

test('each surviving slot exists exactly once, in its new region', () => {
  const improveStart = html.indexOf('id="improve-footer"');
  assert.ok(improveStart > -1, '#improve-footer is missing from the shell');
  for (const id of IMPROVE_SLOTS) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
    assert.ok(html.indexOf(`id="${id}"`) > improveStart,
      `#${id} lives inside the Improve panel's footer`);
  }

  // The AI-credit slot is a settings pane's now.
  const apiKey = html.indexOf('data-settings-section="api-key"');
  assert.ok(apiKey > -1, 'the api-key settings pane is missing');
  assert.ok(html.indexOf('id="ai-budget-slot"') > apiKey,
    '#ai-budget-slot lives inside the Anthropic API key section');

  // And the drawer's status pane is gone outright, meters included.
  for (const id of ['drawer-status-pane', 'drawer-row-kudos', 'kudos-budget-slot',
    'drawer-footer', 'drawer-row-theme']) {
    assert.equal(html.indexOf(`id="${id}"`), -1, `#${id} was retired`);
  }
});

test('none of the moved slots are duplicated in the header', () => {
  for (const id of [...IMPROVE_SLOTS, 'ai-budget-slot', 'kudos-budget-slot']) {
    assert.ok(!header.includes(`id="${id}"`), `#${id} has left the header`);
  }
  assert.ok(!header.includes('id="leaderboard-btn"'),
    'the trophy left the header (it is #drawer-row-leaderboard now)');
  assert.ok(!header.includes('id="admin-dashboard-btn"'),
    'the admin shield left the header (it is #drawer-row-admin now)');
});

test('#1436: the header is four controls, and only one of them is a menu', () => {
  // THE UI OVERHAUL collapsed four controls into #improve-btn. #1436 finishes
  // the job by giving the two INBOXES their own controls and retiring the
  // hamburger, so what is left answers four different questions:
  //
  //   the chip   — which app am I in?        (and where else can I go)
  //   messages   — my conversations
  //   the bell   — what happened while I was away
  //   Improve    — what can I do to this app
  //
  // Only Improve opens a list of choices. Everything else GOES somewhere,
  // which is the property the hamburger never had and the reason it is gone.
  const order = ['app-switcher-btn', 'messages-btn', 'notifications-btn', 'improve-btn'];
  let prev = -1;
  for (const id of order) {
    const at = header.indexOf(`id="${id}"`);
    assert.ok(at > -1, `#${id} is in the header`);
    assert.ok(at > prev, `#${id} comes after the previous header control`);
    prev = at;
  }
  // The chip is FIRST because it is on the left — identity and context on one
  // side, actions on the other.
  assert.ok(header.indexOf('id="app-switcher-btn"') < header.indexOf('id="improve-btn"'),
    'the chip leads the bar; the action controls trail it');

  // The retired ones must not creep back as a second way to do the same
  // thing — that split is exactly what the overhaul removed.
  for (const id of ['app-mode-switch', 'feedback-btn', 'work-drawer-btn',
    'dev-console-btn', 'header-menu-btn']) {
    assert.equal(header.indexOf(`id="${id}"`), -1,
      `#${id} was retired and must not return to the header`);
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

test('the version dot rides the Improve button, hidden by default', () => {
  // It was #header-menu-deploy-dot on the hamburger, from when the platform
  // version rows lived in that drawer's footer. THE UI OVERHAUL moved those
  // rows into the Improve panel, so the dot was pointing at something behind
  // a different control; it followed them, and was renamed with the move.
  const dot = html.match(/<span id="improve-version-dot"[^>]*>/);
  assert.ok(dot, '#improve-version-dot exists');
  assert.match(dot[0], /class="hidden /, 'ships hidden');
  assert.match(dot[0], /bg-amber-/, 'renders amber at rest, matching the deploying pill');
  assert.ok(!html.includes('id="header-menu-deploy-dot"'),
    'and the hamburger copy is gone, not duplicated');
  const btn = html.match(/<button id="improve-btn"[^>]*>/);
  assert.match(btn[0], /relative/, 'the button is a positioning context for it');
  // The badge that moved with it, and the one that stayed.
  const at = html.indexOf('id="improve-btn"');
  const end = html.indexOf('</button>', at);
  assert.ok(html.slice(at, end).includes('id="notifications-badge-ai"'),
    'the green session count sits on the Improve button, beside the sessions it counts');
  // #1436: the red unread badge went back to the BELL it was named for, which
  // is a control of its own again rather than a second reason to open the
  // hamburger. The two badges still read as one convention across two
  // controls — same corner, same geometry, only the colour differs.
  assert.match(header.match(/<button id="notifications-btn"[^>]*>[\s\S]*?<\/button>/)[0],
    /id="notifications-badge"/, "the bell carries its own red unread badge");
});

test('the deploy dot is derived from the rendered pills, not a duplicate flag', () => {
  // #1079 chunk B moved App.DrawerStatus into the React bundle, beside the
  // drawer markup it drives; app.js keeps a forwarder for its call sites.
  const headerMenuJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/header-menu-controller.js'), 'utf8');
  assert.match(headerMenuJs, /refreshDeployDot\(\)\s*\{/, 'DrawerStatus.refreshDeployDot is defined');
  const fn = headerMenuJs.slice(headerMenuJs.indexOf('  refreshDeployDot() {'));
  // Post-#913 the version rows signalled a rolling deploy with
  // .drawer-ver--deploying instead of the pill class; THE UI OVERHAUL moved
  // those rows from #drawer-footer to the Improve panel's footer, so the
  // scope moved with them — and now the dot has too.
  assert.match(fn.slice(0, 1400), /#improve-footer \.drawer-ver--deploying/,
    'reads the deploying state off the rendered pills — the single source of truth');
  // The second state the old single-colour dot could not show: the violet
  // "platform rolled past the SHA this tab loaded against" reload button.
  assert.match(fn.slice(0, 1400), /#improve-footer button\.drawer-ver--stale/,
    'and the stale state, which is the other thing those rows say');
  // It PUBLISHES: #improve-btn is React-owned, so an id lookup plus a
  // classList write would be a mismatch React patches straight back out.
  assert.match(fn.slice(0, 1400), /setVersionState/,
    'the dot is store state, not a class toggled by id');
  assert.ok(!/getElementById\('improve-version-dot'\)/.test(headerMenuJs),
    'nothing resolves the dot by id');
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

test('reference rows are plain divs — the pills carry their own anchors', () => {
  // renderPlatformVersionPill's stale state renders a <button
  // onclick="location.reload()">, and the live state an <a>. Nesting
  // those inside a clickable row would be invalid markup. The rule follows the
  // rows to the Improve panel and to Settings; #drawer-row-kudos is retired.
  for (const id of ['drawer-row-platform-version',
    'drawer-row-native-app-version', 'drawer-row-app-fork',
    'drawer-row-ai-budget']) {
    const row = html.match(new RegExp(`<(\\w+) id="${id}"`));
    assert.ok(row, `${id} exists`);
    assert.equal(row[1], 'div', `${id} is a <div>, never an <a>/<button>`);
  }
});

// ─── AI-credit row (#555) ────────────────────────────────────────────────

// Every signed-in user sees their own daily AI allowance. The row ships EMPTY
// because its audience isn't known until the me-scoped fetch answers.
//
// THE UI OVERHAUL moved it out of the drawer's status pane and into Settings →
// Anthropic API key: it is a figure you read while deciding whether to add a
// key, not something you act on from a navigation menu. Same module, same slot
// id — see tests/ai-credit-drawer.test.js for the rest of the wiring.
//
// A sibling admin-only "Anthropic credits" row shipped in the same pane
// and was removed again (it could only ever read "Not set up"); the
// balance lives solely in the console's Spend limits section now.

test('the AI-credit row lives in the Anthropic API key section', () => {
  const paneStart = html.indexOf('data-settings-section="api-key"');
  const id = 'drawer-row-ai-budget';
  const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
  assert.ok(html.indexOf(`id="${id}"`) > paneStart,
    `#${id} lives inside the Anthropic API key pane`);
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

// ─── One scroller, and it is the notification list ──────────────────────

test('#1436: the drawer is the switcher menu, and its rows always fit', () => {
  const scroller = html.match(/<div id="header-menu-rows"[^>]*>/);
  assert.ok(scroller, '#header-menu-rows exists');
  // The BODY does not scroll. It did, and the navigation rows below went with
  // it — off the bottom of a short viewport, behind a scroll nobody expects in
  // a menu.
  assert.ok(!/overflow-y-auto/.test(scroller[0]),
    'the drawer body itself must not scroll');
  assert.match(scroller[0], /min-h-0/,
    'min-h-0 is required for a flex child to bound its children rather than grow');

  // NOTIFICATIONS ARE NOT IN HERE ANY MORE. The rule that keeps this menu
  // from decaying back into the catch-all it used to be: a row that is
  // neither "where am I" nor "you" does not belong. An inbox is neither.
  assert.equal(html.indexOf('id="drawer-notifications"'), -1,
    'notifications left the drawer for their own sheet');
  assert.equal(html.indexOf('id="drawer-row-messages"'), -1,
    'and so did messages');

  // What is left is navigation plus the account group at the bottom.
  const at = html.indexOf('id="header-menu-rows"');
  for (const id of ['drawer-main-rows', 'drawer-row-profile', 'drawer-row-settings',
    'drawer-row-admin']) {
    assert.ok(html.indexOf(`id="${id}"`) > at, `#${id} is inside the drawer body`);
  }
  // Profile and Settings are the TERMINAL group — last, after the navigation.
  assert.ok(html.indexOf('id="drawer-row-profile"') < html.indexOf('id="drawer-row-settings"'),
    'Profile leads the account group');
});

// ─── The kudos badge no longer pokes at header layout ────────────────────

test('the kudos badge stopped driving the header title measurement', () => {
  assert.ok(!/HeaderLayout\?\.refresh/.test(kudosJs),
    'the badge left the header long ago — it cannot affect the centred title');
  // The renderer keeps its getElementById contract even though THE UI OVERHAUL
  // retired the drawer row it painted into: it no-ops on a missing slot, and
  // leaving the lookup intact is what lets the figure be re-homed later
  // without touching the module.
  assert.match(kudosJs, /getElementById\('kudos-budget-slot'\)/,
    'and still resolves its slot by the unchanged id');
});
