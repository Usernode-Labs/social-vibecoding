'use strict';

// #2236: a comment an agent posted on someone's behalf (connector / CLI) says
// so beside the author's name, in both places comments are read: the card's
// reply preview (dev board) and the full thread (group chat transcript).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement, renderComponent } = require('./lib/render-tsx');

const FEED = loadTsx('frontend/src/features/dev-board/card/feed-thread.tsx');

test('the card preview carries the agent flag from the message metadata', () => {
  const { messages } = FEED.feedThreadPreview([
    { id: 1, username: 'alice', content: 'by hand', msg_type: 'message', metadata: {}, created_at: '2026-09-15T10:00:00Z' },
    { id: 2, username: 'alice', content: 'by agent', msg_type: 'message', metadata: { via: 'agent' }, created_at: '2026-09-15T10:01:00Z' },
  ]);
  assert.deepEqual(messages.map((m) => !!m.agent), [false, true]);
  assert.ok(!('agent' in messages[0]), 'a typed reply keeps its old shape');
});

test('a card reply an agent wrote shows "via agent" beside the name; a typed one does not', () => {
  const base = { id: 1, author: 'alice', userId: 9, content: 'hi', createdAt: '2026-09-15T10:00:00Z' };
  const agent = renderToHtml(createElement(FEED.MessageLine, { m: { ...base, agent: true } }));
  assert.match(agent, /dev-feed-msg-author">alice<\/span><span class="dev-feed-msg-agent"[^>]*>via agent<\/span>/);
  const typed = renderToHtml(createElement(FEED.MessageLine, { m: { ...base, agent: false } }));
  assert.doesNotMatch(typed, /via agent/);
});

function loadGroupChat() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document: {
      createElement() {
        let text = '';
        return {
          set textContent(v) { text = String(v); },
          get textContent() { return text; },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
          set innerHTML(_v) {},
        };
      },
      getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, body: { appendChild() {} },
    },
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'me' } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nglobalThis.__GC = GroupChat;`, sandbox);
  return sandbox.__GC;
}

test('the full thread marks an agent-written message, and only a message', () => {
  const GroupChat = loadGroupChat();
  const msg = (over) => ({ id: 3, username: 'alice', content: 'x', msgType: 'message', userId: 2, createdAt: '2026-09-15T10:00:00Z', ...over });
  assert.equal(GroupChat._messageView(msg({ metadata: { via: 'agent' } })).agent, true);
  assert.equal(GroupChat._messageView(msg({})).agent, false);
  assert.equal(GroupChat._messageView(msg({ msgType: 'system', metadata: { via: 'agent' } })).agent, false,
    'a system line has no author to qualify');

  const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'MessageRow',
    { msg: GroupChat._messageView(msg({ metadata: { via: 'agent' } })) });
  assert.match(html, /class="gc-msg-agent"[^>]*>via agent</);
  assert.match(html, /title="Posted by an agent on alice(&#x27;|')s behalf"/);
});
