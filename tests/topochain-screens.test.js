// Public Topochain surfaces (Task 14) — the standings table and the
// seasons/events challenge grid, the two views the migration plan's Global
// Constraint #8 calls for. They shipped as two standalone SPA screens
// (#topochain/leaderboard and #topochain/seasons); the leaderboard merge
// made both TABS of the one Leaderboard screen, sharing a single event
// selection. Both legacy hashes still resolve, as aliases.
//
// Contract pinned here, mirroring tests/admin-console-page.test.js:
//  - the hash router has a `topochain` branch that aliases BOTH sub-routes
//    onto the Leaderboard screen's sections, rewriting the address first;
//  - all three module scripts are registered in index.html, before app.js;
//  - the two panes and the shared event bar live inside #leaderboard-screen
//    and ship hidden, and neither standalone <main> survives;
//  - the module objects (TopochainLeaderboard / TopochainChallenges /
//    TopochainEventContext) define the methods the brief calls for, and
//    escape interpolated values with the established esc() idiom;
//  - dapp.json carries a rendered-page check for every hash route, legacy
//    aliases included.
//
// Run with: node --test tests/topochain-screens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const leaderboardJs = fs.readFileSync(path.join(root, 'public/js/topochain-leaderboard.js'), 'utf8');
const challengesJs = fs.readFileSync(path.join(root, 'public/js/topochain-challenges.js'), 'utf8');
const contextJs = fs.readFileSync(path.join(root, 'public/js/topochain-event-context.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ─── index.html: script registration + screen hosts ─────────────────────

test('all three module scripts are registered in index.html, before app.js', () => {
  const lbTag = '<script src="/js/topochain-leaderboard.js"></script>';
  const chTag = '<script src="/js/topochain-challenges.js"></script>';
  const ctxTag = '<script src="/js/topochain-event-context.js"></script>';
  const evTag = '<script src="/js/topochain-events.js"></script>';
  for (const [tag, name] of [[lbTag, 'standings'], [chTag, 'challenges'],
    [ctxTag, 'event-context'], [evTag, 'events helper']]) {
    assert.ok(html.includes(tag), `the ${name} module is loaded by the shell`);
  }
  const appTagIdx = html.indexOf('<script src="/js/app.js"></script>');
  assert.ok(appTagIdx > html.indexOf(lbTag), 'standings script loads before app.js');
  assert.ok(appTagIdx > html.indexOf(chTag), 'challenges script loads before app.js');
  assert.ok(appTagIdx > html.indexOf(ctxTag), 'event-context script loads before app.js');
  // The context module feature-detects TopochainEvents at call time, but
  // keeping the shared rule first matches how every other pair is ordered.
  assert.ok(html.indexOf(evTag) < html.indexOf(ctxTag),
    'the shared pickDefault rule loads before the module that consumes it');
  // The retired per-screen module is gone from the shell entirely. Match
  // the <script> tag, not the bare path — the tombstone comment explaining
  // where the file went names it, which is not a registration.
  assert.ok(!html.includes('<script src="/js/challenges.js">'),
    'the retired challenges.js is no longer registered');
  assert.ok(!html.includes('<script src="/js/topochain-seasons.js">'),
    'topochain-seasons.js was renamed to topochain-challenges.js');
});

// Neither is a screen of its own any more: the standings pane, the
// challenges pane and the event bar they share all live INSIDE
// #leaderboard-screen.
test('both panes and the shared event bar live inside the Leaderboard screen', () => {
  assert.ok(!/<main id="topochain-leaderboard-screen"/.test(html),
    'the standalone #topochain-leaderboard-screen <main> is retired');
  assert.ok(!/<main id="topochain-seasons-screen"/.test(html),
    'the standalone #topochain-seasons-screen <main> is retired');
  assert.ok(!/<main id="challenges-screen"/.test(html),
    'the standalone #challenges-screen <main> is retired');

  const lbScreen = html.indexOf('<main id="leaderboard-screen"');
  const lbScreenEnd = html.indexOf('</main>', lbScreen);
  assert.ok(lbScreen > -1, 'index.html carries #leaderboard-screen (the host)');
  for (const id of ['topochain-leaderboard-root', 'challenges-root', 'leaderboard-event-bar']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > lbScreen && at < lbScreenEnd,
      `#${id} is rendered inside the Leaderboard screen`);
  }
  assert.ok(html.includes('id="standings-tabs"'), 'the screen carries the section tab strip');
});

test('one drawer row reaches all three surfaces', () => {
  // The separate Topochain-leaderboard, Challenges and Topochain-seasons
  // rows are all gone: Leaderboard is the single entry point now.
  for (const id of ['drawer-row-topochain-leaderboard', 'drawer-row-challenges',
    'drawer-row-topochain-seasons', 'drawer-row-standings']) {
    assert.ok(!new RegExp(`id="${id}"`).test(html),
      `the separate ${id} row is retired`);
  }
  assert.match(html, /<a id="drawer-row-leaderboard" href="#leaderboard"/,
    'a real anchor links to #leaderboard, like the Profile drawer row');
});

// ─── app.js: router branch + state discipline ────────────────────────────

test('the hash router aliases both #topochain sub-routes onto the sections', () => {
  assert.match(appJs, /parts\[0\] === 'topochain'/, 'restoreFromHash has a topochain branch');
  const branch = appJs.slice(
    appJs.indexOf("if (parts[0] === 'topochain')"),
    appJs.indexOf("if (parts[0] === 'app' && parts[1])")
  );
  assert.ok(branch.length > 0, 'the topochain router branch is located');
  assert.match(branch, /parts\[1\] === 'seasons' \? 'challenges' : 'topochain'/,
    'seasons maps onto the challenges tab, everything else onto standings');
  // Canonical form per section: the standings are the screen's PRIMARY tab,
  // so their address is the bare #leaderboard (rewriting to
  // #leaderboard/topochain here would only make Leaderboard._syncHash
  // rewrite it a second time).
  assert.match(branch, /_tcSection === 'challenges' \? '#leaderboard\/challenges' : '#leaderboard'/,
    'the legacy hash is rewritten to its canonical form');
  assert.match(branch, /App\.navigateToLeaderboard\(_tcSection, null\)/,
    'then dispatches to the Leaderboard screen on that section');
  assert.ok(branch.indexOf('replaceState') < branch.indexOf('navigateToLeaderboard'),
    'the rewrite happens BEFORE the navigate, so Leaderboard._syncHash sees a #leaderboard hash');
});

test('the Leaderboard screen carries no isAdmin gate', () => {
  // Anchored on the name, not the full parameter list — the signature grew a
  // third argument for the #982 challenge deep link and will grow again.
  const lbFn = appJs.slice(
    appJs.indexOf('  navigateToLeaderboard(sub, profileUser'),
    appJs.indexOf('  _exitLeaderboard()')
  );
  assert.ok(lbFn.length > 0, 'navigateToLeaderboard exists in app.js');
  assert.ok(!/isAdmin/.test(lbFn),
    'every pane on it is a public read — no isAdmin check');
});

test('every full-screen exit path also exits the Leaderboard screen', () => {
  const lbExits = appJs.match(/if \(App\._inLeaderboard\) App\._exitLeaderboard\(\);/g) || [];
  // Sibling sites: the app/else branches of restoreFromHash,
  // navigateToProfile, navigateToAdminConsole, navigateToSettings,
  // navigateToApp, navigateHome — mirrors the >= 5 admin-console bar. One
  // fewer than before the merge, because navigateToChallenges and
  // navigateToTopochainSeasons are gone.
  assert.ok(lbExits.length >= 5,
    `_exitLeaderboard is called from the sibling navigate/exit sites (found ${lbExits.length}, expect >= 5)`);
  assert.match(appJs, /else if \(App\._inLeaderboard\) App\.navigateHome\(\);/,
    'the empty-hash branch sends an open Leaderboard screen home');
});

test('the three folded-in surfaces have no screen state of their own', () => {
  assert.match(appJs, /_inLeaderboard: false,/, 'the Leaderboard flag is declared alongside its siblings');
  // One flag covers all three panes. A reintroduced flag would mean a tab
  // had drifted back into being a screen.
  const code = appJs.replace(/\/\/[^\n]*/g, '');
  for (const flag of ['_inTopochainLeaderboard', '_inTopochainSeasons', '_inChallenges']) {
    assert.ok(!code.includes(flag),
      `no ${flag} flag — the pane is a tab, not a screen`);
  }
  for (const fn of ['_exitTopochainLeaderboard', '_exitTopochainSeasons', '_exitChallenges']) {
    assert.ok(!code.includes(fn),
      `no ${fn} — _exitLeaderboard tears down all three panes`);
  }
});

// ─── Module objects: methods + esc() usage ───────────────────────────────

test('TopochainLeaderboard defines the expected surface', () => {
  assert.match(leaderboardJs, /const TopochainLeaderboard = \{/, 'the global object literal is defined');
  assert.match(leaderboardJs, /window\.TopochainLeaderboard = TopochainLeaderboard;/, 'mirrored onto window');
  for (const member of [
    'open()', 'close()', 'esc(', 'fetchJson(', '_eventId()', 'loadLeaderboard()',
    '_renderShell()', '_renderBody()', '_openDrill(', '_renderDrill()',
  ]) {
    assert.ok(leaderboardJs.includes(member), `TopochainLeaderboard defines ${member}`);
  }
  // loadEvents moved to the shared context module. Strip comments: the
  // prose explaining where it went is not a definition or a call.
  assert.ok(!leaderboardJs.replace(/\/\/[^\n]*/g, '').includes('loadEvents()'),
    'the standings pane no longer loads the event list itself');
});

test('TopochainChallenges defines the expected surface', () => {
  assert.match(challengesJs, /const TopochainChallenges = \{/, 'the global object literal is defined');
  assert.match(challengesJs, /window\.TopochainChallenges = TopochainChallenges;/, 'mirrored onto window');
  for (const member of [
    'open()', 'close()', 'esc(', 'fetchJson(', '_eventId()', 'loadChallenges()',
    '_renderGrid()', 'openChallengeDetail(', 'closeChallengeDetail()',
    'openUserProfile(', 'closeUserProfile()',
  ]) {
    assert.ok(challengesJs.includes(member), `TopochainChallenges defines ${member}`);
  }
  // The hero and the event list moved to the shared context module.
  assert.ok(!challengesJs.includes('_renderHero()'),
    'the challenges pane no longer renders an event hero of its own');
  // Same comment-stripping as the standings pane above: the subscriber in
  // open() explains itself by naming the context module's initial
  // loadEvents(), and prose about another module's method is not a call.
  assert.ok(!challengesJs.replace(/\/\/[^\n]*/g, '').includes('loadEvents()'),
    'the challenges pane no longer loads the event list itself');
});

test('TopochainEventContext defines the expected surface', () => {
  assert.match(contextJs, /const TopochainEventContext = \{/, 'the global object literal is defined');
  assert.match(contextJs, /window\.TopochainEventContext = TopochainEventContext;/, 'mirrored onto window');
  for (const member of [
    'open()', 'close()', 'esc(', 'fetchJson(', 'onChange(fn)', 'loadEvents()',
    'select(id, opts)', '_renderShell()', '_renderOptions()', '_renderHero()',
  ]) {
    assert.ok(contextJs.includes(member), `TopochainEventContext defines ${member}`);
  }
  // An unsubscribe handle is what keeps a torn-down pane from being woken
  // by a later event change.
  assert.match(contextJs, /return \(\) => \{/, 'onChange returns an unsubscribe function');
});

test('all three modules fetch from the /api/v4 endpoints the brief specifies', () => {
  assert.match(contextJs, /\/api\/v4\/season-events\?include_past=1/, 'the event bar loads the picker list');
  assert.match(contextJs, /\/api\/v4\/season-events\/\$\{encodeURIComponent\(eventId\)\}`/, 'hero loads the event detail');

  assert.match(leaderboardJs, /\/api\/v4\/leaderboard\?/, 'standings pane loads the paginated table');
  assert.match(leaderboardJs, /\/api\/v4\/leaderboard\/user-activities\?/, 'drill-down loads activities');
  assert.match(leaderboardJs, /\/api\/v4\/leaderboard\/epoch-breakdown\?/, 'drill-down loads the epoch breakdown by wallet');
  assert.match(leaderboardJs, /\/api\/v4\/users\/.*\/profile/, 'drill-down can load a profile');

  assert.match(challengesJs, /\/api\/v4\/season-events\/.*\/challenges`/, 'grid loads challenges');
  assert.match(challengesJs, /\/challenges\/\$\{encodeURIComponent\(challenge\.id\)\}\/breakdown/, 'detail overlay loads the challenge breakdown');
  assert.match(challengesJs, /\/api\/v4\/users\/\$\{encodeURIComponent\(userId\)\}\/profile/, 'profile overlay loads /users/:id/profile');
  // The one non-/api/v4 read: the session-scoped decoration layer.
  assert.match(challengesJs, /\/challenges-api\/challenges\?season_event_id=/,
    'the grid decorates with the viewer\'s own points from the session-authed route');
});

test('display_leaderboard=false and API errors are handled without throwing', () => {
  assert.match(leaderboardJs, /display_leaderboard/, 'the standings pane reads display_leaderboard off the event payload');
  assert.match(leaderboardJs, /_error/, 'a dedicated error state renders instead of a blank/broken screen');
  assert.match(challengesJs, /_challengesError/, 'the challenges pane carries dedicated error state for its grid fetch');
  assert.match(contextJs, /_detailError/, 'the event bar carries dedicated error state for its hero fetch');
});

// ─── esc() discipline — every interpolated API value must pass through it ─

test('every module escapes interpolated values with the established esc() idiom', () => {
  for (const src of [leaderboardJs, challengesJs, contextJs]) {
    assert.match(src, /esc\(s\) \{\s*\n\s*return String\(s == null \? '' : s\)/,
      'esc() mirrors the admin-console.js helper shape');
  }
  // Spot-check: a sampling of API-sourced fields actually gets passed
  // through esc(...) rather than interpolated raw into template literals.
  for (const field of ['r.display_name', 'r.total_points', 'row.wallet_address']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(leaderboardJs),
      `${field} passes through esc() in topochain-leaderboard.js`);
  }
  for (const field of ['cp.goal', 'p.display_name', 'e.display_name']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(challengesJs),
      `${field} passes through esc() in topochain-challenges.js`);
  }
  for (const field of ['ev.name', 'ev.description', 'ev.users_count']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(contextJs),
      `${field} passes through esc() in topochain-event-context.js`);
  }
});

test('esc() escapes quotes too, not just & < >', () => {
  // Attribute-value breakout (`<option value="` / `data-*="`, ...) needs
  // both quote characters escaped, not just the text-node-unsafe three —
  // stopping-XSS review, task 14 fix.
  for (const src of [leaderboardJs, challengesJs, contextJs]) {
    const fn = src.slice(src.indexOf('esc(s) {'), src.indexOf('esc(s) {') + 300);
    assert.match(fn, /\.replace\(\/"\/g, '&quot;'\)/, 'esc() escapes double quotes');
    assert.match(fn, /\.replace\(\/'\/g, '&#39;'\)/, 'esc() escapes single quotes');
  }
});

test('the challenge CTA link is scheme-guarded before it ever reaches an href', () => {
  // stopping-XSS review, task 14 fix: a `javascript:` (or any non-http[s])
  // cta_link must never become a clickable anchor — only escaping the
  // string is not enough, the scheme itself must be validated.
  const safeHrefFn = challengesJs.slice(challengesJs.indexOf('safeHref(url) {'), challengesJs.indexOf('async fetchJson(url) {'));
  assert.ok(safeHrefFn.length > 0, 'safeHref located');
  assert.ok(safeHrefFn.includes('/^https?:\\/\\//i.test(url)'),
    'safeHref validates the URL scheme with an http(s)-only regex');
  const ctaFn = challengesJs.slice(challengesJs.indexOf('_ctaHtml(dm) {'), challengesJs.indexOf('_renderDetailOverlay() {'));
  assert.ok(ctaFn.length > 0, '_ctaHtml located');
  assert.match(ctaFn, /TopochainChallenges\.safeHref\(dm\.cta_link\)/,
    'the cta_link is run through safeHref before being used as an href');
  assert.match(ctaFn, /if \(!href\)/,
    'a link that fails the scheme check never reaches an <a href>');
  // The only href in any of the three files is this one, scheme-guarded —
  // assert there is no OTHER raw href="${...}" interpolation anywhere that
  // bypasses safeHref.
  const hrefSites = (challengesJs.match(/href="\$\{/g) || []).length
    + (leaderboardJs.match(/href="\$\{/g) || []).length
    + (contextJs.match(/href="\$\{/g) || []).length;
  assert.equal(hrefSites, 1, 'exactly one interpolated href exists across the three files — the safeHref-guarded cta_link');
});

// ─── dapp.json ────────────────────────────────────────────────────────────

test('dapp.json locks every rendered route in with checks', () => {
  const tests = manifest.tests || [];
  // The legacy hashes are still checked — they're the alias paths, and a
  // check on each is what proves old bookmarks keep working.
  const lb = tests.find((t) => t.path === '/#topochain/leaderboard');
  assert.ok(lb, 'a dapp.json test renders the legacy /#topochain/leaderboard alias');
  assert.match(lb.expectSelector, /#leaderboard-screen:not\(\.hidden\)/,
    'asserts the Leaderboard screen is actually revealed, not just present');
  assert.match(lb.expectSelector, /#topochain-leaderboard-root:not\(\.hidden\)/,
    'and that the alias lands on the Topochain pane, not the Kudos one');

  const canonical = tests.find((t) => t.path === '/#leaderboard');
  assert.ok(canonical, 'a dapp.json test renders the canonical /#leaderboard');
  assert.match(canonical.expectSelector, /\[data-standings-tab="challenges"\]/,
    'asserts all three section tabs render');

  for (const p of ['/#topochain/seasons', '/#challenges', '/#leaderboard/challenges']) {
    const t = tests.find((x) => x.path === p);
    assert.ok(t, `a dapp.json test renders ${p}`);
    assert.match(t.expectSelector, /#challenges-root:not\(\.hidden\)/,
      `${p} asserts the Challenges pane is actually revealed, not just present`);
  }
});
