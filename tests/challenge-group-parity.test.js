// Challenge group parity: Home's Challenges block and the Challenges tab (S10).
//
// WHAT THIS PINS. Home's block shows the tab's list, so the two surfaces must
// group the same challenges under the same headings in the same order. Each
// controller keeps its own copy of the group table and the rank rule, because
// both run as import-free classic scripts (vm-based tests load them that way,
// and home-panels.js has its imports stripped there):
//
//   * TopochainChallenges.GROUPS / OTHER_GROUP / _groupRankOf / _setupFinished
//     (frontend/src/features/leaderboard/topochain-challenges.js)
//   * HomePanels.CHALLENGE_GROUPS / OTHER_GROUP / groupRankOf / setupFinished
//     (frontend/src/features/home/home-panels.js)
//
// This fails the moment either copy drifts: a heading renamed on one side, a
// group's order changed, or the "finished Get started goes last" rule
// changed in only one file.
//
// Run with: node --test tests/challenge-group-parity.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PANELS_SRC } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');

const TAB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8'
);

// Values copied out of a vm realm: deepStrictEqual rejects its objects against
// host literals for their prototypes alone.
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadTab() {
  const context = { eventId: 10, select() {}, onChange() { return () => {}; } };
  const sandbox = {
    window: { TopochainEventContext: context },
    TopochainEventContext: context,
    console, setTimeout, clearTimeout, URLSearchParams,
    location: { hash: '', search: '' },
    fetch: () => new Promise(() => {}),
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TAB_SRC, sandbox, { filename: 'topochain-challenges.js' });
  return sandbox.window.TopochainChallenges;
}

function loadHome() {
  const sandbox = {
    console, App: { user: { id: 1 } },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {},
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout, URLSearchParams, Date,
    location: { search: '', hash: '' },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox, { filename: 'home-panels.js' });
  return sandbox.__HP;
}

const TAB = loadTab();
const HOME = loadHome();

test('the two group tables are the same table', () => {
  assert.deepEqual(plain(HOME.CHALLENGE_GROUPS), plain(TAB.GROUPS));
  assert.deepEqual(plain(HOME.OTHER_GROUP), plain(TAB.OTHER_GROUP));
  assert.deepEqual(plain(TAB.GROUPS), {
    ONBOARDING: { key: 'setup', heading: 'Get started', order: 0 },
    WEEKLY: { key: 'week', heading: 'This week', order: 1 },
    PERSISTENT: { key: 'always', heading: 'Always open', order: 2 },
  }, 'the owner-decided headings, with the keys unchanged');
  assert.deepEqual(plain(TAB.OTHER_GROUP), { key: 'other', heading: 'Season challenges', order: 3 });
});

test('the two rank rules agree for every group, setup unfinished and finished', () => {
  const groups = (tbl, other) => [tbl.ONBOARDING, tbl.WEEKLY, tbl.PERSISTENT, other, null];
  const tabGroups = groups(TAB.GROUPS, TAB.OTHER_GROUP);
  const homeGroups = groups(HOME.CHALLENGE_GROUPS, HOME.OTHER_GROUP);
  // `undefined` and a truthy non-boolean too: both rules read `=== true`.
  for (const finished of [false, true, undefined, 1]) {
    const tabRanks = tabGroups.map((g) => TAB._groupRankOf(g, finished));
    const homeRanks = homeGroups.map((g) => HOME.groupRankOf(g, finished));
    assert.deepEqual(homeRanks, tabRanks, `setupFinished=${String(finished)}`);
  }
  assert.deepEqual(tabGroups.map((g) => TAB._groupRankOf(g, false)), [0, 1, 2, 3, 3],
    'unfinished: Get started leads; no group ranks as Season challenges');
  assert.deepEqual(tabGroups.map((g) => TAB._groupRankOf(g, true)), [4, 1, 2, 3, 3],
    'finished: only Get started moves, to the end');
});

test('the two "setup finished" rules agree, each fed rows in its own shape', () => {
  // [label, done] per card; each surface gets the same challenges in its shape.
  const cases = [
    { name: 'no setup cards, no summary', cards: [['WEEKLY', true]], onboarding: null },
    { name: 'setup half done, no summary', cards: [['ONBOARDING', true], ['ONBOARDING', false]], onboarding: null },
    { name: 'setup all done, no summary', cards: [['ONBOARDING', true], ['onboarding', true], ['WEEKLY', false]], onboarding: null },
    { name: 'locked summary over done cards', cards: [['ONBOARDING', true]], onboarding: { unlocked: false } },
    { name: 'unlocked summary over unfinished cards', cards: [['ONBOARDING', false]], onboarding: { unlocked: true } },
    { name: 'empty list, unlocked summary', cards: [], onboarding: { unlocked: true } },
  ];
  for (const { name, cards, onboarding } of cases) {
    const tabList = cards.map(([label, done], i) => ({ id: i + 1, card_preview: { label }, progress: { done } }));
    const homeRows = cards.map(([label, done], i) => ({ id: i + 1, label, progress: { done } }));
    assert.equal(HOME.setupFinished(homeRows, onboarding), TAB._setupFinished(tabList, onboarding), name);
  }
});

// The ORDER, fed the payload each surface really gets. The tab's public list
// (src/routes/topochain/public.js) is sorted display_order then id and
// attaches per-user `progress` only to setup cards; every other card carries
// the organiser's `completed` flag, and `featured` arrives on the viewer's
// personalization row (`_mine`). Home's rows carry the viewer's `progress` on
// every card (my_done), plus `completed`, `featured` and `display_order`, in
// whatever sequence the server sent them.
test('Home orders the same challenges in the tab\'s sequence, each fed its real payload shape', () => {
  // [id, label, display_order, viewer done, organiser completed, featured]
  const cards = [
    [1, 'ONBOARDING', 0, true, false, false],
    [2, 'ONBOARDING', 1, true, false, false],
    [3, 'WEEKLY', 0, true, false, false],
    [4, 'WEEKLY', 1, false, false, false],
    [8, 'WEEKLY', 2, true, true, false],
    [5, 'PERSISTENT', 0, true, false, false],
    [6, 'PERSISTENT', 1, false, false, false],
    [9, 'PERSISTENT', 3, false, false, true],
    [7, 'COMMUNITY', 0, false, false, false],
  ];
  const publicOrder = cards.slice().sort((a, b) => (a[2] - b[2]) || (a[0] - b[0]));
  const tabIds = (list, onboarding) => {
    TAB._challenges = list.map(([id, label, , done, completed]) => ({
      id, card_preview: { label }, completed,
      ...(String(label).toUpperCase() === 'ONBOARDING' ? { progress: { done } } : {}),
    }));
    TAB._mine = new Map(list.map(([id, , , , completed, featured]) => [id, { id, completed, featured }]));
    TAB._onboarding = onboarding;
    try {
      return plain(TAB._ordered().map((c) => c.id));
    } finally {
      TAB._challenges = [];
      TAB._mine = new Map();
      TAB._onboarding = null;
    }
  };
  const homeIds = (list, onboarding) => plain([...HOME.orderRows(
    list.slice().reverse().map(([id, label, display_order, done, completed, featured]) => ({
      id, label, display_order, featured, completed, progress: { done, current: null, target: null },
    })),
    onboarding,
  )].map((c) => c.id));

  const setupOpen = publicOrder.map((c) => (c[0] === 2 ? [c[0], c[1], c[2], false, c[4], c[5]] : c));
  for (const [name, list, onboarding] of [
    ['unlocked summary', publicOrder, { unlocked: true }],
    ['locked summary', publicOrder, { unlocked: false }],
    ['no summary, setup all done', publicOrder, null],
    ['no summary, setup half done', setupOpen, null],
  ]) {
    assert.deepEqual(homeIds(list, onboarding), tabIds(list, onboarding), name);
  }
  assert.deepEqual(tabIds(publicOrder, { unlocked: true }), [3, 4, 8, 9, 5, 6, 7, 1, 2],
    'a card the viewer finished keeps its place outside Get started; the organiser-closed one sinks; '
    + 'featured lifts; finished Get started goes last');
  assert.deepEqual(tabIds(setupOpen, null), [2, 1, 3, 4, 8, 9, 5, 6, 7],
    'setup unfinished leads, its open card first');

  // Collapsed is the first four of that list.
  const drawn = [...HOME.visibleSlots({
    key: 'challenges',
    onboarding: { unlocked: true },
    challenges: publicOrder.map(([id, label, display_order, done, completed, featured]) => ({
      id, label, display_order, featured, completed, progress: { done, current: null, target: null },
    })),
  }).rows].map((c) => c.id);
  assert.deepEqual(plain(drawn), tabIds(publicOrder, { unlocked: true }).slice(0, 4));
});
