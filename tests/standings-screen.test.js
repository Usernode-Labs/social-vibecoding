// Leaderboard screen — the Kudos leaderboard, the Topochain standings and
// the season's challenges merged behind one entry point with a three-tab
// strip. (Filename kept from when the screen was titled "Standings"; the
// screen and its drawer row read "Leaderboard" now.)
//
// The contract that's easy to break later:
//   - the screen opens on the TOPOCHAIN STANDINGS, which the tab strip
//     labels simply "Leaderboard" — it is the platform's primary ranking,
//     and the trophy/menu entry, the bare #leaderboard hash and the home
//     widget's fill must all agree on that;
//   - the kudos board is still all there, one tab over, named "Kudos";
//   - every existing #leaderboard/<sub> deep link (prs / users / history /
//     users/<name>) still resolves to a Kudos sub-tab;
//   - the bare #leaderboard and #leaderboard/challenges are the canonical
//     addresses for the standings and challenges tabs, and the legacy
//     hashes (#leaderboard/topochain, #topochain/leaderboard,
//     #topochain/seasons, #challenges) alias onto them, so old bookmarks
//     work;
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
const lbJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/leaderboard.js'), 'utf8');
const island = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/index.tsx'), 'utf8');
const topoJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-leaderboard.js'), 'utf8');
// #1191 slice 6 conversion 5: the pane's markup lives here now — the module
// above returns descriptors. Assertions about what the pane RENDERS moved with
// it; assertions about what it DECIDES stayed above.
const standingsTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-standings.tsx'), 'utf8');
const chJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
const ctxJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-event-context.js'), 'utf8');
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
  assert.match(screen, /id="leaderboard-root" class="hidden max-w-3xl"/,
    'the Kudos pane keeps its reading width (and now ships hidden — see below)');
});

test('the retired screens are gone from the shell', () => {
  assert.ok(!html.includes('<main id="challenges-screen"'),
    '#challenges-screen was folded into the Leaderboard screen');
  assert.ok(!html.includes('<main id="topochain-seasons-screen"'),
    '#topochain-seasons-screen was folded into the Leaderboard screen');
});

test('the standings pane + event bar ship visible — standings are the default section', () => {
  // The DEFAULT pane and the event bar it reads from must ship visible, or
  // the screen paints the Kudos pane for a frame before _applySection runs.
  for (const id of ['topochain-leaderboard-root', 'leaderboard-event-bar']) {
    const el = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(el, `#${id} exists`);
    assert.doesNotMatch(el[0], /class="hidden/, `#${id} ships visible`);
  }
  for (const id of ['leaderboard-root', 'challenges-root']) {
    const el = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(el, `#${id} exists`);
    assert.match(el[0], /class="hidden/, `#${id} ships hidden`);
  }
});

// ─── Section state ───────────────────────────────────────────────────────

test('Leaderboard.section defaults to the standings', () => {
  assert.match(lbJs, /section: 'topochain',/,
    "the screen opens on the primary standings tab, not on Kudos");
});

// The strip's markup moved to the island in #1083 chunk F — the module
// publishes the active section and React renders the buttons — so the labels
// and keys are asserted where they now live. `_renderSectionTabs` is still the
// entry point and is checked to have become a publish rather than a write, so
// the two halves can't drift back into both rendering.
test('the tab strip leads with the standings, labelled simply "Leaderboard"', () => {
  const list = island.slice(island.indexOf('const SECTION_TABS = ['), island.indexOf('];', island.indexOf('const SECTION_TABS = [')));
  assert.ok(list.length > 0, 'SECTION_TABS located in the island');
  const labels = [...list.matchAll(/\{ key: '([a-z]+)', label: '([^']+)' \}/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(labels, [
    ['topochain', 'Leaderboard'],
    ['kudos', 'Kudos'],
    ['challenges', 'Challenges'],
  ], 'standings first and called Leaderboard; the kudos board is the Kudos tab');
  // The KEYS are the platform's vocabulary for these tabs (hash aliases in
  // app.js, dapp.json checks) and must survive both the relabelling and the
  // move: they are the attribute dapp.json selects on.
  assert.match(island, /data-standings-tab=\{s\.key\}/, 'tab keys are unchanged');
  // Clicking a trigger goes back into the module, exactly as the innerHTML'd
  // button's own listener did.
  assert.match(island, /window\.Leaderboard\?\._setSection\?\.\(key\)/,
    'a trigger reports back through _setSection, which owns the hash and the panes');
});

test('_renderSectionTabs publishes instead of writing #standings-tabs', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _renderSectionTabs() {'), lbJs.indexOf('  // Re-fetch every cached pane'));
  assert.ok(fn.length > 0, '_renderSectionTabs located');
  // The host is React's now, and the migration's rule is that no public/js
  // module may write into a React-owned subtree.
  assert.doesNotMatch(fn, /innerHTML/, 'the strip is rendered by the island, not written here');
  assert.doesNotMatch(fn, /getElementById\('standings-tabs'\)/,
    'the module must not reach into the React-owned host at all');
  assert.match(fn, /store\.section = Leaderboard\.section;/, 'it publishes the active section');
  assert.match(fn, /for \(const listener of \[\.\.\.store\.listeners\]\)/,
    'and notifies the island, which re-renders the strip');
});

test('_setSection validates its input and syncs the hash', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _setSection(section) {'), lbJs.indexOf('  _applySection()'));
  assert.ok(fn.length > 0, '_setSection located');
  assert.match(fn, /if \(!Leaderboard\.SECTIONS\.includes\(section\)\) return;/,
    'garbage sections are a no-op, mirroring _setSub');
  assert.match(lbJs, /SECTIONS: \['topochain', 'kudos', 'challenges'\],/,
    'all three sections are declared in one place, in tab order');
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

test('_syncHash emits the canonical standings and challenges addresses', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _syncHash() {'), lbJs.indexOf('  _setWindow(win)'));
  assert.ok(fn.length > 0, '_syncHash located');
  assert.match(fn, /\? '#leaderboard'\n/,
    'the primary standings tab addresses as the BARE #leaderboard');
  assert.doesNotMatch(fn, /'#leaderboard\/topochain'/,
    'so an arriving #leaderboard/topochain bookmark self-heals to it');
  assert.match(fn, /'#leaderboard\/challenges'/, 'the Challenges tab addresses as #leaderboard/challenges');
  assert.match(fn, /#leaderboard\/users\/\$\{encodeURIComponent/, 'the profile drill-in hash is unchanged');
  assert.match(fn, /location\.hash\.startsWith\('#leaderboard'\)/,
    'still guarded so it never hijacks an app route mid-navigation');
});

// ─── Router ──────────────────────────────────────────────────────────────

test('navigateToLeaderboard routes every section segment to the section', () => {
  // Anchored on the name, not the full parameter list — the signature grew a
  // third argument for the #982 challenge deep link and will grow again.
  const fn = appJs.slice(
    appJs.indexOf('  navigateToLeaderboard(sub, profileUser'),
    appJs.indexOf('  _exitLeaderboard()')
  );
  assert.ok(fn.length > 0, 'navigateToLeaderboard located');
  assert.match(fn, /sub === 'topochain' \|\| sub === 'kudos' \|\| sub === 'challenges'/,
    "every section segment selects the section rather than falling through to _setSub");
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
  assert.match(branch, /_tcSection === 'challenges' \? '#leaderboard\/challenges' : '#leaderboard'/,
    'the address is rewritten in place — standings to the bare hash, one replaceState not two');
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

// ─── Completed challenges live here now (#981) ───────────────────────────
//
// The profile screen's season-wide completed-challenges list is gone; this
// pane owns the flag, and the standings pane cross-links to it.

test('the challenges pane reads `completed` from the PUBLIC row, not just the personalization map', () => {
  // This is what makes the chip/grouping/count correct on first paint AND
  // for a signed-out visitor. Reading it only from `_mine` (as it did before)
  // meant an anonymous viewer saw no completion state at all.
  const fn = chJs.slice(chJs.indexOf('  _isDone(c) {'), chJs.indexOf('  _ordered() {'));
  assert.ok(fn.length > 0, '_isDone located');
  assert.match(fn, /c\.completed === true/,
    'the public row is the source of truth');
  const publicFirst = fn.indexOf('c.completed === true');
  const mineFallback = fn.indexOf('m.completed === true');
  assert.ok(publicFirst > -1 && mineFallback > publicFirst,
    'the personalization row is only a fallback, checked after the public one');
});

test('the challenges grid sorts unfinished challenges ahead of completed ones', () => {
  const fn = chJs.slice(chJs.indexOf('  _ordered() {'), chJs.indexOf('  _renderGrid() {'));
  assert.match(fn, /_isDone\(a\.c\)/);
  assert.match(fn, /_isDone\(b\.c\)/);
  // The completed split is the FIRST key, ahead of the featured lift.
  assert.ok(fn.indexOf('ad !== bd') < fn.indexOf('af !== bf'),
    'not-completed must outrank featured, or a featured finished challenge leads the grid');
});

test('the challenges grid summarises and groups the completed set', () => {
  assert.match(chJs, /id="tc-se-challenge-summary"/,
    'the summary line carries a stable id the dapp.json check anchors on');
  assert.match(chJs, /challenges completed/, 'and states the tally in words');
  assert.match(chJs, />Completed<\/div>/,
    'the grouping subheading exists');
  // Suppressed when everything (or nothing) is finished — every public event
  // in production is currently 100% completed, where the heading says nothing.
  const fn = chJs.slice(chJs.indexOf('const GRID_CLASS'),
    chJs.indexOf('id="tc-se-challenge-summary"'));
  assert.match(fn, /firstDone > 0 && doneCount > 0/,
    'the subheading is gated on BOTH groups being non-empty');
  assert.match(chJs, /opacity-60/, 'completed cards are dimmed');
});

test('the standings pane cross-links to the challenges tab without ever painting an error', () => {
  const load = topoJs.slice(
    topoJs.indexOf('  async _loadChallengeCounts(eventId) {'),
    topoJs.indexOf('  // ── Rendering'));
  assert.ok(load.length > 0, '_loadChallengeCounts located');
  assert.ok(!/_error/.test(load),
    'a failed tally must never paint a banner over the standings table');
  assert.match(load, /_eventId\(\) !== eventId/,
    'and a fast event switch must not paint one event\'s tally over another');
  assert.match(standingsTsx, /id="tc-lb-challenge-link"/,
    'the line itself is rendered by the pane component');
  assert.match(standingsTsx, /id="tc-lb-to-challenges"/,
    'and carries the id the dapp.json check selects on');
  assert.match(topoJs, /counts\.total > 0/,
    'no line at all when the event has no challenges (never "0 of 0")');
  assert.match(topoJs, /window\.location\.hash = '#leaderboard\/challenges'/,
    'the link goes through the router, so the shared event selection survives');
});

// ─── Season aggregate vs per-event board (#999) ──────────────────────────
//
// The standings pane renders two DIFFERENT datasets through one table: one
// event's stored snapshots (`event.type === 'regular'`), or the whole
// season's aggregate (`'season'`, resolved server-side through
// computeStandings). The season path has no per-EVENT breakdown to report —
// the server hard-codes event_success_rate and friends to 0 — so a "Success
// rate" column there can only print "0%", indistinguishable from a real zero.
//
// Behavioural, not regex: run the real _renderBody against both payloads and
// diff the DESCRIPTOR it publishes. #1191 slice 6 conversion 5 moved the
// markup into ./topochain-standings.tsx, so what this reads changed from a
// host's innerHTML to the store's `body` — the decision under test (which
// columns exist for which board) is unchanged and still lives here.
//
// The module is still evaluated as a CLASSIC SCRIPT, which is the whole reason
// its store is planted rather than imported: an `import` line would make this
// harness a syntax error. Keep it that way.
function renderStandings(payload) {
  // A stand-in for lib/plain-store.js — set() is the only method the
  // controller calls, and a fresh one per call keeps the two payloads apart.
  const store = {
    state: { mounted: false, body: null, drill: null },
    set(patch) { store.state = { ...store.state, ...patch }; },
    get: () => store.state,
    subscribe: () => () => {},
    setFlush: () => {},
  };
  const sandbox = {
    window: {},
    document: { getElementById: () => null },
    console,
  };
  sandbox.window.document = sandbox.document;
  const TL = new Function('window', 'document', 'module',
    `${topoJs}\nreturn TopochainLeaderboard;`)(sandbox.window, sandbox.document, undefined);
  TL._store = store;
  TL._open = true;
  TL._loading = false;
  TL._data = payload;
  TL._meta = { page: 1, per_page: 25, total: 1, total_pages: 1 };
  TL._renderBody();
  return store.state.body;
}

const SEASON_ROW = {
  rank: 1, is_non_podium: false, display_name: 'Ocank14', identifier: 'oca***',
  total_points: 67973.66, extra_points: 0, event_total_produced_blocks: 42,
  event_success_rate: 0, wallet_address: null, bech32m: null, discord: 'ocank14',
};

test('the standings table drops the Success rate column on a season board', () => {
  const view = renderStandings({
    event: { id: 7, name: 'Season 1', display_leaderboard: true, type: 'season' },
    leaderboard: [SEASON_ROW],
  });
  assert.equal(view.state, 'table');
  assert.ok(!view.columns.includes('success'),
    'the season aggregate has no per-event success rate to report, so the '
    + 'column does not exist — it cannot print the hard-coded 0 as if measured');
  // The points and blocks columns are real on both paths and must survive.
  assert.deepEqual(view.columns, ['rank', 'user', 'points', 'blocks']);
  assert.equal(view.rows[0].points, '67973.66', 'the season total is the headline number');
  assert.equal(view.headers.blocks, 'Blocks produced', 'blocks IS a real season-wide sum');
  assert.equal(view.headers.points, 'Season points', 'the column says which total it is');
  assert.equal(view.isSeason, true);
});

test('the standings table keeps the Success rate column on a per-event board', () => {
  const view = renderStandings({
    event: { id: 8, name: 'Season 1 Beta', display_leaderboard: true, type: 'regular' },
    leaderboard: [{ ...SEASON_ROW, total_points: 1900, event_success_rate: 80 }],
  });
  assert.equal(view.state, 'table');
  assert.deepEqual(view.columns, ['rank', 'user', 'points', 'blocks', 'success'],
    'a single event measures it');
  assert.equal(view.headers.success, 'Success rate');
  assert.equal(view.rows[0].success, '80');
  assert.equal(view.headers.points, 'Points', 'and the points column is unqualified');
  assert.equal(view.isSeason, false);
});

test('the season board and the per-event board stay column-aligned', () => {
  // This used to count <th> against <td> in the rendered HTML, because the
  // string renderer dropped the success cell with TWO independent
  // conditionals and one could be edited without the other. The descriptor
  // makes that unrepresentable: there is a single `columns` list, and the
  // renderer maps over it once for the header row and once per body row. The
  // assertion is therefore structural — both maps read the same list.
  const view = renderStandings({
    event: { id: 7, name: 'Season 1', display_leaderboard: true, type: 'season' },
    leaderboard: [SEASON_ROW],
  });
  assert.equal(view.columns.length, 4, 'rank, user, season points, blocks');
  for (const c of view.columns) {
    assert.ok(view.headers[c], `every rendered column has a header (${c})`);
  }
  const maps = (standingsTsx.match(/view\.columns\.map\(/g) || []).length;
  assert.equal(maps, 2,
    'exactly two maps over the one column list — the header row and the body row; '
    + 'a third source of truth is how the table skewed before');
});

test('the season caption replaces the "nothing is running" caption', () => {
  // The season event has usually ENDED by the time it is the default
  // (production's closed 2026-06-30), so hasEnded() is true for it and the
  // old caption would read "Nothing is running right now" above the very
  // board the screen exists to show. The two flags are mutually exclusive.
  assert.match(ctxJs, /_endedFallback\s*=\s*\n?\s*!TopochainEvents\.isSeasonAggregate\(pick\)/,
    'a season pick suppresses the ended-event caption rather than stacking with it');
  assert.match(ctxJs, /Whole-season standings/, 'the season caption exists');
  // The caption must key off the SELECTION, not off "pickDefault landed
  // here": the standings pane's first fetch resolves the default server-side
  // and writes the id back silently, usually before this module's list lands,
  // so pickDefault never runs on most real loads. Keying off a flag set in
  // that branch left the caption missing exactly when it was needed.
  assert.match(ctxJs, /\$\{isSeason \? `\s*\n\s*<p id="tc-ev-season-note"/,
    'the caption renders from isSeasonSelected(), not from a default-pick flag');
  assert.ok(!/_seasonDefault/.test(ctxJs),
    'the default-pick flag is gone — the selection is the single source of truth');
  // The picker and the hero must not label the season event "(past)".
  assert.match(ctxJs, /isSeason \? ' \(season\)'/, 'the option reads (season)');
  assert.match(ctxJs, /const statusLabel = isSeason \? 'season'/, 'so does the hero badge');
});

test('both #981 checks are declared and the reader keeps them', () => {
  // This used to assert POSITION: the reader kept only the first MAX_TESTS
  // entries, so a check appended at the bottom of dapp.json was decoration —
  // declared, never parsed, never run. #1019 ended that; every declared
  // check runs through the capture pool and the only bound left is
  // MAX_DECLARED_TESTS, a ceiling this repo is nowhere near.
  //
  // So the assertion that still means something is not "these two are near
  // the top" but "the reader kept them and refused NOTHING for ceiling
  // reasons" — which is what would break if the manifest ever grew past the
  // ceiling and started silently shedding its tail again.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(manifest);
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'the tail is being dropped again, which is exactly the bug #1019 fixed');
  const kept = meta.tests;
  const summary = kept.find((t) => t.path === '/#leaderboard/challenges');
  const crossLink = kept.find((t) => t.path === '/#leaderboard');
  assert.ok(summary, 'the challenges-summary check must survive the reader');
  assert.ok(crossLink, 'the standings cross-link check must survive the reader');
  assert.match(summary.expectSelector, /#tc-se-challenge-summary/);
  assert.match(crossLink.expectSelector, /#tc-lb-to-challenges/);

  // Both of these paths already had a check, and two suites locate those by
  // path with `.find()` — so ours, sitting earlier in the array, SHADOWS
  // them. It therefore has to carry their assertions too, or moving a check
  // to the top of the array silently weakens what the older ones pinned.
  assert.match(crossLink.expectSelector, /\[data-standings-tab="challenges"\]/,
    'the shadowing /#leaderboard check must still assert the three-tab strip');

  // #999 rides on this SAME entry rather than declaring its own. The cap is
  // full of load-bearing checks — every one of the ten is pinned by a suite
  // like this — so two new entries at the top would have silently pushed the
  // #911 and #947 home-panel checks out of the parse window and broken their
  // guards. Same route, one more assertion, nothing displaced: the default
  // /#leaderboard board must be the whole-season one.
  assert.equal(crossLink.expectText, 'Whole-season standings',
    'the /#leaderboard check must also assert the season board is the default');
  assert.match(summary.expectSelector, /#challenges-root:not\(\.hidden\)/,
    'and the shadowing /#leaderboard/challenges check the revealed pane');
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
