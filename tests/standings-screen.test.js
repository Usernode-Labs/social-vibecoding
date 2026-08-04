// Leaderboard screen — the Kudos leaderboard, the Topochain standings and
// the season's challenges merged behind one entry point with a three-tab
// strip. (Filename kept from when the screen was titled "Standings"; the
// screen and its drawer row read "Leaderboard" now.)
//
// The contract that's easy to break later:
//   - the screen opens on Kudos, so the merge can't quietly change what
//     the trophy/menu entry shows;
//   - every existing #leaderboard deep link (prs / users / history /
//     users/<name>) still resolves to a Kudos sub-tab;
//   - #leaderboard/topochain and #leaderboard/challenges are the canonical
//     addresses for the other two tabs, and the three legacy hashes
//     (#topochain/leaderboard, #topochain/seasons, #challenges) alias onto
//     them, so old bookmarks work;
//   - the three panes keep SEPARATE data state — routing Topochain
//     through Leaderboard._cache would break its event/page paging;
//   - the two Topochain-domain panes share ONE event selection, owned by
//     TopochainEventContext, so standings and challenges can never
//     describe different weeks.
//
// Static-assertion style (cf. tests/topochain-screens.test.js).
//
// Run with: node --test tests/standings-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const lbJs = fs.readFileSync(path.join(root, 'public/js/leaderboard.js'), 'utf8');
const topoJs = fs.readFileSync(path.join(root, 'public/js/topochain-leaderboard.js'), 'utf8');
const chJs = fs.readFileSync(path.join(root, 'public/js/topochain-challenges.js'), 'utf8');
const ctxJs = fs.readFileSync(path.join(root, 'public/js/topochain-event-context.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ─── Shell ───────────────────────────────────────────────────────────────

test('the Leaderboard screen hosts a tab strip, an event bar and all three panes', () => {
  const start = html.indexOf('<main id="leaderboard-screen"');
  const end = html.indexOf('</main>', start);
  assert.ok(start > -1, '#leaderboard-screen exists');
  const screen = html.slice(start, end);
  assert.ok(screen.includes('>Leaderboard<'), 'the screen is titled Leaderboard');
  assert.ok(screen.includes('id="standings-tabs"'), 'it carries the section tab strip');
  assert.ok(screen.includes('id="leaderboard-event-bar"'), 'it carries the shared event bar');
  assert.ok(screen.includes('id="leaderboard-root"'), 'it hosts the Kudos pane');
  assert.ok(screen.includes('id="topochain-leaderboard-root"'), 'it hosts the Topochain pane');
  assert.ok(screen.includes('id="challenges-root"'), 'it hosts the Challenges pane');
  // Wide enough for the Topochain table; the Kudos lists keep their
  // narrower reading column.
  assert.match(screen, /max-w-5xl/, 'the shell is the wider column');
  assert.match(screen, /id="leaderboard-root" class="max-w-3xl"/,
    'the Kudos pane keeps its reading width');
});

test('the retired screens are gone from the shell', () => {
  assert.ok(!html.includes('<main id="challenges-screen"'),
    '#challenges-screen was folded into the Leaderboard screen');
  assert.ok(!html.includes('<main id="topochain-seasons-screen"'),
    '#topochain-seasons-screen was folded into the Leaderboard screen');
});

test('only the Kudos pane ships visible — Kudos is the default section', () => {
  for (const id of ['topochain-leaderboard-root', 'challenges-root', 'leaderboard-event-bar']) {
    const el = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(el, `#${id} exists`);
    assert.match(el[0], /class="hidden/, `#${id} ships hidden`);
  }
});

// ─── Section state ───────────────────────────────────────────────────────

test('Leaderboard.section defaults to kudos', () => {
  assert.match(lbJs, /section: 'kudos',/, "the screen opens on the Kudos tab");
});

test('_setSection validates its input and syncs the hash', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _setSection(section) {'), lbJs.indexOf('  _applySection()'));
  assert.ok(fn.length > 0, '_setSection located');
  assert.match(fn, /if \(!Leaderboard\.SECTIONS\.includes\(section\)\) return;/,
    'garbage sections are a no-op, mirroring _setSub');
  assert.match(lbJs, /SECTIONS: \['kudos', 'topochain', 'challenges'\],/,
    'all three sections are declared in one place');
  assert.match(lbJs, /EVENT_SECTIONS: \['topochain', 'challenges'\],/,
    'the two event-scoped sections are declared in one place');
  assert.match(fn, /Leaderboard\._syncHash\(\);/, 'the hash follows the tab');
  assert.match(fn, /if \(!Leaderboard\._open\) return;/,
    'deep-link restore records state without rendering — open() does the first render');
});

test('_setSub still rejects garbage, and pins the section back to kudos', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _setSub(sub) {'), lbJs.indexOf('  openProfile(username)'));
  assert.ok(fn.length > 0, '_setSub located');
  assert.match(fn, /if \(sub !== 'prs' && sub !== 'users' && sub !== 'history'\) return;/,
    'only the three known Kudos sub-tabs are accepted');
  assert.match(fn, /Leaderboard\.section = 'kudos';/,
    "a Kudos sub-tab deep link must not land on a Topochain tab left over from earlier");
});

test('_syncHash emits the canonical topochain and challenges addresses', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _syncHash() {'), lbJs.indexOf('  _setWindow(win)'));
  assert.ok(fn.length > 0, '_syncHash located');
  assert.match(fn, /'#leaderboard\/topochain'/, 'the Topochain tab addresses as #leaderboard/topochain');
  assert.match(fn, /'#leaderboard\/challenges'/, 'the Challenges tab addresses as #leaderboard/challenges');
  assert.match(fn, /#leaderboard\/users\/\$\{encodeURIComponent/, 'the profile drill-in hash is unchanged');
  assert.match(fn, /location\.hash\.startsWith\('#leaderboard'\)/,
    'still guarded so it never hijacks an app route mid-navigation');
});

// ─── Router ──────────────────────────────────────────────────────────────

test('navigateToLeaderboard routes both section segments to the section', () => {
  const fn = appJs.slice(
    appJs.indexOf('  navigateToLeaderboard(sub, profileUser)'),
    appJs.indexOf('  _exitLeaderboard()')
  );
  assert.ok(fn.length > 0, 'navigateToLeaderboard located');
  assert.match(fn, /sub === 'topochain' \|\| sub === 'challenges'/,
    "both section segments select the section rather than falling through to _setSub");
  assert.match(fn, /App\.setHeaderTitle\('Leaderboard'\)/, 'the screen is titled Leaderboard');
  // openProfile must still win over both — _setSub/_setSection would
  // replaceState the profile hash away.
  assert.ok(
    fn.indexOf('Leaderboard.openProfile(profileUser)')
      < fn.indexOf('Leaderboard._setSection(sub)'),
    'the profile drill-in is checked first');
});

test('the legacy #topochain hashes self-heal to the canonical form', () => {
  const branch = appJs.slice(
    appJs.indexOf("if (parts[0] === 'topochain')"),
    appJs.indexOf("if (parts[0] === 'app' && parts[1])")
  );
  assert.match(branch, /parts\[1\] === 'seasons' \? 'challenges' : 'topochain'/,
    'seasons maps onto the challenges tab, everything else onto standings');
  assert.match(branch, /history\.replaceState\(null, '', `#leaderboard\/\$\{_tcSection\}`\)/,
    'the address is rewritten in place');
  assert.match(branch, /App\.navigateToLeaderboard\(_tcSection, null\)/, 'then hands off');
  assert.match(branch, /catch \(err\)/,
    'a replaceState failure must not swallow the navigation');
  // The rewrite must land BEFORE the navigate, or Leaderboard._syncHash
  // sees a non-#leaderboard hash and skips its own sync.
  assert.ok(branch.indexOf('history.replaceState') < branch.indexOf('App.navigateToLeaderboard'),
    'the rewrite happens before the navigate');
});

test('the legacy #challenges hash self-heals to the canonical form', () => {
  const branch = appJs.slice(
    appJs.indexOf("if (parts[0] === 'challenges')"),
    appJs.indexOf("if (parts[0] === 'profile')")
  );
  assert.ok(branch.length > 0, "the #challenges branch is still routed");
  assert.match(branch, /history\.replaceState\(null, '', '#leaderboard\/challenges'\)/,
    'the address is rewritten in place');
  assert.match(branch, /App\.navigateToLeaderboard\('challenges', null\)/, 'then hands off');
  assert.ok(branch.indexOf('history.replaceState') < branch.indexOf('App.navigateToLeaderboard'),
    'the rewrite happens before the navigate');
});

test('the retired navigate/exit pairs are gone from app.js', () => {
  // Strip comments: both names are still NAMED in the tombstone comments
  // that explain where they went, which is not a definition or a call.
  const code = appJs.replace(/\/\/[^\n]*/g, '');
  for (const name of ['navigateToChallenges', '_exitChallenges',
    'navigateToTopochainSeasons', '_exitTopochainSeasons',
    '_inChallenges', '_inTopochainSeasons']) {
    assert.ok(!code.includes(name), `${name} is gone — the screens are tabs now`);
  }
});

// ─── Pane lifecycle + data isolation ─────────────────────────────────────

test('each guest pane mounts lazily and tears down with the screen', () => {
  assert.match(lbJs, /_topoMounted: false,/, 'Topochain mount state is tracked');
  assert.match(lbJs, /_challengesMounted: false,/, 'Challenges mount state is tracked');
  assert.match(lbJs, /_eventBarMounted: false,/, 'event-bar mount state is tracked');
  const apply = lbJs.slice(lbJs.indexOf('  _applySection() {'), lbJs.indexOf('  _renderSectionTabs()'));
  assert.match(apply, /!Leaderboard\._topoMounted\s+&& window\.TopochainLeaderboard\?\.open/,
    'open() runs the first time the Topochain tab is shown, not on every visit');
  assert.match(apply, /!Leaderboard\._challengesMounted\s+&& window\.TopochainChallenges\?\.open/,
    'same for the Challenges tab');
  assert.match(apply, /!Leaderboard\._eventBarMounted\s+&& window\.TopochainEventContext\?\.open/,
    'the shared event bar mounts with whichever event tab is shown first');
  const close = lbJs.slice(lbJs.indexOf('  close() {'), lbJs.indexOf('  // ── Section'));
  assert.match(close, /TopochainLeaderboard\.close\(\)/,
    'leaving the screen closes the guest pane too, so in-flight fetches cannot paint into it');
  assert.match(close, /TopochainChallenges\.close\(\)/, 'and the challenges pane');
  assert.match(close, /TopochainEventContext\.close\(\)/, 'and the shared event bar');
});

test('the event bar is hidden on Kudos and shown on the two event tabs', () => {
  const apply = lbJs.slice(lbJs.indexOf('  _applySection() {'), lbJs.indexOf('  _renderSectionTabs()'));
  assert.match(apply, /EVENT_SECTIONS\.includes\(Leaderboard\.section\)/,
    'visibility is derived from the declared event sections');
  assert.match(apply, /bar\.classList\.toggle\('hidden', !onEventSection\)/,
    'Kudos has no event dimension, so the bar is hidden there');
});

test('the panes keep separate data state', () => {
  // Kudos events cannot change Topochain standings — refresh() must bail.
  const refresh = lbJs.slice(lbJs.indexOf('  refresh() {'), lbJs.indexOf('  invalidateHistory()'));
  assert.match(refresh, /if \(Leaderboard\.section !== 'kudos'\) return;/,
    'a kudos_update never re-fetches while a Topochain tab is active');
  // The Topochain modules own their own paging/event state. Strip
  // comments before asserting — the module headers say in words that they
  // stay out of the cache, which is not a usage.
  for (const [name, src] of [['standings', topoJs], ['challenges', chJs]]) {
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/Leaderboard\._cache/.test(code),
      `the ${name} module must not route through the Kudos cache`);
  }
  assert.match(topoJs, /_page: /, 'the standings pane keeps its own paging state');
});

// ─── Shared event selection ──────────────────────────────────────────────

test('one module owns the event list, the picker and the hero', () => {
  assert.match(ctxJs, /window\.TopochainEventContext = TopochainEventContext;/,
    'the module publishes onto the global');
  assert.match(ctxJs, /'\/api\/v4\/season-events\?include_past=1'/,
    'it owns the events fetch');
  assert.match(ctxJs, /TopochainEvents\.pickDefault\(data\.data\)/,
    'and the shared default pick');
  assert.match(ctxJs, /id="tc-ev-select"/, 'it renders the picker');
  assert.match(ctxJs, /id="tc-ev-hero"/, 'it renders the hero');
  assert.match(ctxJs, /onChange\(fn\)/, 'and exposes a subscription for the panes');
});

test('neither pane fetches or renders an event picker of its own any more', () => {
  for (const [name, src] of [['standings', topoJs], ['challenges', chJs]]) {
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!code.includes('/api/v4/season-events?include_past=1'),
      `the ${name} pane no longer fetches the events list itself`);
    assert.ok(!code.includes('tc-lb-event-select') && !code.includes('tc-se-event-select'),
      `the ${name} pane no longer renders its own <select>`);
    assert.match(src, /TopochainEventContext\.onChange/,
      `the ${name} pane subscribes to the shared selection`);
    assert.match(src, /_unsub\(\);/, `the ${name} pane unsubscribes on close`);
  }
});

test("a server-resolved event id is fed back silently", () => {
  // A server resolution is not a user choice: it must not clear the event
  // bar's "nothing is running" caption nor re-notify the panes into a loop.
  assert.match(topoJs, /TopochainEventContext\.select\(data\.data\.event\.id, \{ silent: true \}\)/,
    'the standings pane writes back with { silent: true }');
  const sel = ctxJs.slice(ctxJs.indexOf('  select(id, opts) {'), ctxJs.indexOf('  async _loadDetail()'));
  assert.match(sel, /if \(!\(opts && opts\.silent\)\) TopochainEventContext\._notify\(\);/,
    'and a silent write-back does not re-notify subscribers');
});

test('pull-to-refresh dispatches on the active section', () => {
  const fn = appJs.slice(appJs.indexOf('  _wirePullToRefresh() {'), appJs.indexOf('  bindEvents() {'));
  assert.match(fn, /Leaderboard\.section === 'topochain'/, 'the handler branches on the section');
  assert.match(fn, /TopochainLeaderboard\.loadLeaderboard\(\)/,
    'a pull on the Topochain tab reloads Topochain standings, not kudos panes');
  assert.match(fn, /Leaderboard\.section === 'challenges'/, 'and on the challenges section');
  assert.match(fn, /TopochainChallenges\.loadChallenges\(\)/,
    'a pull on the Challenges tab reloads the challenge grid');
});

// ─── Duplicate titles ────────────────────────────────────────────────────

test('no pane renders a heading of its own — the shell owns the title', () => {
  assert.ok(!/>Kudos leaderboard</.test(lbJs),
    'the Kudos pane dropped its own <h2>; the shell says Leaderboard and the tab says Kudos');
  assert.ok(!/>Topochain leaderboard</.test(topoJs),
    'the Topochain pane dropped its own <h1>');
  assert.ok(!/>Topochain seasons</.test(chJs),
    'the Challenges pane dropped its own <h1>');
});

// ─── Personalization (the old #challenges screen's one unique read) ──────

test('the challenges pane decorates the public grid with your own points', () => {
  assert.match(chJs, /\/challenges-api\/challenges\?season_event_id=/,
    'it fetches the session-scoped view');
  assert.match(chJs, /activities_total/, 'and reads your own per-challenge total');
  const load = chJs.slice(chJs.indexOf('  async _loadMine(eventId) {'), chJs.indexOf('  // ── Challenge grid'));
  assert.ok(!/_challengesError/.test(load),
    'a personalization failure never paints an error — the public grid stands');
  assert.match(chJs, /See where the season stands/,
    'the retired season-leaderboard block is replaced by a link to the standings tab');
  assert.match(chJs, /window\.location\.hash = '#leaderboard\/topochain'/,
    'and that link goes through the router, so the shared event selection survives');
});

test('the challenge-detail screenshot deep link is scoped to its one param', () => {
  const fn = chJs.slice(chJs.indexOf('  _maybeShot(ordered) {'), chJs.indexOf('  // ── Challenge detail overlay'));
  assert.ok(fn.length > 0, '_maybeShot located');
  assert.match(fn, /shot !== 'challenge-detail'/,
    "a real user's grid never auto-opens an overlay");
  assert.match(fn, /_shotFired/, 'and it fires at most once per page load');
});

// ─── dapp.json ───────────────────────────────────────────────────────────

test('dapp.json checks the canonical routes and every legacy alias', () => {
  const tests = manifest.tests || [];
  const canonical = tests.find((t) => t.path === '/#leaderboard');
  assert.ok(canonical, 'a check renders /#leaderboard');
  assert.match(canonical.expectSelector, /\[data-standings-tab="challenges"\]/,
    'and asserts the third tab is actually rendered');

  for (const p of ['/#topochain/leaderboard', '/#topochain/seasons', '/#challenges',
    '/#leaderboard/challenges']) {
    assert.ok(tests.some((t) => t.path === p), `a check exercises ${p}`);
  }

  const drawerRow = tests.find(
    (t) => typeof t.expectSelector === 'string' && t.expectSelector.includes('#drawer-row-leaderboard')
  );
  assert.ok(drawerRow, 'a check asserts the Leaderboard drawer row renders');

  const shot = tests.find((t) => t.path === '/?shot=challenge-detail#leaderboard/challenges');
  assert.ok(shot, 'a check exercises the challenge-detail screenshot state');
  assert.match(shot.expectSelector, /#tc-se-detail-overlay:not\(\.hidden\)/,
    'and asserts the overlay is actually open');

  const eventBar = tests.find(
    (t) => typeof t.expectSelector === 'string' && t.expectSelector.includes('#tc-ev-select')
  );
  assert.ok(eventBar, 'a check asserts the shared event picker renders');
});
