// "Explore" on a proposal (#827, #1045).
//
// #827 replaced "Ask AI" with "✨ Explore in dev chat", which opened a
// conversation about the PR with an editable message pre-filled; #2779 made
// that an unsent agent session. Both chats are retired: Explore now opens
// the viewer's Homeroom bot thread about the change
// (AppView.askBotForChanges, pinned by tests/ask-for-changes-attach.test.js).
//
// What this file pins is who is offered it and where:
//   - _showExplorePill, the one shared gate: another person's change, or the
//     viewer's own IMPORTED one; never governance or close-issue rows;
//   - the read-only rule lives at each render site, not in the gate;
//   - on a card it is a ⋯ row, never also a face pill;
//   - the availability probe forwards ?demo=1.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context and stub the globals it reaches.
//
// Run with: node --test tests/explore-pr-in-dev-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mergedCardHtml, proposalCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeHarness() {
  const calls = {
    switchTab: [],
    toast: [],
    refreshCaches: 0,
  };
  const sandbox = {
    console,
    relTime: () => 'just now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    PlatformUI: { toast: (m) => { calls.toast.push(m); } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    App: {
      user: { id: 42 },
      switchTab: async (...args) => { calls.switchTab.push(args); },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  // The ⋯ rows and meta links to GitHub decide by the address
  // (frontend/src/lib/repo-link.js, published as window.RepoLink).
  require('./lib/repo-link').installRepoLink(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'test-app' };
  // _refreshSessionCaches hits three endpoints; the tests set _mySessions
  // directly, so stub it and just record that the flow re-grounds first.
  AppView._refreshSessionCaches = async () => { calls.refreshCaches++; };
  AppView._mySessions = [];
  AppView._proposals = [];
  AppView._merged = [];
  return { AppView, calls, sandbox };
}

// ── _showExplorePill — the one shared gate (#1045) ─────────────────────────
//
// Three render sites (the feed/board card, the Completed card, the topic
// head) used to re-derive `!mine` independently. They now all call this, so
// the truth table is pinned in one place. ME is the viewer (App.user.id is
// 42 in the harness); 999 is somebody else.
const ME_ID = 42;
const OTHER_ID = 999;

test('_showExplorePill: foreign proposals get the pill, native or imported', () => {
  const { AppView } = makeHarness();
  assert.equal(AppView._showExplorePill({ id: 1, user_id: OTHER_ID }), true,
    "someone else's native proposal — unchanged from #313");
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: OTHER_ID, source: 'imported' }), true,
    "someone else's imported proposal"
  );
});

test('_showExplorePill: your own NATIVE proposal still gets none (#313/#348)', () => {
  const { AppView } = makeHarness();
  assert.equal(AppView._showExplorePill({ id: 1, user_id: ME_ID }), false,
    'the owner works on it from its own change page');
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: ME_ID, source: 'maintenance' }), false,
    'a native provenance marker is not an import'
  );
});

test('_showExplorePill: your own IMPORTED proposal DOES get one (#1045)', () => {
  const { AppView } = makeHarness();
  // The reported hole: sessionBtn is (mine && !imported) and the pill used
  // to be (!mine), so an owner of an imported PR got neither.
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: ME_ID, source: 'imported' }), true,
    'no dev session exists for it, so the pill is the only AI affordance'
  );
  assert.equal(
    AppView._showExplorePill({
      id: 1, user_id: ME_ID, source: 'imported', external_agent: 'claude-code',
    }),
    true,
    'a connector-authored proposal is an imported row too'
  );
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: ME_ID, source: 'imported', status: 'merged' }),
    true,
    'merged imported proposals stay explorable on the Completed list'
  );
});

test('_showExplorePill: governance and close-issue rows never get one (#827)', () => {
  const { AppView } = makeHarness();
  // There is no code to talk through on a rename / secret change /
  // close-issue vote.
  assert.equal(
    AppView._showExplorePill({ id: 5, kind: 'secret_change', created_by: OTHER_ID }), false,
    'governance rows carry `kind`; PR-proposal rows do not'
  );
  assert.equal(
    AppView._showExplorePill({ id: 5, row_type: 'close_issue', kind: 'close_issue' }), false,
    'an applied close-issue row in the Completed stream'
  );
  assert.equal(AppView._showExplorePill(null), false, 'a missing row is a quiet false');
});

// ── The rule as the cards actually render it (#1045) ───────────────────────

// _renderProposalCard / _renderMergedCard need the two render caches the
// dev view normally fills.
function cardHarness() {
  const { AppView } = makeHarness();
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

// The card-as-pointer revision demoted most card actions into the ⋯ menu,
// whose descriptors live in AppView._cardMenus keyed by the trigger's
// data-card-menu — so "does this card offer X" is a registry question, not
// a markup one, for everything except the face pills.
function menuLabels(AppView, html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  if (!m) return [];
  return (AppView._cardMenus[m[1]] || []).map((it) => it.label);
}
function menuHas(AppView, html, re) {
  return menuLabels(AppView, html).some((l) => re.test(l));
}

const MY_IMPORT = {
  id: 7, pr_number: 9300, pr_url: 'https://github.com/acme/app/pull/9300',
  pr_title: 'Adjust kanban breakpoint to 640px', username: 'me', user_id: ME_ID,
  status: 'promoted', source: 'imported', imported_pr_author: 'octo-contributor',
  created_at: '2026-06-01T00:00:00Z',
};

test('proposal card: my own IMPORTED proposal offers Explore from ⋯', () => {
  const AppView = cardHarness();
  const html = proposalCardHtml(AppView, MY_IMPORT);
  // #1787 round four put Explore back in ⋯ on cards; _showExplorePill's rule
  // about WHO is offered it (#1045) is untouched, only WHERE.
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/),
    'the ⋯ row is the owner\'s only AI affordance here');
  assert.ok(!html.includes('gc-explore-chat-btn'), 'and not also a face pill');
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw is untouched too — now a ⋯ row');
});

test('proposal card: my own NATIVE proposal offers no Explore', () => {
  const AppView = cardHarness();
  const html = proposalCardHtml(AppView, { ...MY_IMPORT, source: undefined, imported_pr_author: undefined });
  assert.doesNotMatch(html, /gc-explore-chat-btn/, 'no pill on the face');
  assert.ok(!menuHas(AppView, html, /Explore in a coding agent/), 'and no ⋯ row either');
});

test('the gate does NOT own the read-only rule: each render site does', () => {
  // Deliberate: the predicate answers "does this ROW deserve Explore" and
  // nothing else, and the collab gate (#621) is applied where it renders.
  const AppView = cardHarness();
  AppView.appData = { slug: 'test-app', can_collaborate: false };
  const theirs = { ...MY_IMPORT, user_id: OTHER_ID, username: 'alice', source: undefined, imported_pr_author: undefined };
  assert.equal(AppView._showExplorePill(theirs), true);
  assert.ok(!menuHas(AppView, proposalCardHtml(AppView, theirs), /Explore in a coding agent/),
    'a read-only viewer\'s card offers no Explore row');
  const pills = (AppView._detailActionsView('proposal', theirs) || { pills: [] }).pills;
  assert.ok(!pills.some((p) => p.key === 'explore'), 'nor does the change\'s own page');
});

test('merged card: my own IMPORTED completed proposal renders the pill', () => {
  const AppView = cardHarness();
  const html = mergedCardHtml(AppView, { ...MY_IMPORT, status: 'merged' }, 1);
  // On a merged card the action band belongs to kudos, so Explore is a ⋯ row.
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/),
    'Explore offered from ⋯ on my own imported completed proposal');
});

test('merged card: my own NATIVE completed proposal still renders no pill', () => {
  const AppView = cardHarness();
  const html = mergedCardHtml(AppView, 
    { ...MY_IMPORT, source: undefined, imported_pr_author: undefined, status: 'merged' }, 1
  );
  assert.doesNotMatch(html, /gc-explore-chat-btn/);
  assert.ok(!menuHas(AppView, html, /Explore in a coding agent/), 'no ⋯ row on my own native merged PR');
});

// ── The availability probe forwards ?demo=1 ─────────────────────────────────
//
// Staging previews run without the platform LLM key (it's on the
// platform-secrets denylist), so the real branch of GET /api/budget answers
// aiEnabled:false there and _applyExploreChatAvailability rewrites every
// Explore button's title to "AI chat isn't configured…" one fetch round-trip
// after the board paints. The card-menu dapp.json check matches on
// title^="Open a dev chat…", so before demo forwarding it was a race against
// that rewrite (~50ms window). The demo branch answers aiEnabled:true, which
// keeps demo-preview chrome in its configured state — same idiom as every
// other _demoQS() forward on this view.

function probeHarness(search, budget) {
  const h = makeHarness();
  // _demoQS reads location.search through URLSearchParams — a Node global,
  // not a JS intrinsic, so the vm context doesn't have it by default.
  h.sandbox.URLSearchParams = URLSearchParams;
  h.sandbox.location = { search, hash: '' };
  h.calls.fetched = [];
  h.sandbox.fetch = async (url) => {
    h.calls.fetched.push(String(url));
    return { ok: true, json: async () => budget };
  };
  return h;
}

test('availability probe: ?demo=1 pages hit the demo branch of /api/budget', async () => {
  const { AppView, calls } = probeHarness('?demo=1', { aiEnabled: true, demo: true });
  assert.equal(await AppView._ensureAiAvailability(), true);
  assert.deepEqual(calls.fetched, ['/api/budget?demo=1'],
    'the probe forwards ?demo=1 like every other demo-aware fetch');
});

test('availability probe: production pages fetch /api/budget unadorned', async () => {
  const { AppView, calls } = probeHarness('', { aiEnabled: false });
  assert.equal(await AppView._ensureAiAvailability(), false,
    'a real aiEnabled:false still disables the pill outside demo mode');
  assert.deepEqual(calls.fetched, ['/api/budget']);
});
