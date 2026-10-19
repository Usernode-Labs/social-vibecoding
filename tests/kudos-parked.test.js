// Kudos is parked (#5249): one switch, and what it hides.
//
// frontend/src/features/leaderboard/kudos-parked.ts holds KUDOS_PARKED. While
// it is true:
//   * ./kudos.js publishes no `window.Kudos`, which is how the classic
//     scripts hear the switch: every kudos slot on a change card, the
//     "Thank <author>" line, the kudos ⋯ rows and the budget boot all ask
//     `window.Kudos` first (AppView._kudosOffered);
//   * a request offers no "Pledge kudos" pill or ⋯ row and shows no ★ count
//     (AppView._bountiesOffered);
//   * the Leaderboard strip has no Kudos tab, and the Kudos addresses land on
//     Challenges, while a person's page stays.
// Nothing is deleted: the widget's own logic is still tested, with the
// switch off, by kudos-thanks-variant, kudos-givers-popover and
// change-thanks-chip, which read it off the module's export.
//
// Run with: node --test tests/kudos-parked.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');
const { cardHtml } = require('./lib/dev-card-html');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the switch is on, and kudos.js publishes no window.Kudos while it is', () => {
  const { KUDOS_PARKED } = loadTsx('frontend/src/features/leaderboard/kudos-parked.ts');
  assert.equal(KUDOS_PARKED, true, 'kudos is parked');
  const hadWindow = 'window' in globalThis;
  const before = globalThis.window;
  globalThis.window = {};
  try {
    const mod = loadTsx('frontend/src/features/leaderboard/kudos.js', { cache: false });
    assert.equal(mod.KUDOS_PARKED, true, 'kudos.js re-exports the one switch');
    assert.equal(typeof mod.Kudos.renderButton, 'function', 'the widget still exists, as an export');
    assert.equal(globalThis.window.Kudos, undefined, 'but it is not published');
  } finally {
    if (hadWindow) globalThis.window = before;
    else delete globalThis.window;
  }
});

// app-view.js in a vm, with no Kudos global: the parked state as the shell
// sees it. Same harness as tests/card-action-layout.test.js.
function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, canAdminWrite: false } },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => { throw new Error('no request expected'); },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

const proposal = { id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'evan', user_id: 999, status: 'promoted', yes_count: 0, no_count: 0, created_at: '2026-06-01T00:00:00Z' };
const merged = { id: 8, pr_number: 800, pr_title: 'Ship it', username: 'evan', user_id: 999, status: 'merged', yes_count: 3, no_count: 1, chat_count: 0, created_at: '2026-06-01T00:00:00Z' };
const request = { number: 5, title: 'Fix the thing', bounty_count: 3, my_bounty: false };

test('no change card has a kudos slot, and no ⋯ row gives kudos', () => {
  const AppView = makeAppView();
  assert.equal(AppView._kudosOffered(proposal), false);
  for (const html of [
    cardHtml(AppView._proposalCardModel(proposal)),
    cardHtml(AppView._mergedCardModel(merged, 1)),
  ]) {
    assert.doesNotMatch(html, /data-kudos-host/, 'no kudos slot on the card');
    const key = (html.match(/data-card-menu="([^"]+)"/) || [])[1];
    const rows = key ? (AppView._cardMenus[key] || []).map((it) => it.label) : [];
    assert.ok(!rows.some((label) => /kudos/i.test(label)), `no kudos row in ⋯ (${rows.join(', ')})`);
  }
  // The detail view's "Thank <author>" line.
  const detail = AppView._detailActionsView('proposal', proposal);
  assert.ok(!detail.pills.some((p) => p.key === 'kudos'), 'no kudos pill on the detail page');
});

test('a request offers no bounty: no "Pledge kudos" pill or ⋯ row, no ★ count', async () => {
  const AppView = makeAppView();
  assert.equal(AppView._bountiesOffered(), false);
  const keys = AppView._detailActionsView('issue', request).pills.map((p) => p.key);
  assert.ok(!keys.includes('bounty'), `no Pledge kudos pill (${keys.join(', ')})`);
  const model = AppView._issueCardModel(request);
  const html = cardHtml(model);
  assert.doesNotMatch(html, /★/, 'no bounty count on the meta line');
  const key = (html.match(/data-card-menu="([^"]+)"/) || [])[1];
  const rows = key ? (AppView._cardMenus[key] || []).map((it) => it.label) : [];
  assert.ok(!rows.some((label) => /kudos/i.test(label)), `no Pledge kudos row in ⋯ (${rows.join(', ')})`);
  // A stale door to it is a no-op: no request is made.
  AppView.appData = { slug: 'x' };
  await AppView.giveIssueBounty(5);
});

test('the Leaderboard strip has no Kudos tab, and the Kudos addresses land on Challenges', () => {
  const index = read('frontend/src/features/leaderboard/index.tsx');
  assert.match(index, /import \{ KUDOS_PARKED \} from '\.\/kudos\.js';/);
  assert.match(index, /\]\.filter\(\(s\) => !\(KUDOS_PARKED && s\.key === 'kudos'\)\);/,
    'the strip drops the Kudos tab while parked');
  const app = read('public/js/app.js');
  assert.match(app, /PARKED_KUDOS_SUBS: \['kudos', 'prs', 'users', 'history'\]/);
  assert.match(app, /if \(!profileUser && !window\.Kudos && App\.PARKED_KUDOS_SUBS\.includes\(parts\[1\]\)\) \{\s*try \{ history\.replaceState\(null, '', '#leaderboard\/challenges'\);[^\n]*\n\s*App\.navigateToLeaderboard\('challenges', null, null\);/,
    'a Kudos address is rewritten to Challenges; a person’s page is not');
});

test('the controller sends every Kudos sub-view to Challenges and keeps a person’s page, without its kudos', () => {
  const src = read('frontend/src/features/leaderboard/leaderboard.js');
  const sandbox = {
    console,
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    location: { hash: '#leaderboard/challenges' },
    history: { replaceState: () => {}, pushState: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const L = sandbox.Leaderboard;
  L._setSub('prs');
  assert.equal(L.section, 'challenges', 'Top changes lands on Challenges');
  L._setSection('kudos');
  assert.equal(L.section, 'challenges', 'so does the Kudos section itself');
  L.openProfile('ada');
  assert.equal(L.section, 'kudos', 'a person’s page still opens in the Kudos pane');
  assert.equal(L.chromeView().back, false, 'with no link back to Top users');
  L._cache.set('user|ada', {
    stats: { kudos_merged: 4, prs_merged: 2, prs_total: 3 },
    items: [{ app_slug: 'a', session_id: 1, pr_title: 'T', status: 'merged', created_at: '2026-06-01T00:00:00Z', kudos_count: 4 }],
  });
  const body = L.profileBodyView();
  assert.equal(body.stats.kudosMerged, null, 'no kudos figure on the page');
  assert.equal(body.rows[0].kudos, null, 'and none on its rows');
  assert.equal(body.stats.chips.length, 2, 'its other figures stay');
});
