'use strict';

// #2782, the browser half: a Yes on an OPEN proposal page shows at once and
// stays shown.
//
//   1. castVote finds the row the proposal page is drawn from — including the
//      on-demand row a deep link loads, which the board lists never held —
//      and repaints the page's header beside the board, before the request;
//   2. a board load that was already in flight when the vote was cast cannot
//      paint it away: every load re-applies a vote still pending;
//   3. the post-vote refresh never joins a load sent before the vote. It
//      queues a new one behind it, and a burst of refreshes coalesces onto
//      that queued load instead of queueing a run apiece.
//
// Run with: node --test tests/vote-registration-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView(over = {}) {
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
    fetch: over.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    PlatformUI: { toast: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.__sandbox = sandbox;
  return AppView;
}

const openRow = (over) => ({
  id: 7, pr_number: 700, status: 'promoted', my_vote: null, yes_count: 1, no_count: 0,
  approval_epoch: 3, ...over,
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── 1. The open proposal page shows the vote before the request ─────────

test('a Yes cast from the open proposal page repaints the page header, not only the board', async () => {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._devTopic = { kind: 'proposal', id: 7 };
  const seen = [];
  AppView._repaintDevBody = () => seen.push(`board:${pr.my_vote}`);
  AppView._renderTopicHead = () => seen.push(`page:${pr.my_vote}:${pr.yes_count}`);
  AppView.refreshDevData = () => { seen.push('refresh'); };
  AppView.__sandbox.fetch = async () => {
    seen.push(`fetch:${pr.my_vote}`);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await AppView.castVote(7, 'yes', 3, { reason: null });
  assert.deepEqual(seen, ['board:yes', 'page:yes:2', 'fetch:yes', 'refresh'],
    'the page header shows the vote and the tally before the round-trip starts');
});

test('a deep-linked proposal the board lists never held still registers at once', async () => {
  const AppView = makeAppView();
  AppView._proposals = [];
  const row = openRow({ my_vote: 'no', yes_count: 0, no_count: 1 });
  AppView._topicProposal = row;
  AppView._devTopic = { kind: 'proposal', id: 7 };
  const painted = [];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => painted.push(`${row.my_vote}:${row.yes_count}/${row.no_count}`);
  AppView.refreshDevData = () => {};
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await AppView.castVote(7, 'yes', 3, { reason: null });
  assert.deepEqual(painted, ['yes:1/0'], 'a flip moves one vote from No to Yes');
});

test('a refused vote restores the page header and its tally', async () => {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._devTopic = { kind: 'proposal', id: 7 };
  const painted = [];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => painted.push(`${pr.my_vote}:${pr.yes_count}`);
  AppView.refreshDevData = async () => {};
  AppView.__sandbox.fetch = async () => ({
    ok: false, status: 409, json: async () => ({ error: 'This proposal changed', approvalEpoch: 4 }),
  });
  await AppView.castVote(7, 'yes', 3, { reason: null });
  assert.deepEqual(painted, ['yes:2', 'null:1']);
  assert.equal(AppView._pendingVotes.size, 0, 'a refused vote is not held over later loads');
});

// ── 2. A load sent before the vote cannot paint it away ─────────────────

test('a pending vote is re-applied to rows a pre-vote load publishes, until the post-vote read lands', async () => {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  const refresh = deferred();
  AppView.refreshDevData = () => refresh.promise;
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await AppView.castVote(7, 'yes', 3, { reason: null });

  // The 20s checks poll's answer, read before the vote was written.
  const stale = openRow();
  AppView._overlayPendingVote(stale);
  assert.equal(stale.my_vote, 'yes', 'the pre-vote row does not take the vote back');
  assert.equal(stale.yes_count, 2);

  refresh.resolve();
  await refresh.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(AppView._pendingVotes.size, 0, 'dropped once the post-vote read has landed');
  const later = openRow({ my_vote: 'yes', yes_count: 2 });
  AppView._overlayPendingVote(later);
  assert.equal(later.yes_count, 2, 'and a row that already carries the vote is never counted twice');
});

test('the board load itself applies the overlay before publishing', () => {
  const code = SRC.slice(SRC.indexOf('async _fetchDevData(slug'), SRC.indexOf('async _loadDevFeed('));
  const overlay = code.indexOf('promoted.forEach((pr) => AppView._overlayPendingVote(pr));');
  assert.ok(overlay > -1, '_fetchDevData re-applies pending votes');
  assert.ok(overlay < code.indexOf('AppView.voteState = {'), 'before the chat rows are built from the same objects');
  assert.ok(overlay < code.indexOf('AppView._proposals = promoted;'), 'and before the board list is published');
});

// ── 3. The post-vote refresh never joins a pre-vote load ────────────────

function gatedFetch() {
  const calls = [];
  const gates = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const d = deferred();
    gates.push(d);
    await d.promise;
    return { ok: true, json: async () => ({ promoted: [], merged: [] }) };
  };
  return { fetch, calls, releaseAll: () => gates.forEach((g) => g.resolve()) };
}

test('a fresh load queues behind the one in flight instead of joining it; a burst coalesces', async () => {
  const net = gatedFetch();
  const AppView = makeAppView({ fetch: net.fetch });
  AppView.appData = { slug: 'demo-app' };

  const poll = AppView._loadDevData();
  const joined = AppView._loadDevData();
  assert.equal(joined, poll, 'an ordinary caller still shares the run in flight');
  const afterPoll = net.calls.length;

  const vote = AppView._loadDevData({ fresh: true });
  assert.notEqual(vote, poll, 'a post-vote read is its own run…');
  assert.equal(net.calls.length, afterPoll, '…queued behind the pre-vote one, not racing it');
  const burst = AppView._loadDevData({ fresh: true });
  assert.equal(burst, vote, 'a second vote refresh joins the queued run: it has not sent anything yet');

  // Drain: each release lets the next queued run send its requests.
  for (let i = 0; i < 50 && AppView._devDataInflight; i += 1) {
    net.releaseAll();
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all([poll, vote]);
  assert.ok(net.calls.length > afterPoll, 'the fresh run went to the network after the first finished');
  assert.equal(net.calls.length, afterPoll * 2, 'exactly two rounds for three callers');
  assert.equal(AppView._devDataQueued, null);
  assert.equal(AppView._devDataInflight, null);
});

test('refreshDevData asks for a fresh load on a vote and nothing else', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'demo-app' };
  AppView._devTopic = { kind: 'issue', id: 3 };
  const asked = [];
  AppView._loadDevData = (opts) => { asked.push(opts ? { ...opts } : null); return Promise.resolve(true); };
  AppView._refreshTopicOnDemandRow = async () => {};
  AppView._renderTopicHead = () => {};
  AppView.refreshDevData('session');
  AppView.refreshDevData('vote');
  assert.deepEqual(asked, [null, { fresh: true }]);
});

// ── 4. A live vote reads the part of the board it moved ─────────────────

test('a live vote on the board reloads the proposals alone; a merge adds Completed', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'demo-app' };
  AppView._devDataReady = true;
  AppView._proposals = [openRow()];
  AppView._mySessions = [{ id: 8, status: 'active' }];
  const vote = (ids, merged = false) => AppView._partsForLive({ kinds: new Set(['vote']), ids: new Set(ids), merged });
  assert.deepEqual([...vote([7])], ['promoted']);
  assert.deepEqual([...vote([7], true)].sort(), ['merged', 'promoted']);
  assert.deepEqual([...vote([8])], ['sessions'], 'a draft row lives in the session caches');
  assert.equal(vote([99]).size, 0, 'a row this board does not show asks for nothing');
  assert.equal(AppView._partsForLive({ kinds: new Set(['vote', 'session']), ids: new Set([7]) }), null,
    'a session appearing or leaving is the whole board');
  assert.equal(AppView._partsForLive({ kinds: new Set(['vote']), ids: null }), null,
    'an event that names no row is the whole board');
  AppView._devDataReady = false;
  assert.equal(vote([7]), null, 'and so is any refresh before the first whole load');
});

test('a partial load sends only its requests and keeps every other cache', async () => {
  const calls = [];
  const AppView = makeAppView({
    fetch: async (url) => {
      calls.push(String(url).split('?')[0]);
      return { ok: true, json: async () => ({ promoted: [openRow({ yes_count: 5 })], majority: 2, activeUsers: 3 }) };
    },
  });
  AppView.appData = { slug: 'demo-app' };
  AppView._devDataReady = true;
  const issues = [{ number: 1 }];
  AppView._ghIssues = issues;
  AppView._merged = [{ id: 1, row_type: 'pr' }];
  AppView._boardOrder = { issues: [{ ref: 1 }], review: [] };
  AppView._govProposals = [{ id: 4 }];
  AppView._proposalsCtx = { majority: 9, activeUsers: 9, locked: true };
  const ok = await AppView._loadDevData({ fresh: true, parts: new Set(['promoted']) });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['/api/apps/demo-app/promoted']);
  assert.equal(AppView._proposals[0].yes_count, 5);
  assert.equal(AppView._proposalsCtx.majority, 2);
  assert.equal(AppView._ghIssues, issues);
  assert.equal(AppView._merged.length, 1);
  assert.equal(AppView._boardOrder.issues.length, 1);
  assert.equal(AppView._govProposals.length, 1);
  assert.deepEqual(Object.keys(AppView.voteState.bySession).sort(), ['1', '7'],
    'the chat rows still see the Completed rows the load kept');
});

test('a partial run never answers for the whole board; a queued one widens instead', async () => {
  const net = gatedFetch();
  const AppView = makeAppView({ fetch: net.fetch });
  AppView.appData = { slug: 'demo-app' };
  AppView._devDataReady = true;
  const first = AppView._loadDevData({ parts: new Set(['promoted']) });
  const whole = AppView._loadDevData();
  assert.notEqual(whole, first, 'the whole board queues behind a partial run rather than joining it');
  const widened = AppView._loadDevData({ parts: new Set(['merged']) });
  assert.equal(widened, whole, 'a not-yet-sent run takes the next caller in');
  for (let i = 0; i < 50 && AppView._devDataInflight; i += 1) {
    net.releaseAll();
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all([first, whole]);
  assert.equal(AppView._devDataInflight, null);
});

// ── QA 2026-09-24 Q3: castVote says whether the vote landed ─────────────
//
// The Workshop's Needs-you deck marked its card "Voted no" before castVote
// had asked for a No's line, so cancelling "What's not working for you?" left
// a card claiming a vote nothing had sent. It waits on castVote's answer now,
// so the answer has to be right in every branch: TRUE only once the server
// took the vote, and `opts.onSend` only once the vote is committed to.

function outcomeHarness({ prompt = async () => 'Too long', fetch } = {}) {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  AppView.refreshDevData = async () => {};
  const seen = [];
  const toasts = [];
  AppView.__sandbox.PlatformUI = { prompt, toast: (m) => toasts.push(m) };
  AppView.__sandbox.fetch = fetch || (async () => {
    seen.push('fetch');
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const onSend = (vote) => seen.push(`send:${vote}`);
  return { AppView, pr, seen, toasts, onSend };
}

test('a cancelled No resolves false, sends nothing and leaves the card as it was', async () => {
  const h = outcomeHarness({ prompt: async () => null });
  const ok = await h.AppView.castVote(7, 'no', 3, { onSend: h.onSend });
  assert.equal(ok, false);
  assert.deepEqual(h.seen, [], 'no onSend and no request');
  assert.equal(h.pr.my_vote, null, 'the row keeps its vote (none)');
  assert.equal(h.pr.no_count, 0);
  assert.equal(h.AppView._voteInFlight.size, 0, 'and the next press is not blocked');
});

test('a vote the server takes resolves true, with onSend before the request', async () => {
  const h = outcomeHarness();
  const ok = await h.AppView.castVote(7, 'no', 3, { onSend: h.onSend });
  assert.equal(ok, true);
  assert.deepEqual(h.seen, ['send:no', 'fetch']);
});

test('a refused vote resolves false and says why', async () => {
  const h = outcomeHarness({
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'This proposal changed' }) }),
  });
  const ok = await h.AppView.castVote(7, 'yes', 3, { reason: null, onSend: h.onSend });
  assert.equal(ok, false);
  assert.deepEqual(h.toasts, ['This proposal changed']);
  assert.equal(h.pr.my_vote, null, 'the optimistic vote was put back');
});

test('a vote that never reaches the server resolves false and is no longer silent', async () => {
  const h = outcomeHarness({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const ok = await h.AppView.castVote(7, 'yes', 3, { reason: null, onSend: h.onSend });
  assert.equal(ok, false);
  assert.equal(h.pr.my_vote, null, 'the optimistic vote was put back');
  assert.equal(h.toasts.length, 1, 'the failure is said out loud');
  assert.match(h.toasts[0], /did not go through/);
  assert.doesNotMatch(h.toasts[0], /—/, 'in plain words, with no em dash');
});

test('a second press while the first is in flight resolves false without a request', async () => {
  const h = outcomeHarness({ prompt: () => new Promise(() => {}) });
  h.AppView.castVote(7, 'no', 3, { onSend: h.onSend }); // stuck at the prompt
  const ok = await h.AppView.castVote(7, 'no', 3, { onSend: h.onSend });
  assert.equal(ok, false);
  assert.deepEqual(h.seen, []);
});

// ── 5. #5463: a saved vote is published once, and fills later rows ──────
//
// The vote a page saved has to reach the surfaces that did not cast it: the
// Communities feed's kept copy and its counts, and a board read from before
// the vote (the service worker's boot lane). castVote publishes it from its
// ok branch only, and the overlay fills a later pre-vote row from the page's
// own record of the vote.

function savedHarness({ prompt = async () => 'Too long', fetch } = {}) {
  const AppView = makeAppView();
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  AppView.refreshDevData = async () => {};
  const saved = [];
  const notificationCalls = [];
  AppView.__sandbox.UsernodeReact = {
    devBoard: { publishVoteSaved: (...args) => saved.push(args) },
  };
  // #5483: the inbox clears the answered vote-ask rows and re-reads past the
  // service worker's pre-vote copy.
  AppView.__sandbox.Notifications = {
    voteSaved: (id) => notificationCalls.push(`voteSaved:${id}`),
    refresh: () => notificationCalls.push('refresh'),
  };
  AppView.__sandbox.PlatformUI = { toast: () => {}, prompt };
  AppView.__sandbox.fetch = fetch || (async () => ({ ok: true, json: async () => ({ ok: true }) }));
  return { AppView, pr, saved, notificationCalls };
}

test('a vote the server takes publishes voteSaved once, with the epoch it sent', async () => {
  const h = savedHarness();
  const ok = await h.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.equal(ok, true);
  assert.deepEqual(h.saved, [[7, 'yes', 3]], 'the epoch that went in the POST body');
  assert.equal(h.AppView._ownVotes.get(7).epoch, 3, 'the page keeps the epoch it voted at');
  assert.equal(h.AppView._ownVotes.get(7).vote, 'yes');
  // #5483: the inbox clears the answered rows at once and re-reads past its
  // saved pre-vote copy.
  assert.deepEqual(h.notificationCalls, ['voteSaved:7']);
});

test('a refusal, a network failure and a cancelled No publish nothing', async () => {
  const refused = savedHarness({
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'nope' }) }),
  });
  await refused.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.deepEqual(refused.saved, [], 'a refusal is not a saved vote');
  assert.deepEqual(refused.notificationCalls, [], 'and clears nothing in the inbox');

  const failed = savedHarness({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await failed.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.deepEqual(failed.saved, [], 'a vote that never reached the server is not saved');
  assert.deepEqual(failed.notificationCalls, [], 'nor clears anything in the inbox');

  const cancelled = savedHarness({ prompt: async () => null });
  await cancelled.AppView.castVote(7, 'no', 3, {});
  assert.deepEqual(cancelled.saved, [], 'a cancelled No casts nothing');
  assert.deepEqual(cancelled.notificationCalls, [], 'nor clears anything in the inbox');
});

test('a vote this page saved fills a later row the read drew without it', async () => {
  const AppView = makeAppView();
  AppView._proposals = [openRow()];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  const refresh = deferred();
  AppView.refreshDevData = () => refresh.promise;
  AppView.__sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await AppView.castVote(7, 'yes', 3, { reason: null });
  refresh.resolve();
  await refresh.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(AppView._pendingVotes.size, 0, 'the pending entry has settled');

  // The service worker's boot lane answers the next board read with the
  // saved pre-vote copy: the overlay fills it from the page's own record.
  const stale = openRow();
  AppView._overlayPendingVote(stale);
  assert.equal(stale.my_vote, 'yes', 'the pre-vote copy does not take the vote back');
  assert.equal(stale.yes_count, 2);
  AppView._overlayPendingVote(stale);
  assert.equal(stale.yes_count, 2, 'and it is never counted twice');

  // A change that moved since the vote asks again.
  const newer = openRow({ approval_epoch: 4 });
  AppView._overlayPendingVote(newer);
  assert.equal(newer.my_vote, null, 'a newer epoch is a different vote');
  assert.equal(newer.yes_count, 1);

  // The server's own word is never overridden.
  const server = openRow({ my_vote: 'no', no_count: 1 });
  AppView._overlayPendingVote(server);
  assert.equal(server.my_vote, 'no');

  // Where either side has no epoch, the id alone decides.
  const noEpoch = openRow({ approval_epoch: null });
  AppView._overlayPendingVote(noEpoch);
  assert.equal(noEpoch.my_vote, 'yes');
  const votedNoEpoch = openRow({ id: 8, approval_epoch: 2 });
  await AppView.castVote(8, 'no', null, { reason: null });
  AppView._overlayPendingVote(votedNoEpoch);
  assert.equal(votedNoEpoch.my_vote, 'no', 'a vote saved without an epoch fills by id');

  // Only a row that is promoted is filled.
  const merging = openRow({ status: 'merging' });
  AppView._overlayPendingVote(merging);
  assert.equal(merging.my_vote, null, 'a row no longer waiting for votes is left alone');
});

// ── 5. A chat's card shows the vote at once (#5458) ─────────────────────

// A chat's inline vote controls (group-chat.js refreshVoteControls) read
// AppView.voteState.bySession — a snapshot loadVoteState builds, a different
// object from the board row _findItem hands castVote, and on Messages often
// the only row there is. The vote reaches both rows before the POST is sent,
// both go back on a refusal, and outside the board the chat's snapshot is
// re-read once the server has said yes (refreshDevData returns before doing
// anything when the dev tab is not the one on screen).

function chatHarness({ tab = 'messages', chatMounted = true } = {}) {
  const AppView = makeAppView();
  const boardRow = openRow();
  const chatRow = openRow({ yes_count: 1 });
  AppView._proposals = [boardRow];
  AppView.voteState = { bySession: { '7': chatRow }, byPrNumber: {}, majority: 2, activeUsers: 3 };
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  if (chatMounted) AppView.__sandbox.GroupChat = { appSlug: 'demo-app', refreshVoteControls: () => {} };
  AppView.__sandbox.App.currentTab = tab;
  const reads = [];
  AppView.loadVoteState = (slug) => { reads.push(slug); return Promise.resolve(); };
  return { AppView, boardRow, chatRow, reads };
}

test('a chat card carries the vote before the POST answers, and re-reads once it landed', async () => {
  const h = chatHarness();
  const post = deferred();
  h.AppView.__sandbox.fetch = async () => post.promise.then(
    () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  const refresh = deferred();
  h.AppView.refreshDevData = () => refresh.promise;
  const read = deferred();
  h.AppView.loadVoteState = (slug) => { h.reads.push(slug); return read.promise; };
  const done = h.AppView.castVote(7, 'yes', 3, { reason: null });
  await new Promise((r) => setImmediate(r));

  assert.equal(h.boardRow.my_vote, 'yes', 'the board row still takes the vote optimistically');
  assert.equal(h.chatRow.my_vote, 'yes', 'the chat row carries the vote before the round-trip');
  assert.equal(h.chatRow.yes_count, 2, 'and its tally moves too');
  assert.deepEqual(h.reads, [], 'nothing is re-read until the server has said yes');

  post.resolve();
  await done;
  assert.deepEqual(h.reads, ['demo-app'], 'the chat re-reads its snapshot after the ok');
  assert.equal(h.AppView._pendingVotes.size, 1, 'the vote stays held while the reads land');
  refresh.resolve();
  await refresh.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(h.AppView._pendingVotes.size, 1, '…and after the first of the two');
  read.resolve();
  await read.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(h.AppView._pendingVotes.size, 0, 'settled only once both reads have landed');
});

test('a chat card on Messages whose board lists are another app\'s still shows the vote', async () => {
  // The reported case: _findItem answers null here (its slug guard fails),
  // so before the change the chat row was never touched at all.
  const h = chatHarness();
  h.AppView._devDataSlug = 'other-app';
  h.AppView._proposals = [];
  const post = deferred();
  h.AppView.__sandbox.fetch = async () => post.promise.then(
    () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  const done = h.AppView.castVote(7, 'yes', 3, { reason: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.chatRow.my_vote, 'yes', 'the chat row alone carries the vote');
  assert.equal(h.chatRow.yes_count, 2);
  post.resolve();
  await done;
  assert.deepEqual(h.reads, ['demo-app']);
});

test('a refused vote restores the chat row and reads nothing back', async () => {
  const h = chatHarness();
  h.AppView.__sandbox.fetch = async () => ({
    ok: false, status: 409, json: async () => ({ error: 'This proposal changed', approvalEpoch: 4 }),
  });
  await h.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.equal(h.chatRow.my_vote, null, 'the chat row goes back to offering Yes and No');
  assert.equal(h.chatRow.yes_count, 1);
  assert.equal(h.boardRow.my_vote, null);
  assert.equal(h.boardRow.yes_count, 1);
  assert.deepEqual(h.reads, [], 'a refusal re-reads nothing for the chat');
});

test('a vote that never reached the server restores the chat row too', async () => {
  const h = chatHarness();
  h.AppView.__sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await h.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.equal(h.chatRow.my_vote, null);
  assert.equal(h.chatRow.yes_count, 1);
});

test('the chat row and the board row are one object on the dev board, and count once', async () => {
  const h = chatHarness({ tab: 'dev' });
  h.boardRow === h.chatRow;
  h.AppView.voteState.bySession['7'] = h.boardRow;
  h.AppView.refreshDevData = () => Promise.resolve(true);
  h.AppView.__sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await h.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.equal(h.boardRow.my_vote, 'yes');
  assert.equal(h.boardRow.yes_count, 2, 'one row, one bump — never two');
  assert.deepEqual(h.reads, [], 'the dev tab re-reads the snapshot through refreshDevData, not here');
});

test('no chat mounted: no extra read even outside the board', async () => {
  const h = chatHarness({ chatMounted: false });
  h.AppView.__sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await h.AppView.castVote(7, 'yes', 3, { reason: null });
  assert.deepEqual(h.reads, [], 'nothing re-read when no chat is listening');
});
