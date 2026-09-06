// The Workshop — the Dev screen's lander, which replaced the Activity feed.
//
// What is pinned here, and why each would fail silently if it drifted:
//
//   * The view model (`AppView._workshopView`) groups the SAME cards the
//     Board draws by the server's themes, keyed the way the server keys them,
//     and never loses a card: one the themes do not name lands under "Not yet
//     grouped", and one they name but the board no longer has is not drawn.
//   * The two strips: proposals waiting on THIS viewer's vote are pinned
//     whatever the filters say; "since your last visit" is computed against
//     a baseline read once per page session, and a first visit gets the
//     welcome instead.
//   * The shared filter bar narrows the themes, and the Workshop's own
//     `theme` filter is what "Open on Board" hands the kanban.
//   * A row unfolds into the Activity entry byte-for-byte — `.dev-feed-entry`
//     around the dense card, the GitHub slot and the app thread — so the
//     sheet CSS and the module's two fillers find the markup they expect.
//   * The modes, the routes and the declared checks name the Workshop and
//     resolve the retired names (feed, list, /activity) onto it.
//
// Run with: node --test tests/dev-workshop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { workshopHtml } = require('./lib/dev-card-html');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');
const VIEW_TABS = read('frontend/src/features/improve/view-tabs.tsx');
const dapp = JSON.parse(read('dapp.json'));

function makeAppView(over) {
  const o = over || {};
  const store = o.localStorage || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    },
    location: o.location || { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  return AppView;
}

const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

// Values built inside the vm realm carry that realm's prototypes, which trips
// deepStrictEqual — round-trip through JSON before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A loaded board: two issues, a proposal awaiting the viewer's vote, a merge. */
function seed(AppView) {
  AppView._ghIssues = [
    { number: 12, title: 'Dark mode resets', createdAt: at(2), updatedAt: at(1), lastMessageAt: at(1), user: 'alice', htmlUrl: 'https://github.com/x/y/issues/12' },
    { number: 13, title: 'Keyboard voting', createdAt: at(20), updatedAt: at(9), lastMessageAt: null, user: 'bob', htmlUrl: 'https://github.com/x/y/issues/13' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 41, pr_title: 'Persist the theme', status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }];
  AppView._govProposals = [];
  AppView._merged = [{
    id: 78, pr_number: 40, pr_title: 'Landed thing', status: 'merged', username: 'alice',
    created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 1;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._devDataReady = true;
}

const themes = (list) => ({
  slug: 'demo-app', source: 'ai', generatedAt: '2026-09-06T00:00:00Z', stale: false, pending: false,
  at: Date.now(), themes: list,
});

// ── item keys ────────────────────────────────────────────────────────

test('_workshopItemKey speaks the server\'s vocabulary', () => {
  const AppView = makeAppView();
  assert.equal(AppView._workshopItemKey('issue', { number: 12 }), 'issue:12');
  assert.equal(AppView._workshopItemKey('proposal', { id: 34 }), 'session:34');
  assert.equal(AppView._workshopItemKey('shared-session', { id: 56 }), 'session:56');
  assert.equal(AppView._workshopItemKey('my-session', { id: 57 }), 'session:57');
  assert.equal(AppView._workshopItemKey('gov', { id: 5 }), 'gov:5');
  assert.equal(AppView._workshopItemKey('merged', { id: 78, row_type: 'pr' }), 'session:78');
  assert.equal(AppView._workshopItemKey('merged', { id: 9, row_type: 'close_issue', payload: { issueNumber: 12 } }), 'issue:12');
  assert.equal(AppView._workshopItemKey('issue', {}), null);
});

// ── grouping ─────────────────────────────────────────────────────────

test('cards land in their theme, by lane, and nothing is lost', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 'theming', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] },
    { id: 'ghost', name: 'Ghost', description: '', saying: '', items: ['issue:999'] },
  ]);
  const v = AppView._workshopView();
  assert.equal(v.loading, false);
  assert.equal(v.slug, 'demo-app');
  assert.equal(v.canPost, true);
  const names = v.themes.map((t) => t.name);
  assert.deepEqual(names, ['Theming', 'Not yet grouped'],
    'a theme whose every card is gone is not drawn; the unnamed issue goes to the remainder');
  const theming = v.themes[0];
  assert.equal(theming.saying, 'Dark mode should stick.');
  const lane = (t, k) => t.lanes.find((l) => l.key === k);
  assert.deepEqual(plain(lane(theming, 'review').rows.map((r) => r.key)), ['proposal:34']);
  assert.deepEqual(plain(lane(theming, 'open').rows.map((r) => r.key)), ['issue:12']);
  assert.deepEqual(plain(lane(theming, 'shipped').rows.map((r) => r.key)), ['merged:78']);
  assert.deepEqual(plain(theming.counts), { open: 1, underway: 0, review: 1, shipped: 1, fresh: 0 });
  assert.deepEqual(plain(theming.people), ['alice', 'carol'], 'alice filed and shipped, carol proposed');
  const rest = v.themes[1];
  assert.equal(rest.ungrouped, true);
  assert.deepEqual(plain(lane(rest, 'open').rows.map((r) => r.key)), ['issue:13']);
  // Lanes are in stage order, review first.
  assert.deepEqual(plain(theming.lanes.map((l) => l.key)), ['review', 'underway', 'open', 'shipped']);
});

test('before the themes arrive, everything sits under one group rather than a false "not yet grouped"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 1);
  assert.equal(v.themes[0].name, 'Everything on the board');
  assert.equal(v.meta.source, null);
});

test('another app\'s themes never group this app\'s cards', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = { ...themes([{ id: 'x', name: 'X', items: ['issue:12'] }]), slug: 'other-app' };
  const v = AppView._workshopView();
  assert.equal(v.themes[0].name, 'Everything on the board');
});

test('a row carries the thread and the GitHub slot the Activity entry carried', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'session:34'] }]);
  const v = AppView._workshopView();
  const t = v.themes[0];
  const issue = t.lanes.find((l) => l.key === 'open').rows[0];
  assert.equal(issue.commentsFor, 12);
  assert.deepEqual(plain(issue.thread), { type: 'issue', ref: 12 });
  const proposal = t.lanes.find((l) => l.key === 'review').rows[0];
  assert.deepEqual(plain(proposal.thread), { type: 'session', ref: 34 });
  assert.equal(proposal.commentsFor, undefined, 'only an issue has a repository conversation');
});

test('the lane cap counts what it hides, for "Open on Board"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues = Array.from({ length: 12 }, (_, i) => ({
    number: 100 + i, title: `Issue ${i}`, createdAt: at(30), updatedAt: at(30), user: 'bob',
  }));
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  const open = v.themes[0].lanes.find((l) => l.key === 'open');
  assert.equal(open.rows.length, AppView.WORKSHOP_LANE_MAX);
  assert.equal(open.more, 12 - AppView.WORKSHOP_LANE_MAX);
  assert.equal(v.themes[0].counts.open, 12, 'the count is the true one');
});

// ── the strips ───────────────────────────────────────────────────────

test('the vote strip pins what is owed to the viewer, whatever the filters say', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  let v = AppView._workshopView();
  assert.equal(v.votes.count, 1);
  assert.deepEqual(plain(v.votes.rows.map((r) => r.key)), ['vote:proposal:34']);
  // Voted → not owed.
  AppView._proposals[0].my_vote = 'yes';
  v = AppView._workshopView();
  assert.equal(v.votes.count, 0);
  // Owed but filtered out of the themes: still owed.
  AppView._proposals[0].my_vote = null;
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark mode' };
  v = AppView._workshopView();
  assert.equal(v.votes.count, 1, 'a vote owed is owed whatever the board is narrowed to');
  assert.equal(v.meta.filtered, true);
  assert.equal(v.themes[0].lanes.find((l) => l.key === 'review').rows.length, 0,
    'while the theme itself is narrowed');
  assert.equal(v.discussion, null, 'and the discussion row is dropped, as the feed dropped it');
});

test('a first visit gets the welcome; a return gets "since", against a baseline read once', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const first = AppView._workshopView();
  assert.equal(first.since, null);
  assert.deepEqual(plain(first.welcome), { open: 3, themes: 1, votesWaiting: 1, shippedWeek: 1 });

  // A new page session, a week later than the stamp the first one wrote.
  const store = {};
  store[`${AppView.WORKSHOP_SEEN_KEY}:demo-app`] = String(Date.now() - 5 * 86400000);
  const Later = makeAppView({ localStorage: store });
  seed(Later);
  Later._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = Later._workshopView();
  assert.equal(v.welcome, null);
  assert.ok(v.since, 'a baseline exists');
  assert.equal(v.since.opened, 1, 'issue 12 was filed two days ago; issue 13 twenty days ago');
  assert.equal(v.since.proposed, 1);
  assert.equal(v.since.shipped, 1);
  assert.deepEqual(plain(v.since.rows.map((r) => r.key).sort()), ['since:issue:12', 'since:merged:78', 'since:proposal:34']);
  assert.equal(v.themes[0].counts.fresh, 1, 'and the theme counts its new arrivals');
  assert.equal(v.themes[0].lanes.find((l) => l.key === 'open').rows[0].fresh, true);
  // The stamp advanced on that first read, and the baseline is held for the
  // page session: a later repaint compares against the same point.
  assert.ok(Number(store[`${Later.WORKSHOP_SEEN_KEY}:demo-app`]) > Date.now() - 1000);
  assert.equal(Later._workshopView().since.opened, 1);
});

test('the discussion row is drawn as a row of its own', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  assert.equal(v.discussion.key, 'discussion');
  assert.equal(v.discussion.card.attrs['data-discussion-row'], '1');
});

test('the capture deep link names the first issue row to unfold', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['session:34', 'issue:12'] }]);
  assert.equal(AppView._workshopView().autoExpand, null);
  AppView._workshopShot = 'feed-comments';
  assert.deepEqual(plain(AppView._workshopView().autoExpand), { theme: 't', key: 'issue:12' });
});

test('every return path states `loading`, because the store merges', () => {
  const AppView = makeAppView();
  AppView._devDataReady = false;
  assert.equal(AppView._workshopView().loading, true);
  seed(AppView);
  assert.equal(AppView._workshopView().loading, false);
});

// ── the theme filter ─────────────────────────────────────────────────

test('the theme filter narrows by membership, and widens when it cannot be applied', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const f = { ...AppView._defaultKanbanFilters(), theme: 't' };
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[0], f), true);
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[1], f), false);
  assert.equal(AppView._devCardMatches('proposal', AppView._proposals[0], f), false);
  AppView._workshopThemes = null;
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[1], f), true,
    'no themes loaded → the filter cannot hide anything');
  AppView._kanbanFilters = f;
  assert.equal(AppView._kanbanFiltersActive(), true);
  assert.equal(AppView._kanbanFilterCount(), 1);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  assert.deepEqual(plain(AppView._kanbanActiveChips().map((c) => [c.key, c.label])), [['theme', 'Theme: Theming']]);
  AppView._dismissKanbanFilter('theme');
  assert.equal(AppView._kanbanFilters.theme, null);
});

test('"Open on Board" narrows the board to the theme and goes there by hash', () => {
  const AppView = makeAppView({ location: { search: '', hash: '', href: 'http://localhost/' } });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  AppView.openBoardForTheme('t');
  assert.equal(AppView._kanbanFilters.theme, 't');
  assert.equal(AppView._loadKanbanFilters('demo-app').theme, null,
    'sessionStorage is stubbed empty here; the write is the module\'s _saveKanbanFilters');
});

// ── the component ────────────────────────────────────────────────────

test('the Workshop renders its strips, its themes and its folded rows', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] }]);
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-votes=""/, 'the vote strip');
  assert.match(html, /Needs your vote/);
  // Short rows, not cards: the folded row with the card's own Vote button
  // beside it (a sibling — the row is a button itself).
  assert.match(html, /<div class="dev-ws-vote-line"><button type="button" class="dev-ws-row" aria-expanded="false" data-ws-row="vote:proposal:34"[\s\S]*?<\/button><button [^>]*class="dev-vote-btn"/,
    'a vote row is the folded row plus the vote button');
  assert.ok(!/data-ws-votes[\s\S]*?gc-vote-item/.test(html.slice(0, html.indexOf('data-ws-welcome'))),
    'and no full card in the strip');
  // "Open on Board" sits at the bottom of the theme, not under a lane.
  assert.match(html, /<div class="dev-ws-theme-more">[\s\S]*?Open on Board ›/);
  assert.ok(!/dev-ws-more[\s\S]{0,80}Open on Board/.test(html), 'no lane carries its own');
  assert.match(html, /data-ws-welcome=""/, 'a first visit: the welcome');
  assert.match(html, /data-discussion-row="1"/, 'the discussion row');
  assert.match(html, /data-ws-theme="t"/, 'the theme');
  assert.match(html, /Dark mode should stick\./, 'with its saying');
  // The first theme opens by default, and its rows are folded disclosures
  // that carry NO card-open hook — the delegated #dev-body handler must not
  // see one on the row.
  assert.match(html, /<button type="button" class="dev-ws-row" aria-expanded="false" data-ws-row="issue:12"/);
  assert.ok(!/<button[^>]*data-issue-row/.test(html), 'the folded row is not an issue-row hook');
  assert.match(html, /data-ws-lane="review"/);
  assert.match(html, /data-ws-lane="shipped"/);
  assert.ok(!html.includes('dev-feed-entry'), 'nothing is unfolded on a plain paint');
  assert.match(html, /aria-pressed="true">By people</, 'the default order is by people');
});

test('an unfolded row is the Activity entry: the sheet, the card, the slot, the thread', () => {
  // The component unfolds from state, so pin the markup at the source: the
  // entry wrapper and its three children, in the order the feed drew them.
  const unfolded = WORKSHOP.slice(WORKSHOP.indexOf('function UnfoldedRow'), WORKSHOP.indexOf('function Lane'));
  assert.match(unfolded, /className="dev-feed-entry dev-ws-sheet"/, 'the sheet wrapper the feed used');
  assert.match(unfolded, /<DevCard model=\{row\.card\} \/>/, 'the same card builder');
  assert.match(unfolded, /className="dev-feed-comments" data-comments-for=\{String\(row\.commentsFor\)\}/,
    'the GitHub slot, rendered empty for _fillFeedComments');
  assert.match(unfolded, /<FeedThread slug=\{slug\} type=\{row\.thread\.type\} refId=\{row\.thread\.ref\} canPost=\{canPost\} \/>/,
    'the app thread with its reply box');
  assert.ok(unfolded.indexOf('<DevCard') < unfolded.indexOf('dev-feed-comments')
    && unfolded.indexOf('dev-feed-comments') < unfolded.indexOf('<FeedThread'), 'in the feed\'s order');
  // And the module's fillers are re-run when the set of unfolded rows changes.
  assert.match(WORKSHOP, /callAppView\('_wireFeedComments', host\)/);
  assert.match(WORKSHOP, /callAppView\('_fillKudosHosts', host\)/);
});

test('the sheet CSS moved host with the entry, and the Workshop has its own', () => {
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /^\s*(\.dark\s+)?#dev-feed\b/.test(l));
  assert.deepEqual(rules, [], 'no rule is scoped to the retired #dev-feed');
  assert.match(CSS, /#dev-workshop \.dev-feed-entry \{/);
  assert.match(CSS, /#dev-workshop \.dev-feed-thread \{/);
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding: 8px 4px 12px; \}/);
  assert.match(CSS, /\.dev-ws-theme-head \{/);
  assert.match(CSS, /\.dev-ws-row \{/);
});

// ── modes, routes, the strip, the checks ─────────────────────────────

test('workshop replaced feed as a mode, and the retired names resolve onto it', () => {
  const AppView = makeAppView();
  assert.deepEqual(plain(AppView.VIEW_MODES), ['workshop', 'kanban']);
  assert.equal(AppView._migrateViewMode('feed'), 'workshop');
  assert.equal(AppView._migrateViewMode('list'), 'workshop');
  assert.equal(AppView._migrateViewMode('pm'), 'kanban');
  assert.equal(AppView._getViewMode(), 'workshop', 'the default on every width');
  assert.ok(!APP_VIEW_SRC.includes('_rerenderFeed()'), 'the feed renderer is gone');
  assert.ok(!APP_VIEW_SRC.includes('_feedView()'), 'and its view model');
  assert.match(APP_VIEW_SRC, /_rerenderWorkshop\(\)/);
});

test('the strip is App | Workshop | Board, and the segments are anchors at their routes', () => {
  assert.match(VIEW_TABS, /data-context-row="app"[\s\S]*data-context-row="workshop"[\s\S]*data-context-row="board"/);
  assert.match(VIEW_TABS, /href=\{slug \? `#app\/\$\{slug\}\/workshop` : '#'\}/);
  assert.ok(!VIEW_TABS.includes('data-context-row="activity"'), 'the Activity segment retired');
  assert.match(VIEW_TABS, />Workshop</);
});

test('the declared checks cover the lander, its strips and an unfolded row', () => {
  const byName = (re) => dapp.tests.find((t) => re.test(t.name || ''));
  const lands = byName(/lands on the Workshop on every width/);
  assert.ok(lands && lands.expectSelector.includes('#dev-workshop'));
  const themesCheck = byName(/renders its themes into #dev-workshop/);
  assert.ok(themesCheck && /button\.dev-ws-row\[aria-expanded\]/.test(themesCheck.expectSelector));
  const demo = byName(/A demo theme names the mock rows/);
  assert.ok(demo && demo.expectSelector.includes('[data-ws-theme="demo-voting"]'));
  const votes = byName(/pins the proposals waiting on the viewer's vote/);
  assert.ok(votes && /\[data-ws-votes\][\s\S]*button\.dev-vote-btn/.test(votes.expectSelector));
  const unfolded = byName(/A Workshop row unfolds into the Activity sheet/);
  assert.ok(unfolded && /shot=feed-comments/.test(unfolded.path), 'the unfolded-row checks ride the capture deep link');
  const strip = byName(/three views in order: App, Workshop, Board/);
  assert.ok(strip && /workshop.*board/.test(strip.expectSelector));
  for (const t of dapp.tests) {
    assert.ok(!/#dev-feed\b/.test(t.expectSelector || ''), `${t.name}: no check selects the retired #dev-feed`);
  }
});
