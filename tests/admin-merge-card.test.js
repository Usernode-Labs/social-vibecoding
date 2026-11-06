'use strict';

// An admin's force merge says it is queued instead of looking like a click
// that did nothing, refuses a second one, and the card says the vote is
// skipped rather than still waiting on the group.
//
// Run with: node --test tests/admin-merge-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView({ row = null, fetchImpl = null } = {}) {
  const toasts = [];
  const calls = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1, isAdmin: true } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    PlatformUI: { toast: (m) => toasts.push(m) },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (fetchImpl) return fetchImpl(url, opts);
      return { ok: true, status: 200, json: async () => ({ ok: true, queued: true }) };
    },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._voteRoster = {};
  AppView.refreshDevData = () => {};
  AppView._findItem = () => row;
  return { AppView, toasts, calls, i18n: sandbox.PlatformI18n };
}

const FORCE = { by: 'evan', userId: 3, at: '2026-11-06T12:00:00Z', head: 'a'.repeat(40) };

test('a queued force merge is said right away', async () => {
  const { AppView, toasts, calls, i18n } = makeAppView({ row: { id: 9, status: 'promoted' } });
  await AppView.castAdminMerge(9);
  assert.equal(calls.length, 1);
  assert.deepEqual(toasts, [i18n.t('changes:vote.forceMerge.queued')]);
});

test('a second Admin merge says it is already queued and sends nothing', async () => {
  const { AppView, toasts, calls, i18n } = makeAppView({ row: { id: 9, status: 'promoted', merge_force: FORCE } });
  await AppView.castAdminMerge(9);
  assert.equal(calls.length, 0, 'the confirm is not even shown');
  assert.deepEqual(toasts, [i18n.t('changes:vote.forceMerge.alreadyQueued')]);
});

test('the route\'s already-queued answer says the same thing', async () => {
  const { AppView, toasts, i18n } = makeAppView({
    row: { id: 9, status: 'promoted' },
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'already_queued' }) }),
  });
  await AppView.castAdminMerge(9);
  assert.deepEqual(toasts, [i18n.t('changes:vote.forceMerge.alreadyQueued')]);
});

test('a skipped gate says so', () => {
  const { AppView, i18n } = makeAppView();
  assert.equal(
    AppView._stepLine({ key: 'approvals', state: 'done', detail: { skipped: 'force', by: 'evan' } }, {}),
    i18n.t('changes:step.force.skipped'));
  assert.equal(
    AppView._stepLine({ key: 'checks', state: 'done', detail: { skipped: 'force', by: 'evan' } }, {}),
    i18n.t('changes:step.force.skipped'));
});

test('the Votes card says the force skipped the vote, and names who and which commit', () => {
  const { AppView, i18n } = makeAppView();
  const item = { id: 9, status: 'promoted', user_id: 2, merge_force: FORCE };
  const card = { pill: { state: { key: 'needs_vote', yes: 0, majority: 2 } } };
  const v = AppView._changeVotesView(item, card);
  assert.equal(v.figure, i18n.t('changes:page.votes.figure.adminMerge'));
  assert.equal(v.tone, 'muted');
  assert.equal(v.note[0], i18n.t('changes:page.votes.note.adminMerge', { by: 'evan', head: 'aaaaaaa' }));
});

test('a force an authored push ended is named under the ordinary card', () => {
  const { AppView, i18n } = makeAppView();
  const item = {
    id: 9, status: 'promoted', user_id: 2, yes_count: 2, votes_required: 2,
    merge_force_dropped: { by: 'evan', head: 'abc1234', to: 'def5678', droppedAt: '2026-11-06T12:10:00Z' },
  };
  const card = { pill: { state: { key: 'needs_vote', yes: 2, majority: 2 } } };
  const v = AppView._changeVotesView(item, card);
  assert.ok(v.note.includes(i18n.t('changes:page.votes.note.adminMergeDropped', { by: 'evan', head: 'abc1234' })));
});
