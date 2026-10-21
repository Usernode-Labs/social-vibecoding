'use strict';

// #5233: a proposal that has merged must leave the board's Waiting for
// approval column as soon as the merge lands, without a manual reload. The
// server's open-proposals list already excludes merged rows, so the
// lingering card is stale cache: App.handleVoteUpdate hands the WS event to
// AppView.noteSessionMerged, which patches the cached row's status and —
// while the board is not the surface showing — re-reads the board's
// proposals + merged parts in the background, so the row is under Done when
// the board next paints.
//
// The wiring test slices handleVoteUpdate out of app.js the way
// live-refresh-burst does; the helper's own behaviour runs the real
// app-view.js in a vm sandbox the way dev-kanban-buckets does.
//
// Run with: node --test tests/board-merged-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const APP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  const end = src.indexOf(close, start);
  return src.slice(start + 1, end + close.length);
}

// deepStrictEqual compares realm prototypes; the burst's args are built in
// the vm, so copy the values into host-realm arrays and objects first.
const normCall = (c) => [c[0], c[1], { ...c[2] }];

// ── handleVoteUpdate routes the merge to noteSessionMerged ─────────────────

function makeAppCtx({ currentTab = 'dev', currentSubTab = 'topic' } = {}) {
  const sandbox = {
    console,
    Promise,
    JSON,
    AppView: {
      noteSessionMerged: (id, slug) => { sandbox.nsmCalls.push([id, slug]); return true; },
      recheckFirstVersionNow: () => null,
      renderAppTab: () => {},
    },
    nsmCalls: [],
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `var calls = []; var App = { currentApp: 'demo', currentTab: ${JSON.stringify(currentTab)},`
    + ` currentSubTab: ${JSON.stringify(currentSubTab)}, _liveRefresh: (kind, ids, opts) => { calls.push([kind, ids, JSON.parse(JSON.stringify(opts))]); },\n`
    + `${sliceMember(APP_JS, 'handleVoteUpdate(data) {')}\n};`
    + 'globalThis.__App = App; globalThis.__calls = calls;',
    sandbox
  );
  return { App: sandbox.__App, calls: sandbox.__calls, nsmCalls: sandbox.nsmCalls };
}

test('handleVoteUpdate with merged: true hands the row to noteSessionMerged', () => {
  const h = makeAppCtx();
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo', merged: true });
  assert.deepEqual(h.nsmCalls, [[7, 'demo']],
    'the merge is patched before the burst refresh reads');
  assert.deepEqual(Array.from(h.calls, normCall), [['vote', 7, { appSlug: 'demo', merged: true, home: true }]],
    'the burst still runs as before');
});

test('the hand-off runs whatever tab is showing, and even when the app is not the current one', () => {
  for (const [currentTab, currentSubTab] of [['app', null], ['home', null], ['dev', 'forum']]) {
    const h = makeAppCtx({ currentTab, currentSubTab });
    h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'other', merged: true });
    assert.deepEqual(h.nsmCalls, [[7, 'other']], `${currentTab}/${currentSubTab}: helper still called`);
    assert.deepEqual(Array.from(h.calls, normCall), [['vote', 7, { appSlug: 'other', merged: true, home: true }]]);
  }
});

test('a vote without merged does not reach noteSessionMerged', () => {
  const h = makeAppCtx();
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo', merged: false });
  assert.deepEqual(h.nsmCalls, [], 'only merges patch the lists');
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo' });
  assert.deepEqual(h.nsmCalls, [], 'an event without the flag at all either');
});

// ── noteSessionMerged, against the real app-view.js ────────────────────────

function makeViewCtx({ currentTab = 'dev', currentSubTab = 'topic' } = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentTab, currentSubTab },
    Kudos: { renderButton: () => '', attach: () => {} },
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
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  const loads = [];
  // The opts object is built inside the vm realm; normalise it so
  // deepStrictEqual compares values, not realm prototypes.
  AppView._loadDevData = (opts) => {
    loads.push(opts && JSON.parse(JSON.stringify(opts)));
    return Promise.resolve(true);
  };
  return { AppView, loads };
}

function stage(over) {
  const o = over || {};
  const ctx = makeViewCtx({ currentTab: o.currentTab, currentSubTab: o.currentSubTab });
  ctx.AppView.appData = { slug: 'demo' };
  ctx.AppView._devDataSlug = o.listsFor || 'demo';
  ctx.AppView._devDataReady = o.ready !== false;
  ctx.AppView._proposals = o.held === false
    ? []
    : [{ id: 7, pr_number: 70, pr_title: 'PR 7', status: o.status || 'promoted', linked_issues: [] }];
  return ctx;
}

test('a proposal page up: the held row stops counting as open and the parts re-read in the background', () => {
  const { AppView, loads } = stage({ currentTab: 'dev', currentSubTab: 'topic' });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.equal(AppView._proposals[0].status, 'merged', 'the cached row is patched');
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }],
    'one background partial load, proposals + merged together');
});

test('a merging row is patched too (the merge has landed, not merely started)', () => {
  const { AppView } = stage({ status: 'merging' });
  AppView.noteSessionMerged(7, 'demo');
  assert.equal(AppView._proposals[0].status, 'merged');
});

test('on the board itself the helper patches but starts no load of its own', () => {
  const { AppView, loads } = stage({ currentTab: 'dev', currentSubTab: 'forum' });
  AppView.noteSessionMerged(7, 'demo');
  assert.equal(AppView._proposals[0].status, 'merged', 'the patch still lands');
  assert.deepEqual(loads, [], 'the burst’s own refresh covers the board showing live');
});

test('lists for another app: nothing patched, nothing fetched', () => {
  const { AppView, loads } = stage({ listsFor: 'demo' });
  assert.equal(AppView.noteSessionMerged(7, 'other'), false);
  assert.equal(AppView._proposals[0].status, 'promoted', 'the cached row is untouched');
  assert.deepEqual(loads, []);
});

test('no whole load yet (_devDataReady false): patched only, no partial load', () => {
  const { AppView, loads } = stage({ ready: false });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), false);
  assert.equal(AppView._proposals[0].status, 'merged');
  assert.deepEqual(loads, []);
});

test('off the dev tab the background load still runs (caches only, no repaint)', () => {
  const { AppView, loads } = stage({ currentTab: 'app', currentSubTab: null });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.equal(AppView._proposals[0].status, 'merged');
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }]);
});

test('a row the lists do not hold leaves nothing to patch', () => {
  const { AppView, loads } = stage({ held: false });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }],
    'the board’s own reload keeps Done current');
});
