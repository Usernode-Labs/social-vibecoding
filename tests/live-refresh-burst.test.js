'use strict';

// One refresh per burst of live events (App._liveRefresh in public/js/app.js).
//
// A single vote used to reload the whole Workshop about four times in two
// seconds: the voter's own POST, the vote_update it broadcasts, the
// session_update beside it and the checks events after a head move each
// started nine requests, and each repaint moved rows under the reader. Every
// socket-driven refresh now joins a short window and one refresh runs at its
// end, naming every row the burst was about.
//
// Run with: node --test tests/live-refresh-burst.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const APP_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  const end = src.indexOf(close, start);
  return src.slice(start + 1, end + close.length);
}

// The coalescer's members, run against stand-ins for AppView, Home and the
// window, in a sandbox with a clock the test drives.
function harness({ currentApp = 'demo', currentTab = 'dev', homeVisible = false,
  chatSlug = null, voteHost = false } = {}) {
  const timers = [];
  const refreshes = [];
  const told = [];
  const voteReads = [];
  const voteControlRefreshes = [];
  const shown = [];
  const toasts = [];
  let homeLoads = 0;
  let drawer = 0;
  const members = [
    'LIVE_REFRESH_MS: 150,',
    '_liveBurst: null,',
    sliceMember(APP_JS, '_liveRefresh(kind, sessionIds, opts = {}) {'),
    sliceMember(APP_JS, '_flushLiveRefresh(b) {'),
    'HOME_LIVE_MIN_GAP_MS: 4000,',
    '_homeLiveAt: 0,',
    '_homeLiveTimer: null,',
    sliceMember(APP_JS, '_refreshHomeLive() {'),
  ].join('\n');
  const sandbox = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    Date,
    Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    AppView: {
      _liveHandedOff: null,
      refreshDevData: (kind, live) => { refreshes.push({ kind, live }); return Promise.resolve(true); },
      // #6595: what is shown beside the Workshop (the bot tab's column, the
      // side panel, an item's own page) re-reads from the same burst.
      refreshShownTopic: (live) => { shown.push(live); return Promise.resolve(true); },
      // Calls back the way the real one patches the hosts, so a test can see
      // the tally repainted without the thread being remounted.
      loadVoteState: (slug) => {
        voteReads.push(slug);
        return Promise.resolve(true).then(() => {
          sandbox.GroupChat.refreshVoteControls();
          return { promoted: [], merged: [] };
        });
      },
    },
    GroupChat: {
      appSlug: chatSlug,
      mountCalls: 0,
      refreshVoteControls: () => { voteControlRefreshes.push(1); },
    },
    PlatformUI: { toast: (msg) => { toasts.push(msg); } },
    Home: { load: () => { homeLoads += 1; } },
    Improve: { onSessionStateChanged: () => { drawer += 1; } },
    document: {
      getElementById: (id) => (id === 'home-screen'
        ? { classList: { contains: (c) => c === 'hidden' && !homeVisible } } : null),
      querySelector: (sel) => (voteHost && /data-vote-session/.test(sel)
        ? { getAttribute: () => null } : null),
    },
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = (e) => told.push(e.detail);
  vm.createContext(sandbox);
  vm.runInContext(`var App = { currentApp: ${JSON.stringify(currentApp)}, currentTab: ${JSON.stringify(currentTab)},\n${members}\n};\nglobalThis.__App = App;`, sandbox);
  const App = sandbox.__App;
  const flush = () => { const due = timers.splice(0); due.forEach((t) => t.fn()); };
  const runLast = () => { const t = timers.pop(); t.fn(); };
  return {
    App, sandbox, refreshes, told, flush, runLast, timers, voteReads, voteControlRefreshes, toasts, shown,
    homeLoads: () => homeLoads, drawer: () => drawer,
  };
}

test('a vote, its broadcast and the session event beside it are ONE refresh', async () => {
  const h = harness();
  const post = h.App._liveRefresh('vote', 7, { appSlug: 'demo' });
  const ws = h.App._liveRefresh('vote', 7, { appSlug: 'demo', merged: false, home: true });
  const upd = h.App._liveRefresh('session', 7, { appSlug: 'demo', home: true });
  assert.equal(post, ws, 'every event in the window shares the one promise');
  assert.equal(ws, upd);
  assert.equal(h.refreshes.length, 0, 'nothing runs until the window closes');
  assert.equal(h.timers.length, 1, 'one window, not one per event');
  h.flush();
  assert.equal(h.refreshes.length, 1);
  const { kind, live } = h.refreshes[0];
  assert.equal(kind, 'vote', 'a vote in the burst makes it a vote refresh, which reads past the write');
  assert.deepEqual([...live.kinds].sort(), ['session', 'vote']);
  assert.deepEqual([...live.ids], [7]);
  assert.equal(await post, true, 'castVote hears when the read landed');
  assert.deepEqual(h.told, [7], 'a change page showing row 7 re-reads it once');
  assert.equal(h.drawer(), 1, 'the work drawer refreshes once');
});

test('another app\'s events never reload this app\'s Workshop', () => {
  const h = harness();
  h.App._liveRefresh('vote', 3, { appSlug: 'other', home: true });
  h.flush();
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.drawer(), 1, 'the drawer still tracks the viewer\'s work everywhere');
});

test('an event that names no row makes the whole-board refresh', () => {
  const h = harness();
  h.App._liveRefresh('issue', null, { appSlug: 'demo' });
  h.App._liveRefresh('vote', 7, { appSlug: 'demo' });
  h.flush();
  assert.equal(h.refreshes[0].live.ids, null, 'no row list: the board decides it is everything');
});

test('the topic page takes its own row; the burst does not ask it to re-read twice', () => {
  const h = harness();
  h.sandbox.AppView.refreshDevData = () => { h.sandbox.AppView._liveHandedOff = new Set([7]); return Promise.resolve(true); };
  h.App._liveRefresh('vote', [7, 8], { appSlug: 'demo' });
  h.flush();
  assert.deepEqual(h.told, [8], 'row 7 was handed to its page; only row 8 is re-read');
  assert.equal(h.sandbox.AppView._liveHandedOff, null);
});

test('Home re-reads its grid at most once every few seconds, keeping the last', () => {
  const h = harness({ homeVisible: true });
  h.App._liveRefresh('vote', 1, { appSlug: 'x', home: true });
  h.flush();
  assert.equal(h.homeLoads(), 1);
  h.App._liveRefresh('vote', 2, { appSlug: 'x', home: true });
  h.runLast();
  assert.equal(h.homeLoads(), 1, 'inside the gap: the reload waits it out');
  assert.equal(h.timers.length, 1, 'on one trailing timer');
  h.App._liveRefresh('vote', 3, { appSlug: 'x', home: true });
  h.runLast();
  assert.equal(h.timers.length, 1, 'a later burst joins that timer rather than adding one');
  h.flush();
  assert.equal(h.homeLoads(), 2, 'and the grid is read once for both');
});

test('Home is not reloaded while it is not on screen', () => {
  const h = harness({ homeVisible: false });
  h.App._liveRefresh('vote', 1, { appSlug: 'demo', home: true, merged: true });
  h.flush();
  assert.equal(h.homeLoads(), 0, 'a merge on the Workshop no longer pulls the whole app list');
});

test('the socket handlers route through the burst', () => {
  const block = (sig) => sliceMember(APP_JS, sig).replace(/^\s*\/\/.*$/gm, '');
  assert.match(block('handleVoteUpdate(data) {'), /App\._liveRefresh\('vote', data\.sessionId/);
  assert.doesNotMatch(block('handleVoteUpdate(data) {'), /Home\.load\(\)/, 'no unconditional app-list reload on a merge');
  assert.match(block('handleSessionUpdate(data) {'), /App\._liveRefresh\('session', data\.sessionId/);
  assert.match(block('handleSessionState(data) {'), /App\._liveRefresh\('session', data\.sessionId/);
  assert.match(block('handleIssueUpdate(data) {'), /App\._liveRefresh\('issue'/);
  assert.match(block('handleIssueUpdate(data) {'), /issueNumber: data\.issueNumber/,
    '#6595: an update that names its request lets a shown one tell it apart');
  assert.match(APP_JS, /case 'board_order_update':[\s\S]{0,600}?App\._liveRefresh\('board-order'[^\n]*\n\s*break;/);
  assert.match(APP_JS, /case 'work_state':[\s\S]{0,900}?App\._liveRefresh\('work', data\.item\?\.sessionId \?\? null, \{[\s\S]{0,200}?issueNumber: data\.item\?\.issueNumber[\s\S]{0,80}?dev: false/,
    '#6595: a work state names the item whose stage moved, without asking the Workshop');
});

// #6595: a request or a change open on the Homeroom bot page (or in the side
// panel) is not on App.currentApp, so the dev refresh returns at once. The
// burst still carries the project it was about, and the shown topic re-reads
// itself from that.
test('#6595: an issue update for a project that is not App.currentApp reaches what is shown', () => {
  const h = harness({ currentApp: null, currentTab: 'homeroom-bot' });
  h.App._liveRefresh('issue', null, { appSlug: 'other' });
  assert.equal(h.shown.length, 0, 'nothing runs until the window closes');
  h.flush();
  assert.equal(h.refreshes.length, 0, 'the Workshop is not this project');
  assert.equal(h.shown.length, 1, 'the shown topic heard the burst');
  assert.deepEqual([...h.shown[0].slugs], ['other'], 'every project the burst named, whatever currentApp says');
  assert.equal(h.shown[0].unnamed, true, 'a close vote names no request number');
  assert.equal(h.shown[0].devRead, false, 'the dev refresh read nothing, so the shown row is not skipped');
});

test('#6595: a burst of events about another project is one shown-topic call', () => {
  const h = harness({ currentApp: null, currentTab: 'homeroom-bot' });
  h.App._liveRefresh('issue', null, { appSlug: 'other' });
  h.App._liveRefresh('vote', 7, { appSlug: 'other' });
  h.App._liveRefresh('work', null, { appSlug: 'other', issueNumber: 6580, dev: false });
  h.flush();
  assert.equal(h.shown.length, 1, 'one read for the burst');
  assert.deepEqual([...h.shown[0].slugs], ['other']);
  assert.deepEqual([...h.shown[0].numbers], [6580], 'the request numbers the burst named travel with it');
});

test('#6595: a work state routes through the burst without asking the Workshop', () => {
  const h = harness({ currentApp: 'demo', currentTab: 'dev' });
  h.App._liveRefresh('work', null, { appSlug: 'other', issueNumber: 3, dev: false });
  h.flush();
  assert.equal(h.refreshes.length, 0, 'dev: false means no board read');
  assert.equal(h.shown.length, 1, 'but what is shown still hears it');
});

test('#6595: an own write joins the same gathered burst', async () => {
  const h = harness({ currentApp: null, currentTab: 'homeroom-bot' });
  const post = h.App._liveRefresh('issue', null, { appSlug: 'other', issueNumber: 6580 });
  const ws = h.App._liveRefresh('issue', null, { appSlug: 'other', issueNumber: 6580 });
  assert.equal(post, ws, 'the POST and its broadcast share one read');
  h.flush();
  assert.equal(h.shown.length, 1);
  await post;
  assert.equal(h.shown.length, 1, 'settled after the shown read landed');
});

test('#6595: claim, release and a decision vote re-read the view they were made from', () => {
  const fn = (head) => {
    const at = APP_VIEW.indexOf(head);
    assert.ok(at > -1, `${head.trim()} is found`);
    return APP_VIEW.slice(at, APP_VIEW.indexOf('\n  },\n', at));
  };
  for (const [head, issue] of [
    ['  async markIssueInProgress(issueNumber) {', /App\._liveRefresh\('issue', null, \{ appSlug: slug, issueNumber \}\)/],
    ['  async clearIssueClaim(issueNumber, userId) {', /App\._liveRefresh\('issue', null, \{ appSlug: slug, issueNumber \}\)/],
    ['  async castIssueVote(issueId, vote, opts = null) {', /App\._liveRefresh\('vote', null, \{ appSlug: [^\n]*issueNumber: targetN \}\)/],
  ]) {
    assert.match(fn(head), issue, head.trim());
  }
});

// #6109: the tally on a proposal's vote row in a chat thread follows other
// people's votes. The chat's own snapshot is re-read once per burst, only
// when a vote row for it is on screen, and quietly.
test('another person\'s vote moves the tally in an open chat thread, once', async () => {
  const h = harness({ currentTab: 'messages', chatSlug: 'demo', voteHost: true });
  const p = h.App._liveRefresh('vote', 7, { appSlug: 'demo', home: true });
  assert.deepEqual(h.voteReads, [], 'nothing is read until the window closes');
  h.flush();
  assert.deepEqual(h.voteReads, ['demo'], 'the mounted chat re-read its snapshot once');
  await p;
  assert.equal(h.voteControlRefreshes.length, 1, 'the vote row is repainted in place');
  assert.equal(h.sandbox.GroupChat.mountCalls, 0, 'the thread is not remounted');
  assert.deepEqual(h.toasts, [], 'and nothing pops up');
});

test('three votes inside one window cost one read', () => {
  const h = harness({ currentTab: 'messages', chatSlug: 'demo', voteHost: true });
  h.App._liveRefresh('vote', 7, { appSlug: 'demo' });
  h.App._liveRefresh('vote', 8, { appSlug: 'demo' });
  h.App._liveRefresh('vote', 9, { appSlug: 'demo', home: true });
  h.flush();
  assert.deepEqual(h.voteReads, ['demo']);
});

test('a vote on another app leaves the mounted chat alone', () => {
  const h = harness({ currentTab: 'messages', chatSlug: 'demo', voteHost: true });
  h.App._liveRefresh('vote', 7, { appSlug: 'other', home: true });
  h.flush();
  assert.deepEqual(h.voteReads, []);
});

test('no vote row on screen, or no chat, means no read', () => {
  const noHost = harness({ currentTab: 'messages', chatSlug: 'demo', voteHost: false });
  noHost.App._liveRefresh('vote', 7, { appSlug: 'demo', home: true });
  noHost.flush();
  assert.deepEqual(noHost.voteReads, []);

  const noChat = harness({ currentTab: 'messages', chatSlug: null, voteHost: true });
  noChat.App._liveRefresh('vote', 7, { appSlug: 'demo', home: true });
  noChat.flush();
  assert.deepEqual(noChat.voteReads, []);
});

test('the dev tab\'s own chat sub-tab is read by refreshDevData alone', () => {
  const h = harness({ currentTab: 'dev', currentApp: 'demo', chatSlug: 'demo', voteHost: true });
  h.App._liveRefresh('vote', 7, { appSlug: 'demo', home: true });
  h.flush();
  assert.equal(h.refreshes.length, 1, 'the dev refresh covers it');
  assert.deepEqual(h.voteReads, [], 'no second fetch');
});

test('a chat of another app than the dev tab shows is still read', () => {
  const h = harness({ currentTab: 'dev', currentApp: 'demo', chatSlug: 'other', voteHost: true });
  h.App._liveRefresh('vote', 7, { appSlug: 'other', home: true });
  h.flush();
  assert.deepEqual(h.voteReads, ['other'], 'the dev guard checks which app was refreshed');
});

test('the burst settles only after the chat read lands', async () => {
  const h = harness({ currentTab: 'messages', chatSlug: 'demo', voteHost: true });
  let release;
  h.sandbox.AppView.loadVoteState = () => new Promise((resolve) => { release = () => resolve(true); });
  const p = h.App._liveRefresh('vote', 7, { appSlug: 'demo' });
  h.flush();
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the read is still open, so the vote keeps its pending overlay');
  release();
  await p;
  assert.equal(settled, true);
});

// ── #6791: a whole-board live reload waits out a gap ────────────────────
//
// An idle hub paid eleven reads per live event: every kind that was not a
// vote or a check reloaded the whole board, with no gap. This runs
// `refreshDevData` on the AppView's own members, over a clock the test drives.

function boardHarness({ tab = 'dev', subTab = 'forum', slug = 'demo', ready = true } = {}) {
  const timers = [];
  const loads = [];
  const shakes = [];
  let now = 1_000_000;
  const sandbox = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    Date: { now: () => now },
    Promise,
    Set,
    App: {
      currentTab: tab,
      currentSubTab: subTab,
      _announceRefreshIntent: () => {},
    },
    AppView: {
      appData: { slug },
      _devDataReady: ready,
      _whereHeld: () => 'promoted',
      _loadDevData: (opts) => { loads.push(opts ? 'fresh' : 'plain'); return Promise.resolve(true); },
      _loadDevFeed: () => { loads.push('feed'); return Promise.resolve(true); },
      _refreshOpenChangeFromBoard: () => { shakes.push(1); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`Object.assign(AppView, {\n${
    [
      sliceMember(APP_VIEW, 'refreshDevData(kind, live = null) {'),
      'BOARD_FULL_MIN_GAP_MS: 5000,',
      '_boardFullAt: 0,',
      '_boardFullPending: null,',
      sliceMember(APP_VIEW, '_liveFullBoard(opts) {'),
      sliceMember(APP_VIEW, '_fullBoardLoad(opts) {'),
      sliceMember(APP_VIEW, '_partsForLive(live) {'),
    ].join('\n')
  }});`, sandbox);
  const runDue = () => {
    const due = timers.splice(0).filter((t) => !t.cleared);
    due.forEach((t) => t.fn());
  };
  return {
    App: sandbox.App, AppView: sandbox.AppView, timers, loads, shakes,
    advance: (ms) => { now += ms; },
    now: () => now,
    runDue,
  };
}

test('#6791: two whole-board live reloads inside 5 s are one now and one after the gap', async () => {
  const h = boardHarness();
  const first = h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  assert.deepEqual(h.loads, ['feed'], 'nothing before it: the first runs at once');
  await first;
  assert.deepEqual(h.shakes, [1], 'and repaints once');

  // A second burst 2 s later waits the rest of the gap out.
  h.advance(2000);
  let second = false;
  const waiting = h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  waiting.then(() => { second = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.loads.length, 1, 'inside the gap nothing loads');
  assert.equal(second, false, 'and the burst stays open');
  assert.equal(h.timers.length, 1, 'on one trailing timer');
  assert.equal(h.timers[0].ms, 3000, 'the rest of the 5 s gap');

  // A third burst joins that trailing run rather than adding a second.
  h.advance(1000);
  const third = h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  assert.equal(h.timers.length, 1, 'still one timer');
  h.advance(2000);
  h.runDue();
  await waiting;
  await third;
  assert.deepEqual(h.loads, ['feed', 'feed'], 'one trailing load for both');
  assert.equal(h.shakes.length, 2);
  assert.equal(h.AppView._boardFullPending, null, 'and nothing left waiting');
});

test('#6791: a live burst marked fresh runs its trailing load past the write', async () => {
  const h = boardHarness();
  await h.AppView.refreshDevData('vote', { kinds: new Set(['vote']), ids: null });
  h.advance(1000);
  const waiting = h.AppView.refreshDevData('vote', { kinds: new Set(['vote']), ids: null });
  h.advance(5000);
  h.runDue();
  await waiting;
  assert.deepEqual(h.loads, ['fresh', 'feed', 'fresh', 'feed'],
    'a vote reads past the write, now and when the gap is over');
});

test('#6791: a direct refresh runs at once and stands the waiting live run down', async () => {
  const h = boardHarness();
  await h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  h.advance(1000);
  let liveSettled = false;
  const live = h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  live.then(() => { liveSettled = true; });
  assert.equal(h.timers.length, 1, 'the live burst waits');
  // The viewer's own pull to refresh.
  const direct = h.AppView.refreshDevData('all');
  assert.deepEqual(h.loads, ['feed', 'feed'], 'it loads straight away');
  assert.equal(h.timers[0].cleared, true, 'and the waiting run is cancelled');
  h.runDue();
  assert.deepEqual(h.loads, ['feed', 'feed'], 'the trailing timer does nothing more');
  await direct;
  await live;
  assert.equal(liveSettled, true, 'the live burst hears the direct load landed');
});

test('#6791: a trailing run after the board is gone loads nothing', async () => {
  const h = boardHarness();
  await h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  h.advance(1000);
  const waiting = h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  h.App.currentSubTab = 'topic';
  h.advance(5000);
  h.runDue();
  assert.equal(await waiting, true, 'it settles without a read');
  assert.deepEqual(h.loads, ['feed'], 'and loads nothing behind the page now on screen');
});

test('#6791: partial kinds never wait out the gap', async () => {
  const h = boardHarness();
  await h.AppView.refreshDevData('other', { kinds: new Set(['other']), ids: null });
  h.advance(100);
  h.AppView._loadDevFeed = () => { h.loads.push('partial'); return Promise.resolve(true); };
  await h.AppView.refreshDevData('issue', { kinds: new Set(['issue']), ids: null });
  assert.deepEqual(h.loads, ['feed', 'partial'], 'a narrowed burst reads at once');
  assert.equal(h.timers.length, 0, 'and sets no timer');
});

