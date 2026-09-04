// #647: Claude Code disclosures inherited from a cloned auto session must
// render COLLAPSED by default, while everything the human's own session
// produces (live or finished) keeps the expanded default.
//
// Three render branches emit <details class="dc-cc-attached">:
//   - a status row paired with an attached progressLog  (persist kind ccrun)
//   - an orphan progressLog row                         (kind ccrunorphan)
//   - a status row carrying ccOutput                    (kind ccout)
// Each must emit data-default-open="0" and NO bare `open` attribute for an
// inherited row — relying on _applyDetailsPersistence to close it after
// paint would flash the whole log for a frame.
//
// Also covers _markInheritedMessages: the metadata.inheritedFrom marker the
// clone route stamps, and the legacy fallback keyed off the canonical
// follow-up prefix for clones that predate the marker.
//
// Harness mirrors tests/dev-chat-changes-ready-card.test.js: load
// dev-chat.js (a plain browser script) into a vm context with stubbed
// browser globals, drive renderMessages() against a fake #dc-messages whose
// innerHTML is captured, and assert on the HTML.
//
// Run with: node --test tests/dev-chat-inherited-cc-collapse.test.js

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
// Loaded alongside dev-chat.js in the browser; supplies the globals the
// collapsed <summary> depends on (summarizeCcProgress → activity snippet +
// step count, formatElapsed → the "(took 4m 12s)" suffix). Without it the
// renderer degrades to empty spans and the summary assertions would pass
// vacuously.
const SUMMARY_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'cc-progress-summary.js'),
  'utf8'
);

function makeDevChat() {
  // #1078: the rows are a React island. `renderMessages` publishes a view
  // model instead of writing this element's innerHTML, so the element is only
  // the portal's host and the markup comes back from the component.
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
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: () => {},
      alert: async () => ({}),
      confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
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
  vm.runInContext(`${SUMMARY_SRC}\n${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.renderMarkdown = (t) => String(t || '');
  return {
    DevChat,
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session || null;
      DevChat.renderMessages();
      return t.html();
    },
    rows: () => t.state().rows,
  };
}

const activeSession = (over) => ({
  id: 7, status: 'active', pr_url: null, pr_number: null, ...over,
});

const PROGRESS_LINES = [
  '[claude (mode build)]',
  'Reading public/js/dev-chat.js',
  '  ⎿ Read: 3152 lines',
  'Editing public/js/dev-chat.js',
  '  ⎿ Edit: ok',
];

// Pull the one <details class="dc-cc-attached"> out of a render so the
// assertions can't be satisfied by some other element on the page.
function attachedTag(html) {
  const m = html.match(/<details class="dc-cc-attached"[^>]*>/);
  assert.ok(m, 'a dc-cc-attached disclosure was rendered');
  return m[0];
}

// React serializes a boolean attribute as `open=""` rather than as the bare
// `open` the template literal wrote. Same attribute, same DOM property; only
// the source text differs, so the two guards below match either form.
function assertCollapsed(tag) {
  assert.match(tag, /data-default-open="0"/, 'default-open flag is 0');
  assert.doesNotMatch(tag, /\sopen(=|\s|>)/, 'no open attribute');
}

function assertExpanded(tag) {
  assert.match(tag, /data-default-open="1"/, 'default-open flag is 1');
  assert.match(tag, /\sopen(=""|)>/, 'open attribute present');
}

// ── inherited rows collapse ────────────────────────────────

test('inherited status + attached progressLog renders COLLAPSED (ccrun)', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      id: 101, role: 'system', content: 'Claude Code is running...',
      inherited: true, durationMs: 252000,
    },
    { id: 102, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES, inherited: true },
  ], activeSession());

  assertCollapsed(attachedTag(html));
  assert.match(html, /data-persist-id="101:ccrun"/, 'persist id keyed off the status row');
  // The summary stays informative while collapsed.
  assert.match(html, /Claude Code is running/, 'status text still in the summary');
  // Chips now, so the `· ` separators are gone: the gap between chips is
  // the gap. Both facts are still in the SUMMARY — a collapsed <details>
  // renders nothing else, so anything a closed card shows has to be there.
  assert.match(html, /class="dc-cc-chips"/, 'the facts are a chip row');
  assert.match(html, /class="dc-cc-current">Editing public\/js\/dev-chat\.js</, 'activity snippet still in the summary');
  assert.match(html, /class="dc-cc-steps">2 steps</, 'step counter still in the summary');
  assert.match(html, /dc-cc-attached-chevron/, 'chevron affordance still rendered');
  assert.match(html, /\(took [^)]+\)/, 'duration still shown on the summary');
});

test('inherited ccOutput row renders COLLAPSED (ccout)', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      id: 201, role: 'system', content: 'Claude Code finished',
      ccOutput: 'Added the thing.\n\n- one\n- two', inherited: true, durationMs: 198000,
    },
  ], activeSession());

  assertCollapsed(attachedTag(html));
  assert.match(html, /data-persist-id="201:ccout"/, 'ccout persist id');
  assert.match(html, /dc-cc-attached-md/, 'the markdown body is still present, just collapsed');
});

test('inherited ORPHAN progressLog row renders COLLAPSED (ccrunorphan)', () => {
  const { render } = makeDevChat();
  // A lone progress row with no pairable predecessor/successor status line.
  const html = render([
    { id: 301, role: 'user', content: 'do the thing' },
    { id: 302, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES, inherited: true },
  ], activeSession());

  assertCollapsed(attachedTag(html));
  assert.match(html, /data-persist-id="302:ccrunorphan"/, 'orphan persist id');
});

// ── own-turn rows stay expanded ────────────────────────────

test('an UNMARKED finished turn stays EXPANDED (ordinary sessions unchanged)', () => {
  const { render } = makeDevChat();
  const html = render([
    { id: 401, role: 'system', content: 'Claude Code is running...', durationMs: 120000 },
    { id: 402, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES },
  ], activeSession());

  assertExpanded(attachedTag(html));
});

test('an UNMARKED live (_active) turn stays EXPANDED so the log streams open', () => {
  const { render } = makeDevChat();
  const html = render([
    { id: 501, role: 'system', content: 'Claude Code is running...', _active: true },
    { id: 502, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES },
  ], activeSession());

  const tag = attachedTag(html);
  assertExpanded(tag);
  assert.match(html, /dc-status-spinner-arc/, 'live row keeps its arc spinner');
});

test('an UNMARKED ccOutput row stays EXPANDED', () => {
  const { render } = makeDevChat();
  const html = render([
    { id: 601, role: 'system', content: 'Claude Code finished', ccOutput: 'Done.' },
  ], activeSession());

  assertExpanded(attachedTag(html));
});

test('a clone mixes both: inherited collapsed, the human own later turn expanded', () => {
  const { render } = makeDevChat();
  const html = render([
    { id: 701, role: 'system', content: 'Claude Code is running...', inherited: true },
    { id: 702, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES, inherited: true },
    { id: 703, role: 'assistant', content: 'This session was cloned from an auto session that ran unattended on GitHub issue #42.' },
    { id: 704, role: 'user', content: 'tweak it' },
    { id: 705, role: 'system', content: 'Claude Code is running...' },
    { id: 706, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES },
  ], activeSession());

  const tags = html.match(/<details class="dc-cc-attached"[^>]*>/g) || [];
  assert.equal(tags.length, 2, 'both runs render a disclosure');
  assertCollapsed(tags[0]);
  assertExpanded(tags[1]);
});

// ── already-collapsed disclosures are untouched ────────────

test('cclog / mayorraw / ccfull disclosures still render without `open`', () => {
  const { render } = makeDevChat();
  const html = render([
    { id: 801, role: 'system', content: 'Claude Code log', ccLog: 'some raw log' },
    { id: 802, role: 'assistant', content: '[CHAT_ONLY] thinking out loud' },
    { id: 803, role: 'assistant', model: 'claude-code/opus', content: 'First para.\n\nAnd a much longer remainder that trips hasMore.' },
  ], activeSession());

  const logs = html.match(/<details class="dc-cc-log"[^>]*>/g) || [];
  assert.ok(logs.length >= 3, 'cclog + mayorraw + ccfull all render');
  for (const tag of logs) {
    assert.doesNotMatch(tag, /\sopen(\s|>)/, 'stays closed by default');
    assert.doesNotMatch(tag, /data-default-open/, 'no default-open flag added');
  }
});

// ── _markInheritedMessages ─────────────────────────────────

test('_markInheritedMessages flags every row carrying metadata.inheritedFrom', () => {
  const { DevChat } = makeDevChat();
  const msgs = [
    { id: 1, role: 'system', content: 'Claude Code is running...', metadata: { inheritedFrom: 55 } },
    { id: 2, role: 'system', content: 'Claude Code finished', metadata: { ccOutput: 'x', inheritedFrom: 55 } },
    { id: 3, role: 'assistant', content: 'This session was cloned from an auto session that ran unattended on GitHub issue #42.', metadata: {} },
    { id: 4, role: 'user', content: 'go on' },
  ];
  DevChat._markInheritedMessages(msgs, activeSession({ cloned_from_session_id: 55 }));

  assert.equal(msgs[0].inherited, true);
  assert.equal(msgs[1].inherited, true);
  assert.ok(!msgs[2].inherited, 'the appended follow-up is NOT inherited');
  assert.ok(!msgs[3].inherited, 'later human rows are NOT inherited');
});

test('_markInheritedMessages falls back to the follow-up boundary for legacy clones', () => {
  const { DevChat } = makeDevChat();
  const msgs = [
    { id: 1, role: 'user', content: 'Please work on GitHub issue #42.' },
    { id: 2, role: 'system', content: 'Claude Code is running...' },
    { id: 3, role: 'system', content: 'Claude Code progress', progressLog: PROGRESS_LINES },
    { id: 4, role: 'assistant', content: 'This session was cloned from an auto session that ran unattended on GitHub issue #42.' },
    { id: 5, role: 'user', content: 'build it' },
    { id: 6, role: 'system', content: 'Claude Code is running...' },
  ];
  DevChat._markInheritedMessages(msgs, activeSession({ cloned_from_session_id: 55 }));

  assert.deepEqual(msgs.map((m) => !!m.inherited), [true, true, true, false, false, false]);
});

test('_markInheritedMessages is a no-op on a non-cloned session', () => {
  const { DevChat } = makeDevChat();
  const msgs = [
    { id: 1, role: 'system', content: 'Claude Code is running...' },
    { id: 2, role: 'assistant', content: 'This session was cloned from an auto session that ran unattended on GitHub issue #42.' },
  ];
  DevChat._markInheritedMessages(msgs, activeSession());
  assert.ok(msgs.every((m) => !m.inherited), 'nothing flagged without cloned_from_session_id');
});

test('_markInheritedMessages leaves a legacy clone alone when no follow-up row matches', () => {
  const { DevChat } = makeDevChat();
  const msgs = [
    { id: 1, role: 'system', content: 'Claude Code is running...' },
    { id: 2, role: 'assistant', content: 'Something else entirely.' },
  ];
  DevChat._markInheritedMessages(msgs, activeSession({ cloned_from_session_id: 55 }));
  assert.ok(msgs.every((m) => !m.inherited), 'degrades to today behaviour, never guesses');
});

test('the marker wins over the fallback (no boundary scan when markers exist)', () => {
  const { DevChat } = makeDevChat();
  const msgs = [
    { id: 1, role: 'user', content: 'unmarked leading row' },
    { id: 2, role: 'system', content: 'Claude Code finished', metadata: { inheritedFrom: 55 } },
    { id: 3, role: 'assistant', content: 'This session was cloned from an auto session that ran unattended on GitHub issue #42.' },
  ];
  DevChat._markInheritedMessages(msgs, activeSession({ cloned_from_session_id: 55 }));
  assert.ok(!msgs[0].inherited, 'the fallback did not run');
  assert.equal(msgs[1].inherited, true);
});
