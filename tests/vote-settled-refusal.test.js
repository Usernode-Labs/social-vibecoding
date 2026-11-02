'use strict';

// #6101: a vote on a change that merged while its card was on screen.
//
// The vote guards already hide Yes and No for a row whose status is merged
// or closed, but the row in the list was read while the change was still up
// for a vote. When the POST is refused because it is not up for a vote any
// more, castVote must close the card instead of restoring the votable row:
//
//   - the rows it painted keep the status the server reported (never a live
//     Yes and No), and the page is repainted from them;
//   - the lists are read fresh, and Your votes is told;
//   - the caller hears `onSettled`, so a feed can drop the card;
//   - the toast names the reason instead of the server's generic error.
//
// Every other refusal keeps its old behaviour: the optimistic vote is put
// back and the server's words are said.
//
// Run with: node --test tests/vote-settled-refusal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView() {
  const toasts = [];
  const voted = [];
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 }, currentApp: 'demo-app', currentTab: 'dev', currentSubTab: 'topic' },
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
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    PlatformUI: { toast: (t) => toasts.push(t) },
    UsernodeReact: { profileProposals: { voted: () => voted.push(true) } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.__sandbox = sandbox;
  AppView.__toasts = toasts;
  AppView.__voted = voted;
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  return AppView;
}

const openRow = (over) => ({
  id: 7, pr_number: 700, status: 'promoted', my_vote: null, yes_count: 1, no_count: 0,
  approval_epoch: 3, ...over,
});

test('a promoted row that merged after the read: the refusal closes the card and reads again', async () => {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._devTopic = { kind: 'proposal', id: 7 };
  const painted = [];
  AppView._repaintDevBody = () => painted.push(`board:${pr.status}:${pr.my_vote}`);
  let reads = 0;
  AppView.refreshDevData = () => { reads += 1; };
  const settled = [];
  AppView.__sandbox.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'Promoted session not found', code: 'not_up_for_vote', status: 'merged' }),
  });

  const result = await AppView.castVote(7, 'yes', 3, {
    reason: null,
    onSettled: (status) => settled.push(status),
  });

  assert.equal(result, false, 'the vote did not count');
  assert.equal(pr.status, 'merged', 'the card says what the server says, so no Yes or No is drawn');
  assert.equal(pr.my_vote, null, 'the optimistic vote is not left on the row');
  assert.equal(pr.yes_count, 1, 'and neither is its tally');
  assert.deepEqual(painted.slice(-1), ['board:merged:null'], 'the page is repainted from the settled row');
  assert.deepEqual(settled, ['merged'], 'the feed hears the vote is over');
  assert.equal(reads, 1, 'the lists are read fresh');
  assert.deepEqual(AppView.__toasts, [message('changes:vote.toast.alreadyMerged')],
    'the toast names the merge, not the server\'s generic error');
  assert.equal(AppView.__voted.length, 1, 'Your votes is told to move the row to Decided');
  assert.equal(AppView._pendingVotes.size, 0, 'nothing is held over later loads');
});

test('a change that left the vote without merging says so, and settles as closed', async () => {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView.refreshDevData = () => {};
  const settled = [];
  AppView.__sandbox.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'This proposal is no longer up for a vote.', code: 'not_up_for_vote' }),
  });

  const result = await AppView.castVote(7, 'yes', 3, {
    reason: null,
    onSettled: (status) => settled.push(status),
  });

  assert.equal(result, false);
  assert.equal(pr.status, 'closed', 'no status from the server reads as closed, never votable');
  assert.deepEqual(settled, ['closed']);
  assert.deepEqual(AppView.__toasts, [message('changes:vote.toast.noLongerUp')]);
});

test('a refusal that is not about the vote being over keeps today\'s rollback', async () => {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView.refreshDevData = () => {};
  const settled = [];
  AppView.__sandbox.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'This proposal changed while your vote was being recorded.', approvalEpoch: 4 }),
  });

  const result = await AppView.castVote(7, 'yes', 3, {
    reason: null,
    onSettled: (status) => settled.push(status),
  });

  assert.equal(result, false);
  assert.equal(pr.status, 'promoted', 'the card is back as it was, with its Yes and No');
  assert.equal(pr.my_vote, null);
  assert.deepEqual(settled, [], 'nothing is settled');
  assert.deepEqual(AppView.__toasts, ['This proposal changed while your vote was being recorded.'],
    'the server\'s own words are still said');
  assert.equal(AppView.__voted.length, 0, 'Your votes is not re-read for an ordinary refusal');
});
