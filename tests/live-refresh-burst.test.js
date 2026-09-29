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

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  const end = src.indexOf(close, start);
  return src.slice(start + 1, end + close.length);
}

// The coalescer's members, run against stand-ins for AppView, Home and the
// window, in a sandbox with a clock the test drives.
function harness({ currentApp = 'demo', currentTab = 'dev', homeVisible = false } = {}) {
  const timers = [];
  const refreshes = [];
  const told = [];
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
    },
    Home: { load: () => { homeLoads += 1; } },
    Improve: { onSessionStateChanged: () => { drawer += 1; } },
    document: {
      getElementById: (id) => (id === 'home-screen'
        ? { classList: { contains: (c) => c === 'hidden' && !homeVisible } } : null),
    },
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = (e) => told.push(e.detail);
  vm.createContext(sandbox);
  vm.runInContext(`var App = { currentApp: ${JSON.stringify(currentApp)}, currentTab: ${JSON.stringify(currentTab)},\n${members}\n};\nglobalThis.__App = App;`, sandbox);
  const App = sandbox.__App;
  const flush = () => { const due = timers.splice(0); due.forEach((t) => t.fn()); };
  const runLast = () => { const t = timers.pop(); t.fn(); };
  return { App, sandbox, refreshes, told, flush, runLast, timers, homeLoads: () => homeLoads, drawer: () => drawer };
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
  assert.match(APP_JS, /case 'board_order_update':[\s\S]{0,600}?App\._liveRefresh\('board-order'[^\n]*\n\s*break;/);
});
