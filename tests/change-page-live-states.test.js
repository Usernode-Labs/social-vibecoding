'use strict';

// #6016 (item 1): an open change page, driven through the events it receives
// as it goes from checks passed to live, and through a failed release.
//
// The real public/js/merge-status.js, app-view.js and app.js run together in
// one vm context, as the shell loads them, and every event goes in through
// the App handler the socket calls (handleSessionEvent, handleVoteUpdate,
// handleSessionUpdate, handleAppRedeployStatus, handleAppVersionChanged).
// Two things are replaced, and only at the network edge:
//   - the board's read (AppView._loadDevData) copies the fake server's rows
//     into the board's lists, as the real read would;
//   - `fetch` answers the change page's own read of its row.
// The page is topic-head.tsx's ChangeDetail: it opens on what the real
// _renderTopicHead publishes, and takes each event through the component's
// own rules (frontend/src/features/dev-board/topic/change-detail-refresh.ts).
// What it shows is the real `_topicViewFor` over the row it holds, drawn by
// the real ChangeBar (the status pill) and ChangeThreadHead (Votes, Testing).
//
// #5933 is the case where the event that moved the change does not name it:
// a release names the app, and a board reload for another change names that
// change. Before its fix (e3c2c07dc) the page stayed on "going live" until it
// was reopened.
//
// Run with: node --test tests/change-page-live-states.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const { ChangeBar, ChangeThreadHead } = loadTsx('frontend/src/features/dev-board/topic/change-head.tsx');
const refreshRules = loadTsx('frontend/src/features/dev-board/topic/change-detail-refresh.ts');

const ROOT = path.join(__dirname, '..');
const SLUG = 'demo';
const ID = 42;
const OTHER = 7;

const row = (patch = {}) => ({
  id: ID, app_slug: SLUG, user_id: 9, username: 'ada', session_title: 'Bigger buttons',
  status: 'promoted', pr_number: 12, created_at: '2026-10-28T09:00:00Z',
  check_state: 'pending', check_phase: 'preview', checks_checked_at: '2026-10-28T10:00:00Z',
  yes_count: 1, no_count: 0, majority: 1, deployment_kind: 'child', deployment_state: null, live_at: null,
  ...patch,
});

function harness({ place = 'panel' } = {}) {
  // The fake server: the rows as the database has them now.
  const server = {
    rows: new Map([[ID, row()], [OTHER, row({ id: OTHER, session_title: 'Other change', check_state: 'passing' })]]),
    set(id, patch) { this.rows.set(id, { ...this.rows.get(id), ...patch }); },
    copy(id) { return JSON.parse(JSON.stringify(this.rows.get(id))); },
  };
  const listeners = new Map();
  const noop = () => {};
  const el = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: noop, querySelectorAll: () => [], querySelector: () => null,
  });
  const c = {
    console: { log: noop, warn: noop, error: noop, debug: noop, info: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams,
    location: { search: '', hash: `#app/${SLUG}/dev`, pathname: '/', href: 'http://localhost/' },
    history: { replaceState: noop, pushState: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    WebSocket: function WebSocketStub() {},
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    document: {
      hidden: false, visibilityState: 'visible',
      // The thread panel's host, so the real _renderTopicHead publishes.
      getElementById: (id) => (id === 'gc-thread-head' ? el() : null),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop, createElement: el,
      body: el(), documentElement: el(),
    },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener: noop,
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    PlatformI18n: englishPlatformI18n(),
    PlatformUI: { toast: noop },
    DevChat: { currentSession: null, sessions: [], refreshCurrentSessionStatus: noop },
    Home: { load: noop, updateAppCardPill: noop },
    // The React side the head publishes to. Its own rendering is not under
    // test here; the page's view model is.
    UsernodeReact: { devBoard: { mountTopicHead: noop, publishTopicHead: noop, publishAiEnabled: noop } },
    // The change page's own read of its row (AppView._readTopicRow's and
    // readChangeDetail's address), and an empty answer for anything else.
    fetch: async (url) => {
      const m = /\/api\/apps\/[^/]+\/proposals\/(\d+)/.exec(String(url));
      const body = m && server.rows.has(Number(m[1])) ? { proposal: server.copy(Number(m[1])) } : {};
      return { ok: true, status: 200, json: async () => body };
    },
  };
  c.window = c;
  c.globalThis = c;
  vm.createContext(c);
  for (const file of ['public/js/merge-status.js', 'public/js/app-view.js', 'public/js/app.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), c, { filename: file });
  }
  const { App, AppView } = vm.runInContext('({ App, AppView })', c);

  App.user = { id: 1, username: 'viewer' };
  App.currentApp = SLUG;
  App.currentTab = 'dev';
  App.currentSubTab = place === 'page' ? 'topic' : 'forum';
  App.LIVE_REFRESH_MS = 0;
  AppView.appData = { slug: SLUG };
  AppView._devTopic = { kind: 'proposal', id: ID };
  AppView._devTopicInPanel = place === 'panel';
  // Network edge: the vote roster and the AI switch are reads of their own.
  AppView._loadVoteRoster = async () => {};
  AppView._ensureAiAvailability = async () => true;
  // The board's read: what the server holds now, sorted into the lists the
  // real read fills (open proposals, and the Completed list).
  AppView._loadDevData = async () => {
    const rows = [...server.rows.keys()].map((id) => server.copy(id));
    AppView._proposals = rows.filter((r) => r.status === 'promoted' || r.status === 'merging');
    AppView._merged = rows.filter((r) => r.status === 'merged');
    AppView._mySessions = [];
    AppView._sharedSessions = [];
    AppView._ghIssues = [];
    AppView._devDataReady = true;
    AppView._devDataSlug = SLUG;
    return true;
  };

  // The open page: topic-head.tsx's ChangeDetail. Its effect does not run
  // under a static render, so its parts run here as the effect runs them:
  //   - it mounts with the item the real _renderTopicHead publishes, and
  //     reads its own row;
  //   - it reads again when a publish changes that item's status (the
  //     effect's `item?.status` dependency);
  //   - each `change-detail-refresh` goes through the component's own
  //     changeDetailAsk / mergeChangePatch, and the row it shows is
  //     changeDetailRow (./change-detail-refresh.ts).
  const page = { item: null, loaded: null, events: [], pending: null, published: 0 };
  const readPage = async () => {
    const res = await c.fetch(`/api/apps/${SLUG}/proposals/${ID}`);
    page.loaded = (await res.json()).proposal;
  };
  c.UsernodeReact.devBoard.publishTopicHead = ({ item }) => {
    if (!item || Number(item.id) !== ID) return;
    page.published += 1;
    const before = page.item;
    page.item = item;
    if (!before || before.status !== item.status) page.pending = readPage();
  };
  c.addEventListener('change-detail-refresh', (event) => {
    page.events.push(event.detail);
    if (!page.item) return;
    const ask = refreshRules.changeDetailAsk(event.detail, page.item.id);
    if (!ask) return;
    if ('row' in ask) page.loaded = ask.row;
    else if ('patch' in ask) page.loaded = refreshRules.mergeChangePatch(page.loaded, page.item.id, ask.patch);
    else page.pending = readPage();
  });
  // What the reader sees: the real view code over the row the page holds,
  // drawn by the real ChangeBar (the status pill beside "Change #12") and
  // ChangeThreadHead (the Votes and Testing cards).
  const shows = () => {
    assert.ok(page.item, 'the head was published, so the page is open');
    const session = refreshRules.changeDetailRow(page.item, page.loaded);
    const { card, body } = AppView._topicViewFor('proposal', session);
    const bar = renderToHtml(createElement(ChangeBar, { v: body.thread, menuKey: '' }));
    const head = renderToHtml(createElement(ChangeThreadHead, {
      id: ID, card, body, v: body.thread, linkedIssues: [], onIssuesSaved: () => {},
    }));
    const pill = /data-change-status="([^"]+)"/.exec(bar);
    return { pill: pill ? pill[1] : null, bar, head };
  };
  // Lets every burst, board read and page read that an event set off land.
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (page.pending) { const p = page.pending; page.pending = null; await p; }
    }
  };
  const open = async () => {
    await AppView._loadDevData();
    AppView._renderTopicHead();
    await settle();
    // The first board reload after opening records where the page is.
    AppView.refreshDevData('session');
    await settle();
    page.events.length = 0;
  };
  return { App, AppView, server, page, shows, settle, open };
}

const m = (id) => message(id);
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The pill beside the title (its state key and its words) and the words the
// Votes and Testing cards carry, as rendered.
function assertShows(h, { pill, label, says = [], not = [] }, why) {
  const { pill: key, bar, head } = h.shows();
  assert.equal(key, pill, why);
  if (label) assert.match(bar, new RegExp(`>${esc(label)}<`), why);
  for (const words of says) assert.match(head, new RegExp(esc(words)), why);
  for (const words of not) assert.doesNotMatch(head, new RegExp(esc(words)), why);
}

const PASSED = 'changes:page.testing.figure.passed';
const GOING = 'changes:page.votes.note.goingLive';
const LIVE = 'changes:page.votes.note.live';
const FAILED = 'changes:page.votes.note.failed';

for (const place of ['panel', 'page']) {
  const where = place === 'panel' ? 'in the Workshop panel' : 'on its own page';

  test(`a change ${where} moves from checks passed to live without being reopened`, async () => {
    const h = harness({ place });
    await h.open();
    assert.ok(h.page.published >= 1, 'the real _renderTopicHead published the head');
    assertShows(h, { pill: h.AppView.statusPillState(h.page.loaded, {}).key, not: [m(PASSED)] }, 'checks still running');

    // Checks passed: the verdict names the change.
    h.server.set(ID, { check_state: 'passing', check_phase: null, checks_checked_at: '2026-10-28T10:04:00Z' });
    h.App.handleSessionEvent({ event: 'checks_ready', sessionId: ID, checkState: 'passing' });
    await h.settle();
    const waiting = h.AppView.statusPillState(h.page.loaded, {});
    assert.notEqual(waiting.key, 'deploying');
    assertShows(h, { pill: waiting.key, label: waiting.label, says: [m(PASSED)] }, 'checks passed');

    // Merging: the vote that carried it.
    h.server.set(ID, { status: 'merging', yes_count: 2 });
    h.App.handleVoteUpdate({ sessionId: ID, appSlug: SLUG });
    await h.settle();
    const merging = h.AppView.statusPillState(h.page.loaded, {});
    assert.equal(h.page.loaded.status, 'merging');
    assertShows(h, { pill: merging.key, label: merging.label, says: [m(GOING)] }, 'merging');

    // Merged, going live: the merge, then the release starting.
    h.server.set(ID, { status: 'merged', deployment_state: 'deploying', live_at: null });
    h.App.handleVoteUpdate({ sessionId: ID, appSlug: SLUG, merged: true });
    h.App.handleAppRedeployStatus({ appSlug: SLUG, deploying: true });
    await h.settle();
    assertShows(h, { pill: 'deploying', label: m('changes:badge.pill.goingLive'), says: [m(GOING)] }, 'going live');

    // Live (#5933): the release ends. Neither event names the change.
    h.server.set(ID, { deployment_state: 'deployed', live_at: '2026-10-28T10:09:00Z' });
    h.App.handleAppRedeployStatus({ appSlug: SLUG, deploying: false });
    h.App.handleAppVersionChanged({ appSlug: SLUG, sha: 'abc1234' });
    await h.settle();
    assertShows(h, { pill: 'deployed', label: m('changes:badge.pill.live'), says: [m(LIVE)], not: [m(GOING)] },
      'the page says live without being reopened (#5933)');
  });

  test(`a failed release ${where} says it couldn't go live`, async () => {
    const h = harness({ place });
    h.server.set(ID, { status: 'merged', check_state: 'passing', deployment_state: 'deploying' });
    await h.open();
    assertShows(h, { pill: 'deploying', label: m('changes:badge.pill.goingLive'), says: [m(GOING)] });

    h.server.set(ID, { deployment_state: 'failed' });
    h.App.handleAppRedeployStatus({ appSlug: SLUG, deploying: false, failed: true });
    await h.settle();
    assertShows(h, { pill: 'delivery_failed', label: m('changes:badge.pill.failed'), says: [m(FAILED)], not: [m(GOING)] },
      'the failed release reaches the page');
  });

  test(`another app's release leaves a change ${where} as it was`, async () => {
    const h = harness({ place });
    h.server.set(ID, { status: 'merged', check_state: 'passing', deployment_state: 'deploying' });
    await h.open();
    h.server.set(ID, { deployment_state: 'deployed', live_at: '2026-10-28T10:09:00Z' });
    h.App.handleAppRedeployStatus({ appSlug: 'other', deploying: false });
    h.App.handleAppVersionChanged({ appSlug: 'other', sha: 'abc1234' });
    await h.settle();
    assertShows(h, { pill: 'deploying', says: [m(GOING)] });
    assert.deepEqual([...h.page.events], []);
  });
}

test('a board reload about another change moves the open change in the Workshop panel (#5933)', async () => {
  const h = harness({ place: 'panel' });
  h.server.set(ID, { check_state: 'passing' });
  await h.open();
  assert.notEqual(h.shows().pill, 'deploying');

  // The change merged and is going live, and the only event is about change
  // 7: the board reloads whole, and nothing names change 42.
  h.server.set(ID, { status: 'merged', deployment_state: 'deploying', live_at: null });
  h.App.handleSessionUpdate({ sessionId: OTHER, appSlug: SLUG, action: 'updated' });
  await h.settle();
  assertShows(h, { pill: 'deploying', label: m('changes:badge.pill.goingLive'), says: [m(GOING)] },
    'the page moves with the board (#5933)');
  assert.equal(h.page.events.filter((e) => e && typeof e === 'object' && e.id === ID).length, 1,
    'exactly one patch reaches the page');

  // It went live, and again the reload is about change 7. Its status stays
  // merged, so the page does not re-read: only the board's patch moves it.
  h.page.events.length = 0;
  h.server.set(ID, { deployment_state: 'deployed', live_at: '2026-10-28T10:09:00Z' });
  h.App.handleSessionUpdate({ sessionId: OTHER, appSlug: SLUG, action: 'updated' });
  await h.settle();
  assertShows(h, { pill: 'deployed', label: m('changes:badge.pill.live'), says: [m(LIVE)], not: [m(GOING)] },
    'the board\'s patch carries it to live (#5933)');

  // A second reload with nothing moved tells the page nothing.
  h.page.events.length = 0;
  h.App.handleSessionUpdate({ sessionId: OTHER, appSlug: SLUG, action: 'updated' });
  await h.settle();
  assert.deepEqual(h.page.events.filter((e) => e !== OTHER), []);
});
