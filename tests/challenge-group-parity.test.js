// Challenge category parity: Home's Challenges block and the Challenges tab.
//
// WHAT THIS PINS. Since the Semi design (2026-10-16) the two surfaces no longer
// draw the same groups in the same order: the tab lists First challenges, Next
// challenges and Done; Home shows a few of them, chosen its own way. What they
// still share is how they READ a challenge, and a challenge must read the same
// on both:
//
//   * is it a First challenge? (category ONBOARDING, trimmed, any case)
//   * does it count by the week? (category WEEKLY: its rail says "this week")
//   * has the viewer finished it? (their own `progress.done`, else the
//     organiser's `completed`)
//
// Each controller keeps its own copy of those rules, because both run as
// import-free classic scripts (vm-based tests load them that way, and
// home-panels.js has its imports stripped there):
//
//   * TopochainChallenges._categoryOf / _isWeekly / _isDone
//     (frontend/src/features/leaderboard/topochain-challenges.js)
//   * HomePanels.groupOf / orderDone
//     (frontend/src/features/home/home-panels.js)
//
// This fails the moment either copy drifts.
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
const { englishPlatformI18n } = require('./lib/platform-i18n');

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
  sandbox.PlatformI18n = englishPlatformI18n();
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
  sandbox.PlatformI18n = englishPlatformI18n();
  installPanelsStore(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox, { filename: 'home-panels.js' });
  return sandbox.__HP;
}

const TAB = loadTab();
const HOME = loadHome();

// [label, viewer done (null: no progress), organiser completed]
const CASES = [
  ['ONBOARDING', false, false], [' onboarding ', true, false], ['Onboarding', null, true],
  ['WEEKLY', false, false], ['weekly', true, false], [' Weekly', null, false],
  ['PERSISTENT', false, true], ['COMMUNITY', null, false], ['', false, false], [null, null, null],
];
const tabRow = ([label, done, completed], id) => ({
  id, card_preview: { label }, completed: completed === true, ...(done == null ? {} : { progress: { done } }),
});
const homeRow = ([label, done, completed], id) => ({
  id, label, completed: completed === true, ...(done == null ? {} : { progress: { done, current: null, target: null } }),
});

test('a First challenge on the tab is a First challenge on Home', () => {
  CASES.forEach((c, i) => {
    assert.equal(HOME.groupOf(homeRow(c, i)).key === 'setup', TAB._categoryOf(tabRow(c, i)) === 'ONBOARDING',
      `label ${JSON.stringify(c[0])}`);
  });
  assert.equal(TAB._groupOf(tabRow(['onboarding', false, false], 1)).key, 'first', 'and an open one heads the tab');
  assert.equal(TAB._groupOf(tabRow(['onboarding', true, false], 1)).key, 'done', 'a finished one is Done there');
});

test('a weekly challenge is weekly on both surfaces', () => {
  CASES.forEach((c, i) => {
    assert.equal(HOME.groupOf(homeRow(c, i)).key === 'week', TAB._isWeekly(tabRow(c, i)), `label ${JSON.stringify(c[0])}`);
  });
});

test('a challenge the viewer finished is finished on both surfaces', () => {
  TAB._mine = new Map();
  CASES.forEach((c, i) => {
    assert.equal(HOME.orderDone(homeRow(c, i)), TAB._isDone(tabRow(c, i)), `case ${JSON.stringify(c)}`);
  });
  assert.equal(TAB._isDone(tabRow(['WEEKLY', false, true], 1)), false,
    'the viewer’s own progress outranks the organiser’s flag');
});
