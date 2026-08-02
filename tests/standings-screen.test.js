// Standings screen — the Kudos leaderboard and the Topochain
// leaderboard merged behind one entry point with a two-tab strip.
//
// The contract that's easy to break later:
//   - the screen opens on Kudos, so the merge can't quietly change what
//     the trophy/menu entry shows;
//   - every existing #leaderboard deep link (prs / users / history /
//     users/<name>) still resolves to a Kudos sub-tab;
//   - #leaderboard/topochain is the canonical Topochain address and
//     #topochain/leaderboard aliases onto it, so old bookmarks work;
//   - the two panes keep SEPARATE data state — routing Topochain
//     through Leaderboard._cache would break its event/page paging.
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
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ─── Shell ───────────────────────────────────────────────────────────────

test('the Standings screen hosts a tab strip and both panes', () => {
  const start = html.indexOf('<main id="leaderboard-screen"');
  const end = html.indexOf('</main>', start);
  assert.ok(start > -1, '#leaderboard-screen exists');
  const screen = html.slice(start, end);
  assert.ok(screen.includes('>Standings<'), 'the screen is titled Standings');
  assert.ok(screen.includes('id="standings-tabs"'), 'it carries the section tab strip');
  assert.ok(screen.includes('id="leaderboard-root"'), 'it hosts the Kudos pane');
  assert.ok(screen.includes('id="topochain-leaderboard-root"'), 'it hosts the Topochain pane');
  // Wide enough for the Topochain table; the Kudos lists keep their
  // narrower reading column.
  assert.match(screen, /max-w-5xl/, 'the shell is the wider column');
  assert.match(screen, /id="leaderboard-root" class="max-w-3xl"/,
    'the Kudos pane keeps its reading width');
});

test('the Topochain pane ships hidden — Kudos is the default section', () => {
  const pane = html.match(/<div id="topochain-leaderboard-root"[^>]*>/);
  assert.ok(pane, '#topochain-leaderboard-root exists');
  assert.match(pane[0], /class="hidden/, 'the Topochain pane ships hidden');
});

// ─── Section state ───────────────────────────────────────────────────────

test('Leaderboard.section defaults to kudos', () => {
  assert.match(lbJs, /section: 'kudos',/, "the screen opens on the Kudos tab");
});

test('_setSection validates its input and syncs the hash', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _setSection(section) {'), lbJs.indexOf('  _applySection()'));
  assert.ok(fn.length > 0, '_setSection located');
  assert.match(fn, /if \(section !== 'kudos' && section !== 'topochain'\) return;/,
    'garbage sections are a no-op, mirroring _setSub');
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

test('_syncHash emits the canonical topochain address', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _syncHash() {'), lbJs.indexOf('  _setWindow(win)'));
  assert.ok(fn.length > 0, '_syncHash located');
  assert.match(fn, /'#leaderboard\/topochain'/, 'the Topochain tab addresses as #leaderboard/topochain');
  assert.match(fn, /#leaderboard\/users\/\$\{encodeURIComponent/, 'the profile drill-in hash is unchanged');
  assert.match(fn, /location\.hash\.startsWith\('#leaderboard'\)/,
    'still guarded so it never hijacks an app route mid-navigation');
});

// ─── Router ──────────────────────────────────────────────────────────────

test('navigateToLeaderboard routes the topochain segment to the section', () => {
  const fn = appJs.slice(
    appJs.indexOf('  navigateToLeaderboard(sub, profileUser)'),
    appJs.indexOf('  _exitLeaderboard()')
  );
  assert.ok(fn.length > 0, 'navigateToLeaderboard located');
  assert.match(fn, /sub === 'topochain' && window\.Leaderboard\?\._setSection/,
    "'topochain' selects the section rather than falling through to _setSub");
  assert.match(fn, /App\.setHeaderTitle\('Standings'\)/, 'the screen is titled Standings');
  // openProfile must still win over both — _setSub/_setSection would
  // replaceState the profile hash away.
  assert.ok(
    fn.indexOf('Leaderboard.openProfile(profileUser)')
      < fn.indexOf("Leaderboard._setSection('topochain')"),
    'the profile drill-in is checked first');
});

test('the legacy #topochain/leaderboard hash self-heals to the canonical form', () => {
  const branch = appJs.slice(
    appJs.indexOf("if (parts[0] === 'topochain')"),
    appJs.indexOf("if (parts[0] === 'app' && parts[1])")
  );
  assert.match(branch, /history\.replaceState\(null, '', '#leaderboard\/topochain'\)/,
    'the address is rewritten in place');
  assert.match(branch, /App\.navigateToLeaderboard\('topochain', null\)/, 'then hands off');
  assert.match(branch, /catch \(err\)/,
    'a replaceState failure must not swallow the navigation');
});

// ─── Pane lifecycle + data isolation ─────────────────────────────────────

test('the Topochain pane mounts lazily and tears down with the screen', () => {
  assert.match(lbJs, /_topoMounted: false,/, 'mount state is tracked');
  const apply = lbJs.slice(lbJs.indexOf('  _applySection() {'), lbJs.indexOf('  _renderSectionTabs()'));
  assert.match(apply, /!Leaderboard\._topoMounted && window\.TopochainLeaderboard\?\.open/,
    'open() runs the first time the Topochain tab is shown, not on every visit to Standings');
  const close = lbJs.slice(lbJs.indexOf('  close() {'), lbJs.indexOf('  // ── Section'));
  assert.match(close, /TopochainLeaderboard\.close\(\)/,
    'leaving Standings closes the guest pane too, so in-flight fetches cannot paint into it');
});

test('the two panes keep separate data state', () => {
  // Kudos events cannot change Topochain standings — refresh() must bail.
  const refresh = lbJs.slice(lbJs.indexOf('  refresh() {'), lbJs.indexOf('  invalidateHistory()'));
  assert.match(refresh, /if \(Leaderboard\.section !== 'kudos'\) return;/,
    'a kudos_update never re-fetches while the Topochain tab is active');
  // The Topochain module owns its own paging/event state. Strip
  // comments before asserting — the module's header comment says in
  // words that it stays out of the cache, which is not a usage.
  const topoCode = topoJs.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/Leaderboard\._cache/.test(topoCode),
    'the Topochain module must not route through the Kudos cache');
  assert.match(topoJs, /_page: /, 'it keeps its own paging state');
});

test('pull-to-refresh dispatches on the active section', () => {
  const fn = appJs.slice(appJs.indexOf('  _wirePullToRefresh() {'), appJs.indexOf('  bindEvents() {'));
  assert.match(fn, /Leaderboard\.section === 'topochain'/, 'the handler branches on the section');
  assert.match(fn, /TopochainLeaderboard\.loadLeaderboard\(\)/,
    'a pull on the Topochain tab reloads Topochain standings, not kudos panes');
});

// ─── Duplicate titles ────────────────────────────────────────────────────

test('neither pane renders a heading of its own — the shell owns the title', () => {
  assert.ok(!/>Kudos leaderboard</.test(lbJs),
    'the Kudos pane dropped its own <h2>; the shell says Standings and the tab says Kudos');
  assert.ok(!/>Topochain leaderboard</.test(topoJs),
    'the Topochain pane dropped its own <h1>');
});

// ─── dapp.json ───────────────────────────────────────────────────────────

test('dapp.json checks both the canonical route and the legacy alias', () => {
  const tests = manifest.tests || [];
  const canonical = tests.find((t) => t.path === '/#leaderboard');
  assert.ok(canonical, 'a check renders /#leaderboard');
  assert.match(canonical.expectSelector, /\[data-standings-tab="topochain"\]/,
    'and asserts the second tab is actually rendered');
  const alias = tests.find((t) => t.path === '/#topochain/leaderboard');
  assert.ok(alias, 'a check still exercises the legacy alias');
  const standingsRow = tests.find(
    (t) => typeof t.expectSelector === 'string' && t.expectSelector.includes('#drawer-row-standings')
  );
  assert.ok(standingsRow, 'a check asserts the Standings drawer row renders');
});
