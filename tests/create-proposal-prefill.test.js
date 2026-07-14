// #609: "Create proposal" prefills the kickoff message instead of sending it.
// AppView.createPrForIssue used to create the session, navigate, and
// immediately DevChat.sendMessage(seed) — kicking off the agent before the
// user could edit anything. It now stashes the seed as the session's draft
// (DevChat._setDraft) BEFORE App.switchTab, so the chat view's render path
// (_restoreDraft) fills the composer unsent, plus a direct-set fallback for
// localStorage-disabled browsers and a fine-pointer-only focus. These tests
// pin that contract: _setDraft gets the EXACT seed text, sendMessage is
// never called, and the pre-existing switchTab / optimistic myPrSessionId
// behaviour is preserved.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and spy on the DevChat /
// App collaborators — same harness as card-action-layout.test.js.
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

// Fake #dc-input textarea the fallback/focus path can poke at.
function makeInput() {
  return {
    value: '',
    style: {},
    scrollHeight: 40,
    focused: false,
    selection: null,
    focus() { this.focused = true; },
    setSelectionRange(a, b) { this.selection = [a, b]; },
  };
}

function makeHarness({ input = null, coarsePointer = false, draftWorks = true } = {}) {
  const calls = {
    createSession: [],
    setDraft: [],
    sendMessage: [],
    switchTab: [],
    repaint: 0,
  };
  const sandbox = {
    console,
    relTime: () => 'just now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    ProposalDiscuss: { open: () => {} },
    document: {
      getElementById: (id) => (id === 'dc-input' ? input : null),
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
    App: {
      user: { id: 42 },
      switchTab: async (...args) => { calls.switchTab.push(args); },
    },
    DevChat: {
      createSession: async (...args) => {
        calls.createSession.push(args);
        return { id: 42 };
      },
      _drafts: {},
      _setDraft(sessionId, value) {
        calls.setDraft.push([sessionId, value]);
        if (draftWorks) this._drafts[sessionId] = value;
      },
      sendMessage: (...args) => { calls.sendMessage.push(args); },
      _isCoarsePointer: () => coarsePointer,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'test-app' };
  AppView._repaintCards = () => { calls.repaint++; };
  return { AppView, calls, sandbox };
}

const ISSUE = { number: 5, title: 'Fix the thing', body: 'It is broken in two ways.' };

// The exact seed wording is pinned byte-for-byte: on an unedited send the
// Mayor's issue-linking / `Closes #N` behaviour must be identical to the
// old auto-send flow.
const EXPECTED_SEED =
  'Please implement GitHub issue #5: "Fix the thing".\n\nIt is broken in two ways.\n\n'
  + 'Open a PR that closes this issue (include "Closes #5" so it links and closes the issue on merge).';

test('createPrForIssue: stashes the exact seed as a draft, never sends', async () => {
  const { AppView, calls } = makeHarness();
  AppView._ghIssues = [{ ...ISSUE }];

  await AppView.createPrForIssue(5);

  assert.equal(calls.setDraft.length, 1, '_setDraft called once');
  assert.deepEqual(calls.setDraft[0], [42, EXPECTED_SEED], 'draft keyed to the new session with the exact seed');
  assert.equal(calls.sendMessage.length, 0, 'sendMessage is NEVER called');
});

test('createPrForIssue: draft is set before switchTab, and existing nav/flip behaviour holds', async () => {
  const order = [];
  const { AppView, calls, sandbox } = makeHarness();
  const issue = { ...ISSUE };
  AppView._ghIssues = [issue];
  const origSetDraft = sandbox.DevChat._setDraft.bind(sandbox.DevChat);
  sandbox.DevChat._setDraft = (...a) => { order.push('setDraft'); origSetDraft(...a); };
  sandbox.App.switchTab = async (...args) => { order.push('switchTab'); calls.switchTab.push(args); };

  await AppView.createPrForIssue(5);

  assert.deepEqual(order, ['setDraft', 'switchTab'], 'draft stashed BEFORE navigating so _restoreDraft finds it');
  assert.deepEqual(calls.switchTab, [['dev', 42, 'sessions']], 'navigates to the new session');
  assert.deepEqual(calls.createSession, [['test-app', 5]], 'session created with the issue number (#287 link)');
  assert.equal(issue.myPrSessionId, 42, 'optimistic has-session flip preserved');
  assert.equal(calls.repaint, 1, 'row repainted for the button flip');
});

test('createPrForIssue: fallback fills an empty composer and focuses on fine pointers', async () => {
  const input = makeInput();
  const { AppView } = makeHarness({ input, coarsePointer: false });
  AppView._ghIssues = [{ ...ISSUE }];

  await AppView.createPrForIssue(5);

  assert.equal(input.value, EXPECTED_SEED, 'empty box gets the seed directly');
  assert.equal(input.focused, true, 'focused on fine-pointer devices');
  assert.deepEqual(input.selection, [EXPECTED_SEED.length, EXPECTED_SEED.length], 'cursor parked at the end');
});

test('createPrForIssue: fallback never clobbers a box _restoreDraft already filled', async () => {
  const input = makeInput();
  input.value = 'already restored by _restoreDraft';
  const { AppView } = makeHarness({ input, coarsePointer: false });
  AppView._ghIssues = [{ ...ISSUE }];

  await AppView.createPrForIssue(5);

  assert.equal(input.value, 'already restored by _restoreDraft', 'non-empty box left alone');
  assert.equal(input.focused, true, 'still focused on desktop');
});

test('createPrForIssue: no focus on coarse-pointer (touch) devices — #568', async () => {
  const input = makeInput();
  const { AppView } = makeHarness({ input, coarsePointer: true });
  AppView._ghIssues = [{ ...ISSUE }];

  await AppView.createPrForIssue(5);

  assert.equal(input.value, EXPECTED_SEED, 'box still filled');
  assert.equal(input.focused, false, 'no focus — would pop the on-screen keyboard');
});

test('createPrForIssue: issue missing from cache still drafts (empty title/body), never sends', async () => {
  const { AppView, calls } = makeHarness();
  AppView._ghIssues = [];

  await AppView.createPrForIssue(7);

  assert.equal(calls.setDraft.length, 1);
  const [, seed] = calls.setDraft[0];
  assert.match(seed, /^Please implement GitHub issue #7: ""\./, 'seed built with empty title');
  assert.match(seed, /Closes #7/, 'Closes line present');
  assert.equal(calls.sendMessage.length, 0, 'still nothing sent');
});
