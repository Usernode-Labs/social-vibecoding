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
const leaderboardJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-leaderboard.js'), 'utf8');
const challengesJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
const contextJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-event-context.js'), 'utf8');
const { renderComponent } = require('./lib/render-tsx');
const island = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/index.tsx'), 'utf8');
const mount = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/mount.ts'), 'utf8');
const standingsTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-standings.tsx'), 'utf8');
const challengesPaneTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/challenges-pane.tsx'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ─── index.html: script registration + screen hosts ─────────────────────

// #1083 chunk F moved all three modules into the React bundle with the screen
// that hosts them, so "registered in index.html before app.js" became "imported
// by the island, and deferred past app.js by the entry's type=module". Both
// halves are asserted: the tags must be GONE (two copies of a module racing to
// publish the same global is the failure this catches) and the island must
// actually import each one.
test('all three modules arrive with the leaderboard island, and the shared rule still loads first', () => {
  for (const src of ['/js/topochain-leaderboard.js', '/js/topochain-challenges.js',
    '/js/topochain-event-context.js']) {
    assert.ok(!html.includes(`<script src="${src}">`),
      `${src} is in the bundle now — a classic tag would load it twice`);
  }
  assert.ok(island.includes("import './topochain-event-context.js';"),
    'the island must import the shared event bar, or nothing publishes its global');
  // The two PANE modules arrive one hop further out — the standings module as
  // of #1191 slice 6 conversion 5, the challenges module as of conversion 7.
  // ./mount imports each one AND plants the store its render methods push
  // into, so importing either directly here would publish the global without
  // the store and leave that pane permanently blank.
  assert.ok(island.includes("import './mount';"),
    'the island must import ./mount, which is what loads the two pane modules');
  for (const [spec, plant] of [
    ["import './topochain-leaderboard.js';", /TopochainLeaderboard\._store = topochainStandingsStore/],
    ["import './topochain-challenges.js';", /TopochainChallenges\._store = topochainChallengesStore/],
  ]) {
    assert.ok(mount.includes(spec),
      `./mount must still ${spec.trim()} or nothing publishes its global`);
    assert.match(mount, plant,
      'and plant its store — the render methods are no-ops without it');
  }
  // The shared pickDefault rule is still a classic script: it has no DOM of its
  // own, so chunk F had no region to move it with.
  const evTag = '<script src="/js/topochain-events.js"></script>';
  assert.ok(html.includes(evTag), 'the events helper is loaded by the shell');
  // ...and the bundle is deferred past it, which is what "loads first" means
  // now. The entry sits in <head>, so `type="module"` is the whole guarantee.
  const entry = html.match(/<script([^>]*)src="\/shell\/assets\/shell\.js"([^>]*)>/);
  assert.ok(entry, 'the shell loads the React bundle');
  assert.match(entry[0], /type="module"/,
    'the entry must stay type=module: that is what defers the three modules past '
    + 'the classic topochain-events.js they read window.TopochainEvents from');
  // app.js is still classic and still reaches all three by name, from a hash
  // route restored after DOMContentLoaded — i.e. after the deferred bundle.
  assert.ok(html.includes('<script src="/js/app.js"></script>'),
    'app.js is still a classic script');
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

test('one entry point reaches all three surfaces', () => {
  // The separate Topochain-leaderboard, Challenges and Topochain-seasons
  // rows are all gone: Leaderboard is the single entry point now.
  for (const id of ['drawer-row-topochain-leaderboard', 'drawer-row-challenges',
    'drawer-row-topochain-seasons', 'drawer-row-standings']) {
    assert.ok(!new RegExp(`id="${id}"`).test(html),
      `the separate ${id} row is retired`);
  }
  // …and so is #drawer-row-leaderboard, the hamburger row that replaced them.
  // THE UI OVERHAUL moved the entry point to the HOME SCREEN, into the
  // Challenges area — beside the shared progress it links to, rather than in
  // a menu you have to open from memory. The area's title bar carries the
  // link and its standings preview carries per-row ones; both go through
  // HomePanels.goToLeaderboard, which is the one owner of the hash.
  assert.ok(!/id="drawer-row-leaderboard"/.test(html),
    'the hamburger row is retired with everything else that was not navigation');
  assert.match(html, /<section id="home-challenges-section"/,
    'the Challenges area is in the shell, above the fold of the home screen');
  const panels = fs.readFileSync(
    path.join(root, 'frontend/src/features/home/home-panels.js'), 'utf8');
  // The bar's link is drawn by the React block (#1191); home-panels.js keeps
  // the destination, which is the half that owns the hash.
  const ui = fs.readFileSync(
    path.join(root, 'frontend/src/features/home/panels/ui.tsx'), 'utf8');
  assert.match(ui, /className="home-panel-lb-browse[^"]*"[\s\S]*?aria-label="Open leaderboard"/,
    'the area\u2019s title bar carries the link');
  assert.match(panels, /goToLeaderboard\(kind\) \{[\s\S]*?location\.hash = kind === 'kudos' \? '#leaderboard\/users' : '#leaderboard'/,
    'and it is a real hash navigation, so the device back gesture returns home');
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
  // `esc(` became `str(` in #1191 slice 6 conversion 5 — the module returns
  // descriptors and React does the escaping, but the null→'' coercion is still
  // load-bearing (React prints String(null) as the word "null"). The two view
  // builders are named here so the split between "decides" and "renders"
  // cannot quietly collapse back.
  for (const member of [
    'open()', 'close()', 'str(', 'fetchJson(', '_eventId()', 'loadLeaderboard()',
    '_renderShell()', '_renderBody()', 'bodyView()', '_openDrill(',
    '_renderDrill()', 'drillView()',
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
  // `esc(` became `str(` in #1191 slice 6 conversion 7, for the same reason it
  // did in the standings module two conversions earlier: this file returns
  // descriptors and ./challenges-pane.tsx renders them. The four view builders
  // are named here so the split between "decides" and "renders" cannot quietly
  // collapse back.
  for (const member of [
    'open()', 'close()', 'str(', 'fetchJson(', '_eventId()', 'loadChallenges()',
    '_renderGrid()', 'gridView(', 'cardView(', 'openChallengeDetail(',
    'closeChallengeDetail()', '_renderDetailOverlay()', 'detailView()',
    'openUserProfile(', 'closeUserProfile()', '_renderProfileOverlay()',
    'profileView()',
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

// The list this iterated is EMPTY now, and the rule it enforced has changed
// hands rather than lapsed.
//
// Admin-authored copy — an event's name and its description — lands in both a
// text node and a double-quoted attribute value on this screen, so & < > alone
// was never enough: an unescaped `"` would break out of an attribute and
// inject one. Each Topochain module carried its own `esc()` for that. #1191
// slice 6 took the innerHTML away from the standings and challenges panes, and
// this run took it from the event bar — the last of the three — so escaping is
// React's, by construction, and an `esc()` anywhere here would double-encode.
//
// So the check is on the OUTPUT, against copy chosen to break every context at
// once, rather than on the presence of a helper.
test('admin-authored copy is escaped in text AND attribute contexts', () => {
  const hostile = 'Break "out" of <it> & \'quote\'';
  const html = renderComponent(
    'frontend/src/features/leaderboard/event-bar.tsx', 'EventBarView',
    {
      mounted: true,
      options: [{ id: 7, label: `${hostile} (current)` }],
      placeholder: null,
      selectedId: 7,
      hero: {
        kind: 'event',
        name: hostile,
        statusLabel: 'active now',
        statusClass: 'bg-green-500/20 text-green-600 dark:text-green-300',
        description: hostile,
        dates: 'Jan 1, 2026 – Mar 1, 2026',
        participants: ' · 12 taking part',
        seasonNote: false,
        fallbackNote: false,
      },
    },
  );
  // Nothing broke out: the copy never appears with its quotes raw, anywhere.
  assert.ok(!html.includes('"out"'), 'a raw quoted run would mean an unescaped attribute');
  assert.ok(!html.includes('<it>'), 'and a raw tag would mean an unescaped text node');
  assert.match(html, /&quot;out&quot;/, 'double quotes are entities');
  assert.match(html, /&lt;it&gt;/, 'angle brackets too');
  assert.match(html, /&amp;/);
  assert.match(html, /&#x27;quote&#x27;/, 'and the apostrophe');
  // Both places it lands: the hero's heading (a text node) and the picker's
  // option label (also a text node, but inside a control whose value is an
  // attribute — the shape the old esc() had to cover twice).
  assert.match(html, /<h2[^>]*>Break &quot;out&quot;/);
  assert.match(html, /<option value="7"[^>]*>Break &quot;out&quot;/);
  // And no module on this screen carries an esc() any more, which is what
  // stops one drifting back in beside React's.
  for (const src of [contextJs]) {
    assert.doesNotMatch(src, /^\s*esc\(s\) \{/m, 'no hand-rolled escaper is left');
  }
});

// The standings pane's replacement for the two tests above. It has no escaping
// discipline to keep because it has no HTML: the safety property is now
// "produces no markup at all", which is a stronger statement than "escapes
// correctly" and is what the island rule requires of a React-owned host.
test('the standings module builds descriptors, not HTML — so there is nothing to escape', () => {
  const code = leaderboardJs.replace(/\/\/[^\n]*/g, '');
  assert.ok(!code.includes('innerHTML'),
    'the pane writes no markup; ./topochain-standings.tsx owns the subtree');
  assert.ok(!code.includes('getElementById'),
    'and reaches into no node below its React-owned root');
  assert.ok(!/\besc\(/.test(code),
    'the escaping helper is gone with the strings it served — an esc() call '
    + 'surviving into a descriptor would double-encode in the renderer');
  // The coercion that outlived it, and why: React renders String(null) as the
  // four-character word "null", so a nullable API field still has to land as ''.
  assert.match(leaderboardJs, /str\(s\) \{\s*\n\s*return String\(s == null \? '' : s\)/,
    'str() keeps esc()\'s null→empty coercion');
  for (const field of ['r.display_name', 'r.total_points', 'row.wallet_address']) {
    assert.ok(new RegExp(`str\\(${field.replace('.', '\\.')}`).test(leaderboardJs),
      `${field} passes through str() in topochain-leaderboard.js`);
  }
  // And the renderer must not reintroduce raw HTML by the back door.
  assert.ok(!standingsTsx.includes('dangerouslySetInnerHTML'),
    'the pane component renders text nodes, never raw HTML');
});

// (The companion "esc() escapes quotes too, not just & < >" test is folded
// into the one above: the attribute-breakout case — stopping-XSS review, task
// 14 — is now checked on the rendered `<option value="…">` rather than on the
// helper's replace chain, because there is no helper left to read.)

// The challenges pane's replacement for the two tests above, and the same
// statement the standings pane's makes: it has no escaping discipline to keep
// because it has no HTML. What it does still keep is safeHref, which is the
// one guard React does not make redundant.
test('the challenges module builds descriptors, not HTML — so there is nothing to escape', () => {
  const code = challengesJs.replace(/\/\/[^\n]*/g, '');
  assert.ok(!code.includes('innerHTML'),
    'the pane writes no markup; ./challenges-pane.tsx owns the subtree');
  assert.ok(!code.includes('getElementById'),
    'and reaches into no node below its React-owned root');
  assert.ok(!/\besc\(/.test(code),
    'the escaping helper is gone with the strings it served — an esc() call '
    + 'surviving into a descriptor would double-encode in the renderer');
  assert.match(challengesJs, /str\(s\) \{\s*\n\s*return String\(s == null \? '' : s\)/,
    'str() keeps esc()\'s null→empty coercion');
  for (const field of ['cp.goal', 'p.display_name', 'e.display_name']) {
    assert.ok(new RegExp(`str\\(${field.replace('.', '\\.')}`).test(challengesJs),
      `${field} passes through str() in topochain-challenges.js`);
  }
  assert.ok(!challengesPaneTsx.includes('dangerouslySetInnerHTML'),
    'the pane component renders text nodes, never raw HTML');
});

test('the challenge CTA link is scheme-guarded before it ever reaches an href', () => {
  // stopping-XSS review, task 14 fix: a `javascript:` (or any non-http[s])
  // cta_link must never become a clickable anchor. Rendering through a
  // component stops attribute breakout for free — it does NOT validate a
  // scheme, so this guard outlived the escaping helper next to it.
  const safeHrefFn = challengesJs.slice(challengesJs.indexOf('safeHref(url) {'), challengesJs.indexOf('async fetchJson(url) {'));
  assert.ok(safeHrefFn.length > 0, 'safeHref located');
  assert.ok(safeHrefFn.includes('/^https?:\\/\\//i.test(url)'),
    'safeHref validates the URL scheme with an http(s)-only regex');
  const ctaFn = challengesJs.slice(challengesJs.indexOf('ctaView(dm) {'), challengesJs.indexOf('_renderDetailOverlay() {'));
  assert.ok(ctaFn.length > 0, 'ctaView located');
  assert.match(ctaFn, /TopochainChallenges\.safeHref\(dm\.cta_link\)/,
    'the cta_link is run through safeHref before being used as an href');
  assert.match(ctaFn, /if \(!href\) return \{ kind: 'text', label \};/,
    'a link that fails the scheme check becomes a different descriptor kind, '
    + 'with no href field at all for the renderer to reach for');
  // The decision must stay in the shaping module. #1191 slice 6 conversion 7
  // moved the <a> into ./challenges-pane.tsx, and the way that stays safe is
  // that the component has exactly ONE href and it is the descriptor's — no
  // second site, and no fallback branch that reconstitutes a rejected link.
  const hrefProps = (challengesPaneTsx.match(/href=\{/g) || []).length;
  assert.equal(hrefProps, 1,
    'exactly one href in the challenges pane component — the safeHref-guarded cta_link');
  assert.match(challengesPaneTsx, /href=\{view\.href\}/,
    'and it reads the descriptor field, not the raw API value');
  // No template-literal href survives in any of the three modules either.
  const hrefSites = (challengesJs.match(/href="\$\{/g) || []).length
    + (leaderboardJs.match(/href="\$\{/g) || []).length
    + (contextJs.match(/href="\$\{/g) || []).length;
  assert.equal(hrefSites, 0,
    'no interpolated href is left across the three modules — the one that '
    + 'remains is a React prop fed by safeHref');
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
