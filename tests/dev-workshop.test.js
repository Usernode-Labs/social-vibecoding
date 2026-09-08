// The Workshop — the Dev screen's lander, which replaced the Activity feed.
//
// What is pinned here, and why each would fail silently if it drifted:
//
//   * The view model (`AppView._workshopView`) groups the SAME cards the
//     Board draws by the server's themes, keyed the way the server keys them,
//     and never loses a card: one the server has not placed yet lands under
//     "Being placed" (marked on the row), one its placer declined under "Not
//     yet grouped", one they name but the board no longer has is not drawn,
//     and the viewer's own private session is placed by the issue it links.
//   * The strips, in the order a returning member reads them: what changed
//     since they were last here, the app's state folded into a dashboard,
//     the proposals waiting on THIS viewer's vote (pinned whatever the
//     filters say) and one unclaimed issue to pick up. The baseline "since"
//     is measured against is read once per page session.
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
    setTimeout: o.setTimeout || setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    // A no-op by default, as it always was. `sessionStore` opts one test
    // group into a REAL one: the per-app filter set lives here, so whether a
    // filter change is persisted is only observable against a store that
    // remembers (#1787).
    sessionStorage: o.sessionStore ? {
      getItem: (k) => (k in o.sessionStore ? o.sessionStore[k] : null),
      setItem: (k, v) => { o.sessionStore[k] = String(v); },
      removeItem: (k) => { delete o.sessionStore[k]; },
    } : {
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

const themes = (list, extra) => ({
  slug: 'demo-app', source: 'ai', generatedAt: '2026-09-06T00:00:00Z', discoveredAt: '2026-09-06T00:00:00Z',
  stale: false, pending: false, pendingStage: null, lastError: null, coverage: null, unplaced: [],
  at: Date.now(), themes: list, ...(extra || {}),
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
  assert.deepEqual(names, ['Theming', 'Being placed'],
    'a theme whose every card is gone is not drawn; the card the server has not placed yet is on its way');
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
  assert.equal(rest.placing, 1);
  assert.deepEqual(plain(lane(rest, 'open').rows.map((r) => r.key)), ['issue:13']);
  assert.equal(lane(rest, 'open').rows[0].placing, true, 'the row says so');
  assert.equal(v.meta.placing, 1);
  // Lanes are in stage order, review first.
  assert.deepEqual(plain(theming.lanes.map((l) => l.key)), ['review', 'underway', 'open', 'shipped']);

  // The server's placer declined it: not on its way, not yet grouped.
  AppView._workshopThemes.unplaced = ['issue:13'];
  const declined = AppView._workshopView();
  assert.deepEqual(declined.themes.map((t) => t.name), ['Theming', 'Not yet grouped']);
  assert.equal(declined.themes[1].placing, 0);
  assert.equal(lane(declined.themes[1], 'open').rows[0].placing, undefined);
  assert.match(declined.themes[1].description, /count towards the next re-draft/);
});

test('the viewer\'s own private session is placed by the issue it links; without one it waits, unmarked', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [
    { id: 57, session_title: 'Fixing dark mode', status: 'active', linked_issues: ['12'], created_at: at(1), last_activity_at: at(0) },
    { id: 58, session_title: 'Something else', status: 'active', linked_issues: [], created_at: at(1), last_activity_at: at(0) },
  ];
  AppView._workshopThemes = themes([{ id: 'theming', name: 'Theming', items: ['issue:12', 'session:34', 'session:78', 'issue:13'] }]);
  const v = AppView._workshopView();
  const lane = (t, k) => t.lanes.find((l) => l.key === k);
  assert.deepEqual(v.themes.map((t) => t.name), ['Theming', 'Not yet grouped']);
  assert.deepEqual(plain(lane(v.themes[0], 'underway').rows.map((r) => r.key)), ['my-session:57'],
    'the linked session sits with its issue, though the server never saw it');
  assert.deepEqual(plain(lane(v.themes[1], 'underway').rows.map((r) => r.key)), ['my-session:58']);
  assert.equal(lane(v.themes[1], 'underway').rows[0].placing, undefined, 'a private session is never "being placed": the server cannot see it');
  assert.equal(v.themes[1].placing, 0);
});

test('a failed themes fetch is no themes, not themes that cover nothing', async () => {
  const AppView = makeAppView({ fetch: async () => { throw new Error('offline'); } });
  seed(AppView);
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(AppView._workshopThemes.failed, true);
  assert.equal(AppView._workshopThemeData(), null);
  const v = AppView._workshopView();
  assert.deepEqual(plain(v.themes.map((t) => t.name)), ['Everything on the board']);
  assert.equal(v.meta.source, null);
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

test('the dashboard is drawn every visit; "since" needs a baseline read once', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const first = AppView._workshopView();
  assert.equal(first.since, null, 'a first visit has nothing to be since');
  // #1787: this was `welcome`, and it was drawn ONLY here. "What is this
  // project working on" is a returning member's question too, so the same
  // numbers are drawn every visit, folded, with the rest of the app's state.
  assert.equal(first.dashboard.open, 3);
  assert.equal(first.dashboard.themes, 1);
  assert.equal(first.dashboard.votesWaiting, 1);
  assert.equal(first.dashboard.shippedWeek, 1);
  assert.equal(first.dashboard.people, 1, 'from the merge context, not a new request');

  // A new page session, a week later than the stamp the first one wrote.
  const store = {};
  store[`${AppView.WORKSHOP_SEEN_KEY}:demo-app`] = String(Date.now() - 5 * 86400000);
  const Later = makeAppView({ localStorage: store });
  seed(Later);
  Later._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = Later._workshopView();
  assert.ok(v.dashboard, 'and it is still there on a return visit');
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

test('the discussion row leads with what it is, not with the last thing said', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._discussionSummary = {
    slug: 'demo-app', content: 'Should the board default to the workshop?',
    username: 'dana', createdAt: at(0),
  };
  const card = AppView._workshopView().discussion.card;
  // The Board's card has always been this way round; the row was inside out,
  // so the one heading on the lander that never changes changed every time
  // somebody spoke (#1787).
  assert.equal(card.title.text, 'General discussion');
  assert.equal(plain(card.meta)[0].s, 'dana: Should the board default to the workshop?');

  AppView._discussionSummary = null;
  assert.equal(plain(AppView._workshopView().discussion.card.meta)[0].s,
    'Talk with everyone building this app',
    'and with nothing said yet the standing description takes the preview line');
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
  assert.equal(AppView._devCardMatches('proposal', { id: 99, linked_issues: ['12'], status: 'promoted' }, f), true,
    'a card the themes do not name is in the theme of the issue it links, as on the Workshop');
  assert.equal(AppView._devCardMatches('proposal', { id: 98, linked_issues: [] }, f), false);
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

// ── #1787: the dashboard, and the one thing to pick up ───────────────

test('the dashboard reads a rate, not just a count, and says when it is a floor', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._merged = [
    { id: 78, pr_number: 40, pr_title: 'This week', status: 'merged', username: 'alice', merged_at: at(2), created_at: at(2), row_type: 'pr' },
    { id: 79, pr_number: 39, pr_title: 'Also this week', status: 'merged', username: 'bob', merged_at: at(5), created_at: at(5), row_type: 'pr' },
    { id: 80, pr_number: 38, pr_title: 'Last week', status: 'merged', username: 'bob', merged_at: at(10), created_at: at(10), row_type: 'pr' },
  ];
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 2);
  assert.equal(d.shippedPrevWeek, 1, 'the week before, from the same source, so the two compare');
  assert.equal(d.partial, false);

  // The merged history is paged. With more behind it the counts are floors,
  // and the view has to say so rather than reporting a page as the record.
  AppView._mergedHasMore = true;
  assert.equal(AppView._workshopView().dashboard.partial, true);
});

test('"try taking this one next" names an open issue nobody is on', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Issue 12 is the more recent of the two, so it is the one offered.
  assert.equal(AppView._workshopView().nextUp.key, 'next:issue:12');
  assert.equal(AppView._workshopView().dashboard.unclaimed, 2);

  // A live claim, a running session or an assignee all take it out.
  AppView._ghIssues[0].in_progress = { claims: [{ username: 'dana' }] };
  assert.equal(AppView._workshopView().nextUp.key, 'next:issue:13', 'the claimed one is skipped');
  AppView._ghIssues[1].assignee = { top: 'erin' };
  assert.equal(AppView._workshopView().nextUp, null);
  assert.equal(AppView._workshopView().dashboard.unclaimed, 0);
});

test('an issue already being worked on is never the one offered', () => {
  const AppView = makeAppView();
  seed(AppView);
  // A promoted proposal against issue 12 moves it into the `underway` lane.
  // It carries no claim and no assignee, so only the LANE rules it out — and
  // offering it would name a card the viewer can see being built two strips
  // further down the same page.
  AppView._proposals[0].linked_issues = ['12'];
  const v = AppView._workshopView();
  assert.equal(v.nextUp.key, 'next:issue:13', 'the quiet one, not the busy one');
  assert.equal(v.dashboard.unclaimed, 1);
});

test('the suggestion stands down while a filter is active', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark' };
  // A narrowed board is somebody looking for something specific; offering
  // them a different card is an interruption, not an invitation.
  assert.equal(AppView._workshopView().nextUp, null);
});

test('the strips are ordered for a returning member: since, then state, then what to do', () => {
  const store = {};
  store[`${'workshopSeen'}:demo-app`] = String(Date.now() - 3 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const html = workshopHtml(AppView);
  const order = ['data-ws-since', 'data-ws-dashboard', 'data-ws-votes', 'data-ws-next', 'data-discussion-row']
    .map((k) => html.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `every strip is drawn: ${JSON.stringify(order)}`);
  assert.deepEqual(order.slice().sort((a, b) => a - b), order,
    'what changed, where the app is, what needs you, what you could take');
  assert.match(html, /<button type="button" class="dev-ws-link" aria-expanded="false">Show<\/button>/,
    'the dashboard opens folded — a lander that opens on statistics has buried what it is for');
});

// ── #1787: the row is the card, folded ───────────────────────────────

test('a folded row carries the card\'s status band, in the tone the pill already had', () => {
  const AppView = makeAppView();
  seed(AppView);
  // #1442's case: green checks on a proposal that no longer merges. The one
  // fact that decides whether it can land at all.
  AppView._proposals[0].mergeability = 'conflict';
  AppView._proposals[0].mergeability_files = ['src/a.js', 'src/b.js'];
  const html = workshopHtml(AppView);

  assert.match(html, /<span class="dev-ws-row-band">/,
    'the row has a band of its own, a mini of .dev-card-badges.dev-card-status');
  assert.match(html, /class="dev-ws-row-state dev-ws-row-state-blocked"[^>]*>Conflicts with main · 2 files</,
    'the composite pill keeps its label AND spends the tone it carries');
  assert.ok(!html.includes('dev-ws-row-pill'),
    'it is no longer flattened to plain text in the grey the author\'s name wears');

  // The band is clipped to one line for the same reason the dense card's is:
  // a row that grew with its state would break the column's rhythm.
  assert.match(CSS, /\.dev-ws-row-band \{[^}]*max-height: 18px;[^}]*overflow: hidden;/);
  assert.match(CSS, /\.dev-ws-row-open \.dev-ws-row-band \{ display: none; \}/,
    'and it stands down when the card below is showing the real one');
});

test('an open row grows the same card rather than painting a second one under it', () => {
  // The entry still renders the WHOLE dense card — two declared checks select
  // `.dev-feed-entry > .gc-vote-item` and the legacy fillers walk it — so the
  // de-duplication is CSS, not markup.
  const unfolded = WORKSHOP.slice(WORKSHOP.indexOf('function UnfoldedRow'), WORKSHOP.indexOf('function Lane'));
  assert.match(unfolded, /<DevCard model=\{row\.card\} \/>/);
  assert.match(CSS, /\.dev-ws-rowwrap-open > \.dev-feed-entry > \.gc-vote-item \.dev-card-head,\n\.dev-ws-rowwrap-open > \.dev-feed-entry > \.gc-vote-item \.dev-card-meta \{ display: none; \}/,
    'the repeated title and meta line are hidden, not removed');
  // …and the sheet treatment is overridden under the id it was set with, or
  // the body keeps its own 26px ring and reads as the second card again.
  assert.match(CSS, /#dev-workshop \.dev-ws-rowwrap-open > \.dev-feed-entry \{/);
  assert.match(CSS, /#dev-workshop \.dev-ws-rowwrap-open > \.dev-feed-entry > div:is\(\.dev-card-dense\) \{/);
  // The status band inside the open card STAYS: the vote button rides in it.
  assert.ok(!/\.dev-ws-rowwrap-open[^\n]*\.dev-card-status \{ display: none/.test(CSS),
    'hiding it would take voting away from an opened proposal');
});

test('a theme head counts its people AND how much is still open in it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }]);
  const html = workshopHtml(AppView);
  // Two issues open + one proposal in review = 3. The merge is NOT counted:
  // the number answers "how much is left in here", and shipped work is not.
  assert.match(
    html,
    /<span class="dev-ws-stat"><b>\d+<\/b>(?:person|people)<\/span><span class="dev-ws-stat"><b>3<\/b>items<\/span>/,
    'people and items, side by side',
  );
  assert.match(CSS, /\.dev-ws-stat \+ \.dev-ws-stat \{[^}]*border-left:/, 'divided by a hairline');
});

test('a theme wears the glyph the model chose, or its initial when there is none', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', icon: '🎮', items: ['issue:12'] }]);
  assert.match(workshopHtml(AppView), /<span class="dev-ws-theme-icon" aria-hidden="true">🎮<\/span>Game Corner/);

  // A row written before icons existed, or an answer the sanitiser rejected:
  // the initial on the name's own swatch, which reads as chosen where a
  // hashed-from-the-name emoji would be stable and meaningless.
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', items: ['issue:12'] }]);
  assert.match(
    workshopHtml(AppView),
    /class="dev-ws-theme-icon dev-ws-theme-icon-letter"[^>]*>G<\/span>Game Corner/,
  );
});

test('"Shipped this week" opens folded, so a theme opens on what still needs someone', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }]);
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-lane="shipped"/, 'the lane is still drawn — the fold is not a removal');
  assert.match(html, /<h4 class="dev-ws-lane-title" role="button" tabindex="0" aria-expanded="false">/,
    'and it is a disclosure, closed');
  assert.ok(!html.includes('Landed thing'),
    'the merge it holds is not in the DOM until someone opens the lane');
  assert.match(html, /<span class="dev-ws-lane-n">1<\/span>/,
    'but the count rides in the heading, so the fold never hides how much is in there');
  // Every other lane is unaffected.
  assert.match(html, /data-ws-lane="open"[\s\S]{0,400}?class="dev-ws-row"/);
});

// ── #1787: a filter changed ON THE WORKSHOP has to stick ─────────────
//
// Both halves of a filter change — persist it, and tell the bar what it now
// says — used to sit inside `_repaintKanbanBoard`, which the Workshop never
// reaches. So on this surface a filter was a scratch value: nothing saved it,
// the next `_repaintDevBody` reloaded the stored set over it, and the chip row
// never moved, so a chip's × widened the themes and stayed on screen.

test('a filter set on the Workshop is persisted, and clearing it is persisted too', () => {
  const store = {};
  const AppView = makeAppView({ sessionStore: store });
  seed(AppView);
  assert.equal(AppView._getViewMode(), 'workshop', 'the Workshop is the default surface');

  AppView._kanbanFilters.priority = 'high';
  AppView._repaintBoardSurface();
  assert.equal(AppView._loadKanbanFilters('demo-app').priority, 'high',
    'the Workshop path saves — _repaintKanbanBoard is not the only funnel');

  AppView._dismissKanbanFilter('priority');
  assert.equal(AppView._loadKanbanFilters('demo-app').priority, null,
    'and the clear is saved, so the next repaint cannot put it back');
});

test('the Workshop republishes the filter bar, so a chip\'s × actually clears the chip', () => {
  const AppView = makeAppView({
    document: {
      getElementById: (id) => (id === 'dev-kanban-filterbar' ? {} : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
  });
  seed(AppView);
  const published = [];
  AppView._publishKanbanFilters = (v) => published.push(plain(v));

  AppView._kanbanFilters.priority = 'high';
  AppView._repaintBoardSurface();
  assert.equal(published.length, 1, 'the Workshop tells the bar a filter went on');
  assert.equal(published[0].count, 1);

  AppView._dismissKanbanFilter('priority');
  assert.equal(published.length, 2);
  assert.equal(published[1].count, 0, 'and that it came back off');
  assert.deepEqual(published[1].chips, [], 'the chip row is emptied, not left showing a dead chip');
});

test('the Workshop restores the stored filters on an app switch, not on every repaint', () => {
  const AppView = makeAppView();
  // The slug the in-memory set belongs to is what tells a repaint apart from
  // an app switch. Unguarded, `_repaintDevBody` reloaded on every paint and
  // discarded whatever the viewer had just done here.
  assert.equal(AppView._kanbanFiltersSlug, null, 'nothing loaded yet');
  const branch = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('<div id="dev-workshop"></div>'));
  assert.match(branch.slice(0, branch.indexOf('_rerenderWorkshop();')),
    /if \(AppView\._kanbanFiltersSlug !== App\.currentApp\) \{\s*\n\s*AppView\._kanbanFilters = AppView\._loadKanbanFilters\(App\.currentApp\);/,
    'the reload is behind the slug guard');
});

test('the theme filter constrains sessions too, not just issues and proposals', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const f = { ...AppView._defaultKanbanFilters(), theme: 't' };
  // A session sits in a theme by the issue it links, exactly as the Workshop
  // places it. It used to return `true` before the theme check ran at all, so
  // with a theme selected every session matched every theme and a theme's
  // Underway lane showed other themes' work.
  assert.equal(AppView._devCardMatches('session', { id: 90, linked_issues: ['12'] }, f), true);
  assert.equal(AppView._devCardMatches('session', { id: 91, linked_issues: ['13'] }, f), false);
  assert.equal(AppView._devCardMatches('session', { id: 92, linked_issues: [] }, f), false);
  // Priority and category stay a no-op there — a session carries neither.
  const byPriority = { ...AppView._defaultKanbanFilters(), priority: 'high' };
  assert.equal(AppView._devCardMatches('session', { id: 93, linked_issues: [] }, byPriority), true);
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
  // INSIDE it, at the trailing edge — which is why the row is a div with the
  // button role and not a <button>.
  assert.match(html, /<div role="button" tabindex="0" class="dev-ws-row" aria-expanded="false" data-ws-row="vote:proposal:34"[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/,
    'a vote row is the folded row with the vote button inside it');
  assert.ok(!/<button[^>]*>[^<]*<button/.test(html), 'and no button nests in a button');
  assert.ok(!/data-ws-votes[\s\S]*?gc-vote-item/.test(html.slice(0, html.indexOf('data-ws-next'))),
    'and no full card in the strip');
  // "Open on Board" sits at the bottom of the theme, not under a lane.
  assert.match(html, /<div class="dev-ws-theme-more">[\s\S]*?Open on Board ›/);
  assert.ok(!/dev-ws-more[\s\S]{0,80}Open on Board/.test(html), 'no lane carries its own');
  assert.match(html, /data-ws-dashboard=""/, 'the dashboard, folded');
  assert.match(html, /data-discussion-row="1"/, 'the discussion row');
  assert.match(html, /data-ws-theme="t"/, 'the theme');
  assert.match(html, /Dark mode should stick\./, 'with its saying');
  // The first theme opens by default, and its rows are folded disclosures
  // that carry NO card-open hook — the delegated #dev-body handler must not
  // see one on the row.
  assert.match(html, /<div role="button" tabindex="0" class="dev-ws-row" aria-expanded="false" data-ws-row="issue:12"/);
  assert.ok(!/<div role="button"[^>]*data-issue-row/.test(html), 'the folded row is not an issue-row hook');
  assert.match(html, /data-ws-lane="review"/);
  assert.match(html, /data-ws-lane="shipped"/);
  assert.ok(!html.includes('dev-feed-entry'), 'nothing is unfolded on a plain paint');
  assert.match(html, /aria-pressed="true">By people</, 'the default order is by people');
});

test('the footnote says what is actually happening to the category grouping', () => {
  // The first cut said "once an AI model is available" while the model was
  // mid-draft — on exactly the first visit after a deploy. Four states now.
  const AppView = makeAppView();
  seed(AppView);
  const cat = (extra) => ({
    slug: 'demo-app', source: 'category', generatedAt: null, stale: true, pending: false, lastError: null,
    at: Date.now(), themes: [{ id: 'c', name: 'Uncategorised', description: '', saying: '', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }],
    ...extra,
  });
  AppView._workshopThemes = cat({ pending: true });
  let html = workshopHtml(AppView);
  assert.match(html, /drafting themes…/, 'pending on the category grouping says so in the eyebrow');
  assert.match(html, /Themes are being drafted from the board now\./);
  assert.ok(!html.includes('regrouping…'), 'and does not claim a regroup of themes that do not exist yet');

  AppView._workshopThemes = cat({ lastError: 'boom' });
  html = workshopHtml(AppView);
  assert.match(html, /The last attempt to draft themes failed \(boom\)\./);

  AppView._workshopThemes = cat({});
  html = workshopHtml(AppView);
  assert.match(html, /No AI model is configured, so items are grouped by their voted category\./);
  assert.ok(!html.includes('drafted once an AI model is available'), 'the misleading copy is gone');

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'placement', coverage: { total: 4, placed: 1, unplaced: 0, pending: 3 } });
  html = workshopHtml(AppView);
  assert.match(html, /placing new cards…/, 'pending placement on real themes says so');
  assert.match(html, /Themes were drafted \d+[hd] ago and are re-drafted daily, or sooner when a tenth of the board changes\. 3 new cards are being placed\./);
  // The name is preceded by the theme's glyph now (#1787); the pin is still
  // on the COPY, which is what these four states are about.
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Being placed<\/div>/);
  // The row's marker: the pseudo-theme is folded on a plain paint, so the
  // marker is pinned at the source, on the folded row.
  assert.match(WORKSHOP, /\{row\.placing \? <span className="dev-ws-placing"[^>]*>placing…<\/span> : null\}/);
  assert.match(CSS, /\.dev-ws-placing \{/);

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'discovery', unplaced: ['issue:13', 'session:34', 'session:78'], coverage: { total: 4, placed: 1, unplaced: 3, pending: 0 }, lastError: 'placement: boom' });
  html = workshopHtml(AppView);
  assert.match(html, /re-drafting themes…/, 'a pending discovery on real themes is a re-draft');
  assert.match(html, /3 cards did not fit a theme and wait for the next draft\. The last attempt failed \(placement: boom\); it is retried shortly\./);
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Not yet grouped<\/div>/);
  assert.ok(!html.includes('dev-ws-placing'), 'declined cards wear no marker');
});

test('a workshop_update over the WS re-fetches past the throttle, for the open app only', async () => {
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'ai', pending: false, coverage: { total: 0, placed: 0, unplaced: 0, pending: 0 }, unplaced: [] }) }; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1, 'a fresh answer is not re-fetched inside the throttle');
  AppView.applyWorkshopUpdate({ appSlug: 'other-app', stage: 'placement' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'another app\'s grouping is not this page\'s');
  AppView.applyWorkshopUpdate({ appSlug: 'demo-app', stage: 'placement' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, 'the server wrote a grouping: fetch it now');
  assert.deepEqual(plain(AppView._workshopThemes.coverage), { total: 0, placed: 0, unplaced: 0, pending: 0 });
  // And the WS dispatch reaches it.
  const APP_SRC = read('public/js/app.js');
  assert.match(APP_SRC, /case 'workshop_update':\s*App\.handleWorkshopUpdate\(data\);/);
  assert.match(APP_SRC, /AppView\.applyWorkshopUpdate\(data\)/);
  const WS_SRC = read('src/services/ws.js');
  assert.match(WS_SRC, /function pushWorkshopUpdate\(data\) \{\s*broadcastGlobalScoped\(\{ type: 'workshop_update'/);
  assert.match(WS_SRC, /function pushSessionUpdate\(data\) \{[\s\S]*?noteBoardChange\(data\);\s*\}/, 'a session change reaches the board listeners');
  assert.match(WS_SRC, /function pushIssueUpdate\(data\) \{[\s\S]*?noteBoardChange\(data\);\s*\}/, 'and so does an issue change');
});

test('the theme poll follows a widening schedule that outlasts a full draft, then stops', async () => {
  // Haiku takes tens of seconds on a full board; four polls six seconds apart
  // gave up first and left the category grouping in place until the next
  // navigation.
  const total = AppView_pollTotal();
  assert.ok(total >= 120000, `the schedule must cover well over a minute, got ${total}ms`);
  assert.ok(total <= 5 * 60000, 'and stop within a few minutes');
  assert.match(APP_VIEW_SRC, /n < AppView\.WORKSHOP_POLL_MS\.length/, 'the poll count is the schedule length');
  assert.match(APP_VIEW_SRC, /AppView\.WORKSHOP_POLL_MS\[n\]/, 'and each wait reads its slot');

  const timers = [];
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: true, lastError: 'boom' }) }; },
    // Capture the scheduled waits instead of sleeping through them.
    setTimeout: (_fn, ms) => { timers.push(ms); return 0; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  assert.equal(AppView._workshopThemes.lastError, 'boom', 'the failure reason is carried');
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0]]);
  AppView._workshopThemes = null;
  await AppView._loadWorkshopThemes('demo-app', AppView.WORKSHOP_POLL_MS.length);
  assert.equal(calls, 2);
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0]], 'past the schedule, no further poll');
});

test('a board reload during a draft joins the running poll chain instead of starting another', async () => {
  // Every WS-driven _loadDevFeed lands at attempt 0. While a draft is pending
  // and a re-fetch is already scheduled, that call must not fetch again or
  // schedule a second chain — the themes endpoint rebuilds the server's
  // input on every GET, which is what the per-slug throttle exists to bound.
  const timers = [];
  let calls = 0;
  let nextId = 1;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: true }) }; },
    setTimeout: (_fn, ms) => { timers.push(ms); return nextId++; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  assert.equal(timers.length, 1);
  await AppView._loadWorkshopThemes('demo-app', 0);
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1, 'the reloads did not fetch again');
  assert.equal(timers.length, 1, 'and scheduled nothing');
  // The chain itself advances: the scheduled step clears the timer first.
  AppView._workshopPollTimer = null;
  await AppView._loadWorkshopThemes('demo-app', 1);
  assert.equal(calls, 2);
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0], AppView.WORKSHOP_POLL_MS[1]]);
  // A different app is never held back by this one's chain.
  AppView._workshopThemes = { ...AppView._workshopThemes, slug: 'other-app' };
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 3);
});

function AppView_pollTotal() {
  const m = APP_VIEW_SRC.match(/WORKSHOP_POLL_MS:\s*\[([^\]]+)\]/);
  assert.ok(m, 'WORKSHOP_POLL_MS is a literal array');
  return m[1].split(',').map((x) => parseInt(x.trim(), 10)).reduce((a, b) => a + b, 0);
}

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
  assert.ok(themesCheck && /\.dev-ws-row\[role="button"\]\[aria-expanded\]/.test(themesCheck.expectSelector));
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

// A check that names ONE card's text cannot ride the lander's route.
// ThemeCard draws its lanes only while it is unfolded, and DevWorkshop
// unfolds exactly the first theme, so at most a quarter of the board's cards
// are in the DOM here. Which quarter is not fixed either: the staging demo
// grouping deals the real items round-robin into four themes
// (services/workshop-themes.js) and sortThemes puts whichever of them has the
// most distinct people first, both of which move as the board moves.
//
// So such a check passes or fails by the hour rather than by the diff. #1704
// moved thirty-seven board-card checks onto #app/<slug>/board for exactly
// this reason and left five behind; two of them ("Shared demo session renders
// in the In progress area" and "Shared session cards show the owner
// subtitle") passed on #1704 and #1709 and were red on #1623 and #1710 with
// the same manifest. The Board's In-progress column renders every card, which
// is what all five names describe.
test('no declared check asserts a card\'s text at the lander\'s own route', () => {
  const lander = /^\/\?demo=1#app\/[\w-]+\/(dev|workshop)$/;
  const offenders = dapp.tests
    .filter((t) => lander.test(t.path) && t.expectText && !t.expectSelector)
    .map((t) => `${t.name} (${t.path})`);
  assert.deepEqual(offenders, [],
    'these assert one card\'s text where only the first theme\'s rows render — address the Board route');
});
