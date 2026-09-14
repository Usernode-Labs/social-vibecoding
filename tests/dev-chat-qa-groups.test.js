// The quick-check step could not be completed: `_qaCurrentGroups` was called
// in five places and defined in none (#1601).
//
// Every Q/A interaction reads it first — the chip tap (`_onQaChipClick`), the
// escape hatch, the number stepper (`_onQaStep`), its typed commit
// (`_onQaNumberCommit`), "Send answers" (`_qaSendSelected`) and "Use the
// suggested defaults" (`_qaSendDefaults`). With the method missing each threw
// `DevChat._qaCurrentGroups is not a function` on its first line, so both
// buttons and every chip did nothing at all. That is the reported blocker:
// "selecting use the suggested defaults does nothing, send answers does
// nothing - not able to continue".
//
// The rule it implements is `_buildChatView`'s `wantsQa`, and the two MUST
// agree about which message is being answered — a handler acting on a
// different message than the one whose chips are on screen would answer the
// wrong question. Most of this file is that agreement.
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`), so it is
// loaded into a vm context and driven directly, the same way
// tests/archive-session-list.test.js does. Calling the REAL object is the
// point here: a hand-rolled copy of the method would have passed happily
// while the shipped one did not exist.
//
// Run with: node --test tests/dev-chat-qa-groups.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8');

function loadDevChat() {
  const noop = () => {};
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => ({
      style: {}, classList: { add: noop, remove: noop },
      appendChild: noop, setAttribute: noop,
    }),
    body: { appendChild: noop, addEventListener: noop },
  };
  const sandbox = {
    console,
    document,
    escapeHtml: (s) => String(s == null ? '' : s),
    requestAnimationFrame: noop,
    alert: noop,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: noop,
    removeEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // The four answer stores are reset by the send path (see `_qaSelection = {}`
  // and its three siblings in sendMessage); a transcript loaded straight into
  // the object has not been through it, so seed them the same way rather than
  // leaving the handlers to index undefined.
  DevChat._qaSelection = {};
  DevChat._qaTyped = {};
  DevChat._qaTypedOpen = {};
  DevChat._qaNumber = {};
  return DevChat;
}

const GROUPS = [{ question: 'How many?', answers: ['one', 'two'] }];

/** The real method, on the real object, for one transcript. */
function groupsFor(currentSession, messages) {
  const DevChat = loadDevChat();
  DevChat.currentSession = currentSession;
  DevChat.messages = messages;
  return DevChat._qaCurrentGroups();
}

test('the method exists on the shipped object — the whole of #1601', () => {
  const DevChat = loadDevChat();
  assert.equal(typeof DevChat._qaCurrentGroups, 'function',
    'five call sites had nothing to call');
  // And every one of those call sites is still there to need it.
  assert.equal((SRC.match(/DevChat\._qaCurrentGroups\(\)/g) || []).length, 5);
});

test('neither button throws any more, on a real question', () => {
  // The regression, reproduced at the level it was reported: press the two
  // controls and see whether anything reaches sendMessage.
  for (const press of ['_qaSendDefaults', '_qaSendSelected']) {
    const DevChat = loadDevChat();
    DevChat.currentSession = { status: 'active' };
    DevChat.messages = [{ role: 'assistant', suggestions: GROUPS }];
    DevChat.isStreaming = false;
    const sent = [];
    DevChat.sendMessage = (text) => sent.push(text);
    if (press === '_qaSendSelected') DevChat._qaSelection[0] = 1;
    DevChat[press]();
    assert.equal(sent.length, 1, `${press} sent nothing`);
    assert.match(sent[0], /^1\. /);
  }
});

test('"use the suggested defaults" takes the first answer of every group', () => {
  const DevChat = loadDevChat();
  DevChat.currentSession = { status: 'active' };
  DevChat.messages = [{
    role: 'assistant',
    suggestions: [
      { question: 'A?', answers: ['a1', 'a2'] },
      { question: 'B?', answers: ['b1', 'b2'] },
    ],
  }];
  DevChat.isStreaming = false;
  const sent = [];
  DevChat.sendMessage = (text) => sent.push(text);
  DevChat._qaSendDefaults();
  assert.deepEqual(sent, ['1. a1\n2. b1']);
});

test('an assistant question in an interactive session yields its RAW groups', () => {
  const groups = groupsFor({ status: 'active' }, [
    { role: 'user', content: 'go' },
    { role: 'assistant', suggestions: GROUPS },
  ]);
  assert.deepEqual(groups, GROUPS);
  // Raw suggestions, not _qaSpec's render view: the handlers index
  // `groups[gi].answers[ai]` expecting plain answer strings.
  assert.equal(typeof groups[0].answers[0], 'string');
});

test('system rows are skipped on the way back, as the renderer does', () => {
  assert.deepEqual(
    groupsFor({ status: 'active' }, [
      { role: 'assistant', suggestions: GROUPS },
      { role: 'system', content: 'a build note' },
    ]),
    GROUPS);
});

test('once the viewer has replied there is nothing to answer', () => {
  // The chips vanish when the question stops being the last row, so the
  // buttons must not act on the question above the reply.
  assert.equal(groupsFor({ status: 'active' }, [
    { role: 'assistant', suggestions: GROUPS },
    { role: 'user', content: '1. one' },
  ]), null);
});

test('a session the viewer cannot act in offers nothing', () => {
  for (const status of ['merged', 'closed', 'paused']) {
    assert.equal(
      groupsFor({ status }, [{ role: 'assistant', suggestions: GROUPS }]), null, status);
  }
  assert.equal(groupsFor(null, [{ role: 'assistant', suggestions: GROUPS }]), null);
  for (const status of ['active', 'promoted']) {
    assert.deepEqual(
      groupsFor({ status }, [{ role: 'assistant', suggestions: GROUPS }]), GROUPS, status);
  }
});

test('an assistant message with no suggestions is not a question', () => {
  for (const suggestions of [undefined, null, [], 'nope']) {
    assert.equal(
      groupsFor({ status: 'active' }, [{ role: 'assistant', suggestions }]),
      null, JSON.stringify(suggestions));
  }
});

test('an empty transcript answers null rather than throwing', () => {
  assert.equal(groupsFor({ status: 'active' }, []), null);
  assert.equal(groupsFor({ status: 'active' }, undefined), null);
});

test('it mirrors _buildChatView’s wantsQa, so the two cannot disagree', () => {
  // If the renderer's rule moves, this pins that the accessor moved with it.
  const wants = SRC.slice(SRC.indexOf('const wantsQa ='), SRC.indexOf('const wantsQa =') + 220);
  assert.match(wants, /msgIdx === qaLastConvoIdx/);
  assert.match(wants, /Array\.isArray\(msg\.suggestions\) && msg\.suggestions\.length/);
  const interactive = SRC.slice(SRC.indexOf('const qaInteractive ='));
  assert.match(interactive.slice(0, 160), /'active' \|\| session\.status === 'promoted'/);
});
