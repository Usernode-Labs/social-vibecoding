'use strict';

// 3 Nov 2026 (#6213): the suggested replies under Homeroom bot's message in
// a request's or a change's discussion. Pinned here: who is shown them (the
// people its metadata names, and only while the set is open), that a tap
// sends the label as that person's own reply in the message's own thread,
// and that the transcript draws the row only for the person it is for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The module reads catalog text only when it draws a row, which these tests
// do not; the ids are enough.
const i18n = { t: (key) => key, errorText: () => '' };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadGroupChat(userId = 9) {
  const sandbox = {
    window: {},
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: () => null, addEventListener() {} },
    App: { user: { id: userId } },
    PlatformI18n: i18n,
  };
  // In a browser these are the same object; the module reads `window.App`.
  sandbox.window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  return sandbox.window.GroupChat;
}

const view = (over = {}) => ({
  homeroomBot: {
    kind: 'note',
    suggest: { status: 'open', forUserIds: [9, 12] },
    actions: [
      { id: 'go_ahead', label: 'Go ahead', style: 'primary', type: 'prompt' },
      { id: 'smaller', label: 'Just the triage part', style: 'secondary', type: 'prompt' },
      { id: 'not_now', label: 'Not now', style: 'secondary', type: 'prompt' },
    ],
    ...over.bot,
  },
  ...over.meta,
});

test('only the people the message names see its suggestions', () => {
  const named = loadGroupChat(9)._botSuggestView(view());
  assert.equal(named.status, 'open');
  assert.equal(named.forMe, true);
  assert.deepEqual(named.actions.map((a) => [a.label, a.primary]),
    [['Go ahead', true], ['Just the triage part', false], ['Not now', false]]);

  assert.equal(loadGroupChat(10)._botSuggestView(view()).forMe, false, 'somebody else sees none');
  assert.equal(loadGroupChat(null)._botSuggestView(view()).forMe, false, 'a signed-out reader sees none');
});

test('a closed set, another message, or a read-only viewer draws nothing', () => {
  assert.equal(loadGroupChat(9)._botSuggestView(view({ bot: { suggest: { status: 'closed', forUserIds: [9] } } })).status, 'closed');
  assert.equal(loadGroupChat(9)._botSuggestView(view({ bot: { suggest: null } })), null);
  assert.equal(loadGroupChat(9)._botSuggestView({}), null);
  const readOnly = loadGroupChat(9);
  readOnly._app = { readOnly: true };
  assert.equal(readOnly._botSuggestView(view()).forMe, false);
});

test('a tap sends the label as that person\'s reply in the message\'s own thread', () => {
  const gc = loadGroupChat(9);
  gc.messages = [{ id: 5, thread_type: 'issue', thread_ref: 7 }];
  const sent = [];
  gc.send = (content, thread) => { sent.push({ content, thread }); };
  gc.sendBotSuggestion(5, 'Go ahead');
  assert.deepEqual(sent.map((s) => ({ content: s.content, thread: { ...s.thread } })),
    [{ content: 'Go ahead', thread: { type: 'issue', ref: 7 } }]);
  // A change's discussion, and the message not known here: the open thread.
  gc.messages = [{ id: 6, thread_type: 'session', thread_ref: 12 }];
  gc.sendBotSuggestion(6, 'Not now');
  assert.deepEqual({ ...sent[1].thread }, { type: 'session', ref: 12 });
  // A row with no thread facts of its own (the open thread is the scope).
  gc.messages = [{ id: 6 }];
  gc.activeThread = { type: 'issue', ref: 7 };
  gc.sendBotSuggestion(6, 'Go ahead');
  assert.deepEqual({ ...sent[2].thread }, { type: 'issue', ref: 7 });
  // Never from a read-only viewer, and never a blank label.
  gc._app = { readOnly: true };
  gc.sendBotSuggestion(6, 'Go ahead');
  assert.equal(sent.length, 3);
  gc._app = null;
  gc.sendBotSuggestion(6, '   ');
  assert.equal(sent.length, 3);
});

test('the transcript draws the row only for the person it is for', () => {
  const tx = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(tx, /function BotSuggestButtons/);
  assert.match(tx, /data-gc-bot-suggest=""/);
  assert.match(tx, /controller\(\)\?\.sendBotSuggestion\?\.\(id, label\)/);
  assert.match(tx, /msg\.botSuggest && msg\.botSuggest\.forMe && msg\.botSuggest\.status === 'open' && msg\.botSuggest\.actions\.length/);
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'BotSuggestButtons', {
    id: 5,
    suggest: {
      status: 'open',
      forMe: true,
      actions: [
        { id: 'go_ahead', label: 'Go ahead', primary: true },
        { id: 'smaller', label: 'Just the triage part', primary: false },
        { id: 'not_now', label: 'Not now', primary: false },
      ],
    },
  });
  assert.match(html, /data-gc-bot-suggest=""/);
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.ok(html.includes('>Go ahead</button>'));
  assert.ok(html.includes('>Just the triage part</button>'));
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /botSuggest: GroupChat\._botSuggestView\(kind === 'message' && !deleted \? meta : null\)/);
  assert.match(gc, /botSuggest: view\.botSuggest/);
});
