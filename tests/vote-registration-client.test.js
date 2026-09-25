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

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView(over = {}) {
  const sandbox = {
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
  const code = SRC.slice(SRC.indexOf('async _fetchDevData(slug)'), SRC.indexOf('async _loadDevFeed()'));
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
  AppView.refreshDevData('checks-poll');
  AppView.refreshDevData('vote');
  assert.deepEqual(asked, [null, { fresh: true }]);
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

// ── Communities: a vote refused for membership offers Join, then lands ──
//
// POST /api/sessions/:id/vote answers 403 `join_required` for someone who is
// not in the app's community (services/communities.js). castVote treats that
// as a question: it puts the optimistic vote back, asks through offerJoin,
// and on a yes casts the SAME vote again with the line already in hand.

test('a join_required refusal offers Join, and a yes casts the same vote again', async () => {
  const calls = [];
  let answer = { ok: false, status: 403, json: async () => ({
    error: 'Join Demo to propose and vote on its changes.', code: 'join_required',
    app: { slug: 'demo-app', name: 'Demo' },
  }) };
  const AppView = makeAppView({
    fetch: async (url, init) => {
      calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      const out = answer;
      answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
      return out;
    },
  });
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  AppView.refreshDevData = async () => {};
  const asked = [];
  AppView.offerJoin = async (data) => { asked.push(data.app.slug); return true; };
  const ok = await AppView.castVote(7, 'yes', 3, { reason: null });
  assert.equal(ok, true, 'the retried vote is the answer the caller gets');
  assert.deepEqual(asked, ['demo-app'], 'asked once, about the app the server named');
  assert.equal(calls.length, 2, 'the refused vote, then the same vote again');
  assert.deepEqual(calls.map((c) => c.body.vote), ['yes', 'yes']);
  assert.equal(AppView._voteInFlight.size, 0, 'nothing is left holding the in-flight slot');
});

test('a No to the Join question leaves no vote and no second request', async () => {
  let n = 0;
  const AppView = makeAppView({
    fetch: async () => {
      n += 1;
      return { ok: false, status: 403, json: async () => ({ code: 'join_required', app: { slug: 'demo-app', name: 'Demo' } }) };
    },
  });
  const pr = openRow();
  AppView._proposals = [pr];
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  AppView.refreshDevData = async () => {};
  AppView.offerJoin = async () => false;
  assert.equal(await AppView.castVote(7, 'yes', 3, { reason: null }), false);
  assert.equal(n, 1);
  assert.equal(pr.my_vote, null, 'the optimistic vote went back');
});
