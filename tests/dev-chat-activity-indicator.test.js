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
//   3. ANY live status row → suppressed (#1590). A live step already draws a
//      spinning arc, names itself and counts its own seconds; dots under it
//      are a second answer to the same question, and the bounce climbed into
//      the row above. This started life as a coding-agent-only rule ("that
//      row already paints its own log + ETA") and #1590 generalised it: the
//      dots are for the window where NOTHING is live.
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

const { makeTranscriptBridge } = require('./lib/dev-transcript-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8'
);

// #1078: the dots are a FIELD of the transcript's view model now, so this
// harness no longer has to model the imperative path at all. `_syncActivityNode`
// used to `insertAdjacentHTML('beforeend')` the row and `getElementById(
// 'dc-spinner').remove()` it, precisely so a show/hide need not re-render the
// list; both directions are one publish, and the list is a reconcile.
function makeDevChat() {
  const t = makeTranscriptBridge();
  const messagesEl = {
    innerHTML: '',
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0, scrollHeight: 0,
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
      getElementById: (id) => (id === 'dc-messages' ? messagesEl : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    // `_setStreamingUI` republishes the session header, which reads the
    // current app for the back link. It used to bail before that on a null
    // `#dc-session-header`; the strip is a portal now, so the stub is needed.
    App: { currentApp: 'demo-app', switchTab: () => {} },
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
  sandbox.UsernodeReact = { devChat: t.bridge };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.renderMarkdown = (t) => String(t || '');
  DevChat.currentSession = { id: 1, status: 'active' };
  return {
    DevChat,
    getHtml() { return t.html(); },
    render(messages) {
      if (messages) DevChat.messages = messages;
      DevChat.renderMessages();
      return t.html();
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
    statusRow('Fetching github.com...'),
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
  const html = h.render([statusRow('Fetching github.com...')]);
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

// ── 3. One indicator at a time (#1590) ──────────────────────────────────

test('#1590: a live step suppresses the dots — its spinner is the indicator', () => {
  // The reported defect: the ladder's arc spinning on the live row WHILE the
  // dots bounced underneath it, two answers to "is it still working?" in the
  // same 11px column.
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Fetching github.com...', { _active: true }),
  ]);
  assert.ok(html.includes('dc-status-spinner-arc'),
    'the live row draws the arc — that is the one indicator');
  assert.ok(!html.includes(ROW), '…so the dots must not also be there');
});

test('#1590: the pre-log gap before the agent starts is a live row too', () => {
  // This case USED to be the argument for showing both: "the gap before the
  // first cc_progress is the silent window #990 is about". It is not silent —
  // the step is live and spinning, and it says what it is doing.
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Spinning up coding agent...', { _active: true }),
  ]);
  assert.ok(!html.includes(ROW));
});

test('#990: suppressed while a coding-agent run is painting its own progress', () => {
  // The original case, and still the loudest: a scrolling log plus an ETA.
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

test('#990: a frozen ladder still gets the dots — that is the window they are for', () => {
  // Every row finished, the turn still running: nothing on screen says the
  // work is continuing. This is the silent gap #990 was written for, and it
  // is the one state the dots survive #1590 to cover.
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Claude Code is running', { progressLog: ['done'] }),
    statusRow('Thinking about what came back...'),
  ]);
  assert.ok(html.includes(ROW));
  assert.ok(!html.includes('dc-status-spinner-arc'),
    'and nothing else is spinning, so the dots are still the only one');
});

test('#1590: a live row ANYWHERE below a frozen one still suppresses them', () => {
  // The walk skips frozen rows rather than stopping at the last one, which is
  // the search the live-CC-run check already made.
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  const html = h.render([
    statusRow('Fetching github.com...', { _active: true }),
    statusRow('Thinking about what came back...'),
  ]);
  assert.ok(!html.includes(ROW));
});

// ── 4. Survives a re-render ─────────────────────────────────────────────

test('#990: the indicator survives repeated renders', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._showActivity();
  const messages = [statusRow('Thinking about what came back...')];
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
  const messages = [statusRow('Fetching github.com...')];

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
  h.render([statusRow('Fetching github.com...')]);
  h.DevChat._showActivity();
  h.DevChat._showActivity();
  assert.equal(h.getHtml().split(ROW).length - 1, 1);
});

// ── 6. Turn end clears it ───────────────────────────────────────────────

test('#990: _finishStreaming clears the indicator', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._activity = { label: null };
  h.DevChat.messages = [statusRow('Thinking about what came back...')];
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
  const html = h.render([statusRow('Fetching github.com...')]);
  assert.ok(html.includes('dc-activity-label'));
  assert.ok(html.includes('&lt;b&gt;Thinking&lt;/b&gt; &amp; such'));
  assert.ok(!html.includes('<b>Thinking</b>'));
});

test('#990: no label → no empty label span', () => {
  const h = makeDevChat();
  h.DevChat.isStreaming = true;
  h.DevChat._showActivity();
  const html = h.render([statusRow('Fetching github.com...')]);
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

// ── 10. The bounce stays inside its own row (#1590) ─────────────────────

test('#1590: the dots have headroom for the bounce, so they cannot climb into the row above', () => {
  // The other half of the report — "they shouldn't overlap". A dot is 6px and
  // dc-dot-bounce lifts it 6px, so the 2px of top padding it used to have left
  // it rising 4px out of its own row and over the ladder line above. Measured
  // in a browser at both values before this was written.
  const dot = /\.dc-streaming-dots span \{([\s\S]*?)\}/.exec(CSS);
  assert.ok(dot, '.dc-streaming-dots span exists');
  assert.match(dot[1], /height: 6px/, 'a dot is 6px…');
  const bounce = /@keyframes dc-dot-bounce \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(bounce, 'dc-dot-bounce exists');
  assert.match(bounce[1], /translateY\(-6px\)/, '…and the bounce lifts it 6px');
  const row = /\.dc-activity-line \.dc-streaming-dots \{([^}]*)\}/.exec(CSS);
  assert.ok(row, '.dc-activity-line .dc-streaming-dots exists');
  const top = /padding:\s*(\d+)px/.exec(row[1]);
  assert.ok(top, 'it sets a padding');
  assert.ok(Number(top[1]) >= 6,
    `top padding must clear the 6px lift; found ${top && top[1]}px`);
});
