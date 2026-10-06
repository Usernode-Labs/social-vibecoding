// Challenge numbers stuck after finishing tasks (#3991): the Challenges tab
// read its grid once per screen visit — Leaderboard._challengesMounted gated
// TopochainChallenges.open() to the first show of the tab — so coming back
// from Kudos or Standings, or coming back to the app after being away, kept
// showing the numbers from the first load.
//
// Now: re-entering the tab in the same screen visit re-runs loadChallenges()
// (not open(), which resets the viewer's group toggles and clears overlays),
// and a visibilitychange to visible while the tab shows does the same. The
// listener is installed by open() and removed by close().
//
// Run with: node --test tests/leaderboard-challenges-refresh.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const lbSrc = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/leaderboard.js'), 'utf8');

/**
 * The real Leaderboard module, run as a script against a small DOM: the same
 * harness style as tests/leaderboard-title-sync.test.js, with a document that
 * carries listeners and a visibility state, and a TopochainChallenges that
 * records what it is asked to do.
 */
function loadLeaderboard() {
  const classState = new Map();
  const el = (id) => {
    if (!classState.has(id)) classState.set(id, new Set());
    const set = classState.get(id);
    return { classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) } };
  };
  const doc = {
    visibilityState: 'visible',
    added: [],
    removed: [],
    listeners: new Map(),
    addEventListener(type, fn) {
      this.added.push([type, fn]);
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this.removed.push([type, fn]);
      this.listeners.get(type)?.delete(fn);
    },
    getElementById: el,
  };
  const topo = { calls: [] };
  const location = { hash: '#leaderboard/challenges' };
  const ctx = {
    App: {
      setHeaderTitle() {},
      _leaderboardTitle: () => 'Challenges',
    },
    TopochainChallenges: {
      _detailChallenge: null,
      open() { topo.calls.push('open'); },
      close() {},
      loadChallenges() { topo.calls.push('loadChallenges'); },
    },
    TopochainLeaderboard: { open() {}, close() {} },
    TopochainEventContext: { open() {}, close() {} },
    LeaderboardHistory: { open() {}, close() {} },
    location,
    history: {
      replaceState: (_s, _t, url) => { location.hash = url; },
      pushState: (_s, _t, url) => { location.hash = url; },
    },
    document: doc,
    console,
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${lbSrc.replace(/^export .*$/gm, '')}\n;globalThis.__lb = Leaderboard;`, ctx);
  return {
    Leaderboard: ctx.__lb,
    topo,
    fireVisibility() {
      for (const fn of doc.listeners.get('visibilitychange') || []) fn();
    },
    doc,
  };
}

test('first mount still opens the pane once, and re-entering the tab re-reads the grid', async () => {
  const { Leaderboard, topo } = loadLeaderboard();
  await Leaderboard.open();
  assert.deepEqual(topo.calls, ['open'], 'the first show of the tab is the pane\'s own open()');

  // Away to Standings and back: a re-entry, not a first mount.
  Leaderboard._setSection('topochain');
  Leaderboard._setSection('challenges');
  assert.deepEqual(topo.calls, ['open', 'loadChallenges'],
    'coming back to the tab calls loadChallenges, not open() again');

  // Pressing/repainting the tab while it already shows is no churn.
  Leaderboard._applySection();
  assert.deepEqual(topo.calls, ['open', 'loadChallenges'],
    'a no-change redraw does not re-read the grid');
});

test('becoming visible again re-reads the grid only while the Challenges tab shows', async () => {
  const { Leaderboard, topo, fireVisibility, doc } = loadLeaderboard();
  await Leaderboard.open();
  assert.deepEqual(topo.calls, ['open']);

  // Coming back to the app (the browser tab becomes visible again).
  fireVisibility();
  assert.deepEqual(topo.calls, ['open', 'loadChallenges'],
    'visible again on Challenges: the grid re-reads');

  // Losing visibility is not a reason to fetch.
  doc.visibilityState = 'hidden';
  fireVisibility();
  assert.deepEqual(topo.calls, ['open', 'loadChallenges'], 'going away does not fetch');

  // Another section showing costs nothing.
  Leaderboard._setSection('kudos');
  doc.visibilityState = 'visible';
  fireVisibility();
  assert.deepEqual(topo.calls, ['open', 'loadChallenges'],
    'visible again on Kudos does not touch the challenge grid');

  // Back on Challenges, it works again (this re-entry refetches too).
  Leaderboard._setSection('challenges');
  assert.equal(topo.calls.filter((c) => c === 'loadChallenges').length, 2,
    'the tab re-entry itself re-reads');
});

test('close() removes the visibility listener', async () => {
  const { Leaderboard, topo, fireVisibility, doc } = loadLeaderboard();
  await Leaderboard.open();
  assert.equal(doc.added.length, 1, 'open() installed exactly one listener');
  const [[type, fn]] = doc.added;
  assert.equal(type, 'visibilitychange');

  Leaderboard.close();
  assert.deepEqual(doc.removed, [['visibilitychange', fn]],
    'close() removes the very handler open() installed');

  doc.visibilityState = 'visible';
  fireVisibility();
  assert.deepEqual(topo.calls, ['open'],
    'a fired event after close() reaches nothing: the handler is gone');
});

test('a reopen after close() reinstalls the listener and starts from open() again', async () => {
  const { Leaderboard, topo, fireVisibility, doc } = loadLeaderboard();
  await Leaderboard.open();
  Leaderboard.close();
  await Leaderboard.open();
  assert.deepEqual(topo.calls, ['open', 'open'],
    'a fresh visit is a fresh mount: the pane re-opens, the grid reloads through it');
  assert.equal(doc.added.length, 2, 'the listener is installed again');
  doc.visibilityState = 'visible';
  fireVisibility();
  assert.deepEqual(topo.calls, ['open', 'open', 'loadChallenges'],
    'and the new handler is the one that fires');
});
