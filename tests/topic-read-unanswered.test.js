'use strict';

// The native-offline third follow-up (19 Nov 2026 retest of #6862 on
// production, the iPhone app through a 600 ms / 500 kbps proxy): request
// 6809 opened on the slow link dropped the reader on the Workshop. Its read
// ran out read-timeout's 15 s, `_fetchIssueByNumber` answered null as it
// does for a 404, and the topic page's miss branch, which spared only an
// offline shell, fell back to the board. A read with no answer at all (it
// threw, timed out, or the server failed) is now told apart from "no such
// item", and the page waits and asks again instead.
//
// Same vm harness as closed-issue-topic.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { message } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView({ fetchImpl, offline = false } = {}) {
  const toasts = [];
  const timers = [];
  const sandbox = {
    console,
    URLSearchParams,
    location: { search: '' },
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo', switchTab() {} },
    Kudos: { renderButton: () => '' },
    PlatformUI: { toast: (text) => toasts.push(text) },
    document: {
      getElementById: (id) => (id === 'dev-topic-thread' ? {} : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: fetchImpl,
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval, clearInterval,
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  if (offline) sandbox.Offline = { isOffline: () => true };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._ghIssues = [];
  AppView._govProposals = [];
  return { AppView, sandbox, toasts, timers };
}

const answer = (status, body = {}) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fails = async () => { throw new TypeError('Load failed'); };

test('a request read with no answer says so; a 404 is a miss as before', async () => {
  for (const [label, impl, unanswered] of [
    ['404', answer(404, { error: 'Issue not found' }), undefined],
    ['503', answer(503), true],
    ['500', answer(500), true],
    ['a read that threw (offline, or read-timeout giving up)', fails, true],
  ]) {
    const { AppView } = makeAppView({ fetchImpl: impl });
    const outcome = {};
    assert.equal(await AppView._fetchIssueByNumber(6809, outcome), null, label);
    assert.equal(outcome.unanswered, unanswered, label);
  }
  // Callers that pass no outcome still get null, as they always did.
  const { AppView } = makeAppView({ fetchImpl: fails });
  assert.equal(await AppView._fetchIssueByNumber(6809), null);
});

test('both callers of one shared request read hear that it had no answer', async () => {
  let release;
  const { AppView } = makeAppView({ fetchImpl: () => new Promise((_, reject) => { release = reject; }) });
  const a = {};
  const b = {};
  const first = AppView._fetchIssueByNumber(6809, a);
  const second = AppView._fetchIssueByNumber(6809, b);
  release(new TypeError('Load failed'));
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(a.unanswered, true);
  assert.equal(b.unanswered, true, 'the caller that joined the running read is told too');
});

test('a change\'s and a group decision\'s reads tell no answer apart from a miss', async () => {
  for (const read of ['_fetchProposalById', '_fetchGovProposalById']) {
    for (const [label, impl, unanswered] of [
      ['404', answer(404), undefined],
      ['403', answer(403), undefined],
      ['502', answer(502), true],
      ['threw', fails, true],
    ]) {
      const { AppView } = makeAppView({ fetchImpl: impl });
      const outcome = {};
      assert.equal(await AppView[read](14047, outcome), null, `${read} ${label}`);
      assert.equal(outcome.unanswered, unanswered, `${read} ${label}`);
    }
  }
});

test('the topic page\'s item read answers ITEM_UNANSWERED for no answer, null for no such item', async () => {
  const { AppView } = makeAppView({ fetchImpl: fails });
  let threadAsked = 0;
  AppView._openByThread = async () => { threadAsked += 1; return false; };
  assert.equal(AppView.ITEM_UNANSWERED, 'unanswered');
  assert.equal(await AppView._fetchTopicItem({ kind: 'issue', id: 6809 }), AppView.ITEM_UNANSWERED);
  assert.equal(threadAsked, 0, 'a request with no answer does not wait on its thread as well');
  assert.equal(await AppView._fetchTopicItem({ kind: 'proposal', id: 14047 }), AppView.ITEM_UNANSWERED);
  assert.equal(await AppView._fetchTopicItem({ kind: 'gov', id: 12 }), AppView.ITEM_UNANSWERED);

  const missing = makeAppView({ fetchImpl: answer(404) });
  let asked = 0;
  missing.AppView._openByThread = async () => { asked += 1; return false; };
  assert.equal(await missing.AppView._fetchTopicItem({ kind: 'issue', id: 6809 }), null);
  assert.equal(asked, 1, 'a request number that is no request still asks its thread (#6019)');
  assert.equal(await missing.AppView._fetchTopicItem({ kind: 'proposal', id: 14047 }), null);
});

test('online, a page with no answer says Homeroom is slow and asks again in 3 s, then every 20 s', () => {
  const { AppView, toasts, timers } = makeAppView({ fetchImpl: fails });
  const pending = { kind: 'issue', id: 6809 };
  AppView._devTopic = pending;
  let opened = 0;
  AppView._renderTopicSubView = async () => { opened += 1; };
  AppView._openChangeWhenOnline({}, pending, pending);
  assert.deepEqual(toasts, [message('changes:page.slowToAnswer')]);
  assert.equal(message('changes:page.slowToAnswer'), 'Homeroom is taking a while to answer. This page will open when it does.');
  assert.equal(timers.at(-1).ms, AppView.SLOW_RETRY_MS);
  assert.equal(AppView.SLOW_RETRY_MS, 3000);
  timers.at(-1).fn();
  assert.equal(opened, 1, 'it tries the page again');

  // Still no answer: said once, and the next try waits the ordinary 20 s.
  AppView._openChangeWhenOnline({}, pending, pending);
  assert.equal(toasts.length, 1);
  assert.equal(timers.at(-1).ms, 20000);
});

test('offline, it still says the page is not saved on this phone and waits 20 s', () => {
  const { AppView, toasts, timers } = makeAppView({ fetchImpl: fails, offline: true });
  const pending = { kind: 'issue', id: 6809 };
  AppView._devTopic = pending;
  AppView._openChangeWhenOnline({}, pending, pending);
  assert.deepEqual(toasts, [message('changes:page.notSavedYetThread')]);
  assert.equal(timers.at(-1).ms, 20000);
});

test('the topic page waits on an unanswered item read before its Workshop fallback', () => {
  const miss = SRC.slice(SRC.indexOf('const onMiss = () => {'), SRC.indexOf('const settle = () => {'));
  assert.match(miss, /const offlineNow = AppView\._noAnswerNow\(\);\s*if \(unanswered \|\| offlineNow\) \{/);
  assert.ok(miss.indexOf('if (unanswered || offlineNow)') < miss.indexOf("App.switchTab('dev')"),
    'the wait comes before the fallback');
  assert.match(miss, /errorCode: offlineNow \? 'offline' : 'network'/);
  assert.match(SRC, /unanswered = row === AppView\.ITEM_UNANSWERED;\s*ok = !!row && !unanswered;/);
});
