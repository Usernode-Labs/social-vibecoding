// #990: the trailing activity indicator ("thinking" dots) in dev chat.
//
// The old indicator was a node appended once per turn and removed by the
// first `status` event, with nothing ever putting it back — so a long
// data-tool phase ("Fetching github.com...") had no live cue beyond a stale,
// still-spinning status row. It is state now (`DevChat._activity`) that
// renderMessages() emits itself, which is the only shape that survives
// renderMessages assigning container.innerHTML wholesale.
//
// Guarded here:
//   1. streaming + _activity set → the dots are the LAST node in the list.
//   2. _activity null (or not streaming) → no dots at all.
//   3. the trailing live row is a coding-agent run → suppressed (that row
//      already paints its own log + ETA).
//   4. the node survives a re-render — the regression that made the old
//      imperative append useless.
//   5. _showActivity / _hideActivity produce byte-identical DOM to a full
//      re-render, so the imperative and declarative paths can't diverge.
//   6. _finishStreaming() clears it.
//   7. a label, when given, is escaped.
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`); it is loaded
// into a vm context with stubbed browser globals, the same way
// tests/dev-chat-changes-ready-card.test.js does.
//
// Run with: node --test tests/dev-chat-activity-indicator.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// A fake #dc-messages that captures innerHTML and models just enough of the
// DOM for the imperative show/hide path: insertAdjacentHTML('beforeend') and
// getElementById('dc-spinner') → node.remove().
function makeDevChat() {
  let captured = '';
  const messagesEl = {
    set innerHTML(v) { captured = v; },
    get innerHTML() { return captured; },
    insertAdjacentHTML(where, html) {
      assert.equal(where, 'beforeend');
      captured += html;
    },
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0, scrollHeight: 0,
  };
  // The spinner "node" is derived from the captured HTML — present iff the
  // markup contains its id, and .remove() strips exactly that element.
  const spinnerNode = {
    remove() {
      captured = captured.replace(
        /<div id="dc-spinner"[\s\S]*?<\/div><\/div>/,
        ''
      );
    },
  };
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
  };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => {
        if (id === 'dc-messages') return messagesEl;
        if (id === 'dc-spinner') {
          return captured.includes('id="dc-spinner"') ? spinnerNode : null;
        }
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: () => {},
      alert: async () => ({}), confirm: async () => true,
      transition: (fn) => fn(), attachScreenFx: () => {}, detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }), swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.renderMarkdown = (t) => String(t || '');
  DevChat.currentSession = { id: 1, status: 'active' };
  return {
    DevChat,
    getHtml() { return captured; },
    render(messages) {
      if (messages) DevChat.messages = messages;
      DevChat.renderMessages();
      return captured;
    },
  };
}

const DOTS = 'dc-streaming-dots';
const ROW = 'id="dc-spinner"';

const statusRow = (content, over) => ({
  role: 'system', content, created_at: '2026-08-11T00:00:00.000Z',
  _slug: 'aaa111', ...over,
});

// ── 1. Visible while streaming, and it is the trailing node ──────────────

test('#990: streaming + _activity → the dots render last in the list', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    { role: 'user', content: 'what changed in that PR?', created_at: '2026-08-11T00:00:00.000Z', _slug: 'u1' },
    statusRow('Fetching github.com...', { _active: true }),
  ]);

  assert.ok(html.includes(ROW), 'the activity row must render');
  assert.ok(html.includes(DOTS), 'it must reuse the existing bouncing-dots markup');
  assert.ok(html.includes('dc-activity-line'),
    'it must carry the status-line variant class so it aligns with the ladder');
  // Trailing: nothing renders after it.
  assert.ok(html.trimEnd().endsWith('</div></div>'),
    'the activity row must be the last thing in the container');
  assert.ok(html.indexOf(ROW) > html.indexOf('Fetching github.com...'),
    'the dots belong BELOW the step they are covering');
});

// ── 2. Hidden when the flag is down or the turn is over ──────────────────

test('#990: no _activity → no dots', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = null;
  const html = h.render([statusRow('Fetching github.com...', { _active: true })]);
  assert.ok(!html.includes(ROW));
  assert.ok(!html.includes(DOTS));
});

test('#990: not streaming → no dots even with a stale _activity flag', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = false;
  h.DevChat._activity = { label: null };
  const html = h.render([statusRow('Fetching github.com...')]);
  assert.ok(!html.includes(ROW),
    'isStreaming is the outer gate — a leftover flag must never paint dots '
    + 'on an idle transcript');
});

// ── 3. Suppressed under a live coding-agent run ──────────────────────────

test('#990: suppressed while a coding-agent run is painting its own progress', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Claude Code is running', { _active: true, progressLog: ['Edited src/foo.js'] }),
  ]);
  assert.ok(!html.includes(ROW),
    'a live CC row already carries a log and an ETA; dots under it are noise');
  // Sanity: the row really did render as the live coding-run shape (its own
  // log body), so the suppression above is the reason the dots are absent.
  assert.ok(html.includes('dc-cc-attached-log'));
  assert.ok(html.includes('Edited src/foo.js'));
});

test('#990: NOT suppressed during the pre-log gap before the agent starts', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Spinning up coding agent...', { _active: true }),
  ]);
  assert.ok(html.includes(ROW),
    'the gap before the first cc_progress is exactly the silent window #990 '
    + 'is about — it must be covered');
});

test('#990: a FINISHED coding-agent row does not suppress the dots', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Claude Code is running', { progressLog: ['done'] }),
    statusRow('Thinking about what came back...', { _active: true }),
  ]);
  assert.ok(html.includes(ROW),
    '_isLiveCcRun requires _active; a frozen run must not keep the dots off');
});

// ── 4. Survives a re-render ─────────────────────────────────────────────

test('#990: the indicator survives repeated renders', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._showActivity();
  const messages = [statusRow('Thinking about what came back...', { _active: true })];
  const first = h.render(messages);
  assert.ok(first.includes(ROW));
  const second = h.render(messages);
  assert.ok(second.includes(ROW),
    'renderMessages assigns innerHTML wholesale — the indicator has to be '
    + 'state it emits, not a node appended alongside it');
  // Exactly one, not one per render.
  assert.equal(second.split(ROW).length - 1, 1);
});

// ── 5. Imperative and declarative paths agree ───────────────────────────

test('#990: _showActivity/_hideActivity match a full re-render byte for byte', () => {
  const messages = [statusRow('Fetching github.com...', { _active: true })];

  const a = makeDevChat();
  a.DevChat.isStreaming = true;
  a.render(messages);            // no dots yet
  a.DevChat._showActivity();     // imperative append
  const imperative = a.getHtml();

  const b = makeDevChat();
  b.DevChat.isStreaming = true;
  b.DevChat._activity = { label: null };
  const declarative = b.render(messages);

  assert.equal(imperative, declarative);

  // …and hiding gets back to the no-dots render.
  a.DevChat._hideActivity();
  const c = makeDevChat();
  c.DevChat.isStreaming = true;
  assert.equal(a.getHtml(), c.render(messages));
});

test('#990: _showActivity twice does not stack two indicators', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.render([statusRow('Fetching github.com...', { _active: true })]);
  h.DevChat._showActivity();
  h.DevChat._showActivity();
  assert.equal(h.getHtml().split(ROW).length - 1, 1);
});

// ── 6. Turn end clears it ───────────────────────────────────────────────

test('#990: _finishStreaming clears the indicator', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  h.DevChat.messages = [statusRow('Thinking about what came back...', { _active: true })];
  h.DevChat.renderMessages();
  assert.ok(h.getHtml().includes(ROW));

  h.DevChat._finishStreaming();
  assert.equal(h.DevChat._activity, null);
  assert.ok(!h.getHtml().includes(ROW),
    'the dots must not outlive the turn — _activity is cleared BEFORE '
    + '_finishStreaming re-renders');
});

// ── 7. Fresh-bubble deactivation ────────────────────────────────────────

test('#990: _deactivateStatusForFreshBubble freezes the live step row', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat.messages = [
    statusRow('Thinking about what came back...', { _active: true, _startedAt: 1 }),
  ];
  h.DevChat._deactivateStatusForFreshBubble();
  assert.ok(!h.DevChat.messages[0]._active,
    'once the reply starts, the step that was running has finished — exactly '
    + 'one row may read as live');
});

test('#990: _deactivateStatusForFreshBubble leaves a live coding run alone', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat.messages = [
    statusRow('Claude Code is running', {
      _active: true, progressLog: ['x'], _estimate: 'about 2 min',
    }),
  ];
  h.DevChat._deactivateStatusForFreshBubble();
  assert.ok(h.DevChat.messages[0]._active,
    'a coding agent that is still running must keep its live row');
  assert.equal(h.DevChat.messages[0]._estimate, 'about 2 min',
    '_deactivateLastStatus also clears the AI progress guess — that is why '
    + 'the CC guard exists');
});

// ── 8. Optional label ───────────────────────────────────────────────────

test('#990: a label renders muted and escaped', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._showActivity('<b>Thinking</b> & such');
  const html = h.render([statusRow('Fetching github.com...', { _active: true })]);
  assert.ok(html.includes('dc-activity-label'));
  assert.ok(html.includes('&lt;b&gt;Thinking&lt;/b&gt; &amp; such'));
  assert.ok(!html.includes('<b>Thinking</b>'));
});

test('#990: no label → no empty label span', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._showActivity();
  const html = h.render([statusRow('Fetching github.com...', { _active: true })]);
  assert.ok(!html.includes('dc-activity-label'));
});

// ── 9. The legacy names stay wired to the same state ────────────────────

test('#990: _showSpinner/_removeSpinner drive the same single source of truth', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._showSpinner();
  assert.ok(h.DevChat._activity, '_showSpinner must set the state, not append a node');
  h.DevChat._removeSpinner();
  assert.equal(h.DevChat._activity, null);
});
