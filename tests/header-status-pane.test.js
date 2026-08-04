// Header slim-down: the fork label, the platform + app build pills, the
// kudos badge, the trophy and the admin shield all left the header for
// the slide-out drawer.
//
// The load-bearing property is that the four SLOTS kept their ids while
// changing parent — five renderers across app.js / app-view.js /
// kudos.js resolve them with getElementById, and one of them
// (renderAppVersionPillHTML) is shared with the home-screen cards. A
// well-meaning rename or a "tidy up the header" edit that re-adds a slot
// would break the pane silently, so all of it is pinned here.
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
const kudosJs = fs.readFileSync(path.join(root, 'public/js/kudos.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

const header = html.slice(0, html.indexOf('</header>'));
const MOVED_SLOTS = [
  'platform-version-pill-slot',
  'app-version-pill-slot',
  'app-fork-badge-slot',
  'kudos-budget-slot',
];

// ─── The slots moved, and kept their ids ─────────────────────────────────

test('each moved slot exists exactly once in its current drawer region', () => {
  const paneStart = html.indexOf('id="drawer-status-pane"');
  assert.ok(paneStart > -1, '#drawer-status-pane is missing from the shell');
  const paneEnd = html.indexOf('id="drawer-row-node"');
  assert.ok(paneEnd > paneStart, 'the status pane sits above the Node row');
  const footerStart = html.indexOf('id="drawer-footer"');
  assert.ok(footerStart > paneEnd, '#drawer-footer sits after the navigation rows');

  for (const id of MOVED_SLOTS) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
    const at = html.indexOf(`id="${id}"`);
    if (id === 'kudos-budget-slot') {
      assert.ok(at > paneStart && at < paneEnd,
        `#${id} lives inside #drawer-status-pane`);
    } else {
      assert.ok(at > footerStart,
        `#${id} lives inside #drawer-footer`);
    }
  }
});

test('none of the moved slots are left in the header', () => {
  for (const id of MOVED_SLOTS) {
    assert.ok(!header.includes(`id="${id}"`), `#${id} has left the header`);
  }
  assert.ok(!header.includes('id="leaderboard-btn"'),
    'the trophy left the header (it is #drawer-row-leaderboard now)');
  assert.ok(!header.includes('id="admin-dashboard-btn"'),
    'the admin shield left the header (it is #drawer-row-admin now)');
});

test('the header keeps navigation + alerting only, hamburger last', () => {
  const order = ['dev-console-btn', 'feedback-btn', 'work-drawer-btn',
    'notifications-btn', 'header-menu-btn'];
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
});

// ─── The deploy dot ──────────────────────────────────────────────────────

// ─── Badge geometry ──────────────────────────────────────────────────────

test("the cog's green badge sits exactly where the bell's red one does", () => {
  const cog = header.match(/<span id="notifications-badge-ai"[^>]*>/);
  const bell = header.match(/<span id="notifications-badge"[^>]*>/);
  assert.ok(cog, '#notifications-badge-ai is on the cog');
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
  assert.match(cog[0], /-top-1 -right-1/, 'the cog badge is top-right');
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
  assert.match(appJs, /refreshDeployDot\(\)\s*\{/, 'DrawerStatus.refreshDeployDot is defined');
  const fn = appJs.slice(appJs.indexOf('    refreshDeployDot() {'));
  assert.match(fn.slice(0, 600), /#drawer-footer \.drawer-ver--deploying/,
    'reads the deploying state off the rendered footer versions — the single source of truth');
  // Every renderer that can paint (or clear) a deploying pill must sync
  // the dot, or the hamburger keeps signalling a finished deploy.
  const calls = (appJs.match(/DrawerStatus\.refreshDeployDot\(\)/g) || []).length
    + (appViewJs.match(/DrawerStatus\.refreshDeployDot\(\)/g) || []).length;
  assert.ok(calls >= 4,
    `refreshDeployDot is called from each pill renderer (found ${calls}, expect >= 4)`);
});

// ─── App-scoped row lifecycle ────────────────────────────────────────────

test('the app build + fork rows ship hidden and follow the app lifecycle', () => {
  const appRow = html.match(/<div id="drawer-row-app-version"[^>]*>/);
  const forkRow = html.match(/<div id="drawer-row-app-fork"[^>]*>/);
  assert.ok(appRow, '#drawer-row-app-version exists');
  assert.ok(forkRow, '#drawer-row-app-fork exists');
  assert.match(appRow[0], /class="hidden /, 'the app build row ships hidden (no app open at boot)');
  assert.match(forkRow[0], /class="hidden /, 'the fork row ships hidden');

  // Hidden from every navigate* that leaves an app behind — one call per
  // site that also hides #drawer-row-share.
  const hides = (appJs.match(/DrawerStatus\.setAppOpen\(false\)/g) || []).length;
  const shareHides = (appJs.match(/if \(_drs\) _drs\.classList\.add\('hidden'\);/g) || []).length;
  assert.ok(hides > shareHides,
    'setAppOpen(false) runs everywhere the Share row is hidden, plus navigateHome');
  assert.match(appJs, /DrawerStatus\.setAppOpen\(true\)/, 'and is revealed when an app opens');
  assert.match(appViewJs, /DrawerStatus\.setAppOpen\(false\)/,
    'AppView.close() hides it too, so a closed app leaves no stale build line');
});

test('the fork row visibility is driven by renderForkBadge', () => {
  const fn = appViewJs.slice(
    appViewJs.indexOf('  renderForkBadge() {'),
    appViewJs.indexOf('  _forkSource:')
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
  for (const id of ['drawer-row-platform-version', 'drawer-row-app-version',
    'drawer-row-app-fork', 'drawer-row-kudos',
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
  assert.ok(!block.includes('#app-version-pill-slot'),
    'the app pill renders at every width now — it is in the drawer');
  // The home-card class slot still collapses: those pills DO crowd the
  // app name on a narrow card.
  assert.ok(block.includes('.app-version-pill-slot:not(:has(.app-version-pill--deploying))'),
    'the home-card pill slot still collapses on narrow viewports');
});

test('the drawer constrains a long pill so it cannot widen the 15rem panel', () => {
  assert.match(css, /\.drawer-ver \{[^}]*max-width:[^}]*text-overflow:\s*ellipsis/s,
    'footer versions are width-capped and truncate rather than overflowing');
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
