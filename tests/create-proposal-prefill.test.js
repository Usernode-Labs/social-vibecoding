const { withLanguage } = require("./lib/platform-language");
// Start work on a request (#609, #2779).
//
// #609 made "Create proposal" prefill its kickoff message instead of sending
// it: the seed went into a new classic dev chat's draft, unsent. #2779 moved
// Start work into an agent session: AppView.createPrForIssue opens an UNSENT
// conversation with the Mayor, focused on the request, and the box offers the
// request's first message (frontend/src/features/agent-session/
// request-seed.ts). Classic sessions are no longer created, so these tests pin
// that nothing on the classic path runs: no session, no draft, no navigation,
// and nothing is ever sent.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and spy on the agent session
// controller — same harness as card-action-layout.test.js.
//
// Run with: node --test tests/create-proposal-prefill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeHarness({ controller = true } = {}) {
  const calls = {
    createSession: [],
    setDraft: [],
    sendMessage: [],
    switchTab: [],
    started: [],
  };
  const sandbox = {
    console,
    relTime: () => 'just now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { hash: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    App: {
      user: { id: 42 },
      switchTab: async (...args) => { calls.switchTab.push(args); },
    },
    DevChat: {
      createSession: async (...args) => {
        calls.createSession.push(args);
        return { id: 42 };
      },
      _setDraft(sessionId, value) { calls.setDraft.push([sessionId, value]); },
      sendMessage: (...args) => { calls.sendMessage.push(args); },
    },
  };
  if (controller) {
    // The hint is made in the vm's realm: record it as plain data.
    sandbox.UsernodeReact = {
      agentSession: { start: (hint) => { calls.started.push(JSON.parse(JSON.stringify(hint))); } },
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(withLanguage(sandbox));
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'test-app' };
  return { AppView, calls, sandbox };
}

const ISSUE = { number: 5, title: 'Fix the thing', body: 'It is broken in two ways.' };

function assertNoClassicSession(calls) {
  assert.equal(calls.createSession.length, 0, 'no classic session is created');
  assert.equal(calls.setDraft.length, 0, 'nor drafted into');
  assert.equal(calls.switchTab.length, 0, 'nor navigated to');
  assert.equal(calls.sendMessage.length, 0, 'and nothing is ever sent');
}

// The hint carries the request's title as well as its number, so the
// conversation names the request and offers its first message in the box
// rather than opening blank.
test('createPrForIssue: opens an agent session on the request, carrying its title', () => {
  const { AppView, calls } = makeHarness();
  AppView._ghIssues = [{ ...ISSUE }];

  AppView.createPrForIssue(5);

  assert.deepEqual(calls.started, [{ slug: 'test-app', issueNumber: 5, entry: 'issue', issueTitle: 'Fix the thing' }]);
  assertNoClassicSession(calls);
});

test('createPrForIssue: a request the board has not loaded still starts, by number alone', () => {
  const { AppView, calls } = makeHarness();
  AppView._ghIssues = [];

  AppView.createPrForIssue(7);

  assert.deepEqual(calls.started, [{ slug: 'test-app', issueNumber: 7, entry: 'issue' }]);
  assertNoClassicSession(calls);
});

test('createPrForIssue: with no app on screen it is a quiet no-op', () => {
  const { AppView, calls } = makeHarness();
  AppView.appData = null;

  AppView.createPrForIssue(5);

  assert.equal(calls.started.length, 0);
  assertNoClassicSession(calls);
});

// The controller is published by the shell bundle before anything can be
// clicked. Without it the address still opens an unsent conversation, only
// without the hint, rather than a dead button or a classic session.
test('createPrForIssue: without the agent-session controller, the address still opens one', () => {
  const { AppView, calls, sandbox } = makeHarness({ controller: false });
  AppView._ghIssues = [{ ...ISSUE }];

  AppView.createPrForIssue(5);

  assert.equal(sandbox.location.hash, '#agent/new');
  assertNoClassicSession(calls);
});

// A finished auto-solve run's "Start work" (#2779): an agent session on the
// run's request, by the number the card passes, since the request it was
// drawn from need not be in the board's cache.
test('startFromAutoSession: starts on the request the card names, cached or not', () => {
  const { AppView, calls } = makeHarness();
  AppView._ghIssues = [];

  AppView.startFromAutoSession(90, 5);
  assert.deepEqual(calls.started, [{ slug: 'test-app', issueNumber: 5, entry: 'issue' }]);

  calls.started.length = 0;
  AppView._ghIssues = [{ ...ISSUE, headless: { sessionId: 90 } }];
  AppView.startFromAutoSession(90);
  assert.deepEqual(calls.started, [{ slug: 'test-app', issueNumber: 5, entry: 'issue', issueTitle: 'Fix the thing' }],
    'an older card without the number finds it by the run');
  assertNoClassicSession(calls);
});
