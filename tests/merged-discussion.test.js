// #194 follow-up: the Completed (merged) proposal list becomes openable
// and its discussion thread stays LIVE (editable composer, no read-only
// lock) after merge. Covers the three app-view.js changes:
//   1. _renderMergedInner() rows carry the open-discussion affordance
//      (data-proposal-row, hover class, chevron) + the 💬 badge.
//   2. the delegated #gc-merged click handler opens the proposal topic
//      on a bare-row tap but NOT on its inner button/link controls.
//   3. _mountTopicThread() mounts a merged proposal with an editable
//      composer — no readOnly flag, no "voting closed" notice.
//
// app-view.js is a plain browser script; we load its source into a vm
// context with the external globals stubbed (same approach as
// archive-proposal-card.test.js) and assert on the rendered HTML /
// captured handler calls.
//
// Run with: node --test tests/merged-discussion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// A minimal fake DOM element: records event handlers and stores innerHTML
// as a plain string so renderDevView's template assignment is a no-op we
// can ignore.
function makeEl(id) {
  return {
    id,
    innerHTML: '',
    scrollTop: 0,
    _handlers: {},
    addEventListener(type, fn) { this._handlers[type] = fn; },
    querySelector() { return null; },
    querySelectorAll() { return { forEach() {} }; },
    scrollTo() {},
  };
}

// Load AppView in an isolated vm context. `els` maps element id → fake
// element so callers can inspect handlers bound during renderDevView.
function makeAppView({ els = {}, thread = null } = {}) {
  const getEl = (id) => {
    if (id in els) return els[id];
    els[id] = makeEl(id);
    return els[id];
  };
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentApp: 'demo', switchTab() {} },
    Kudos: { renderButton: () => '<button class="kudos">k</button>' },
    GroupChat: {
      unmountThread() {},
      mountThread(opts) { sandbox.__mountOpts = opts; },
    },
    document: {
      getElementById: (id) => (id === 'dev-topic-thread' ? thread : getEl(id)),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return { AppView, sandbox, els };
}

const mergedPr = (over) => ({
  id: 55,
  pr_number: 700,
  pr_url: 'https://github.com/org/repo/pull/700',
  pr_title: 'Tidy the header',
  username: 'evan',
  user_id: 9,
  status: 'merged',
  created_at: '2026-06-01T00:00:00Z',
  yes_count: 2,
  no_count: 0,
  my_vote: null,
  votes_required: 2,
  active_users_at_merge: 3,
  chat_count: 4,
  ...over,
});

test('_renderMergedInner row is openable: data-proposal-row + hover + chevron', () => {
  const { AppView } = makeAppView();
  AppView._merged = [mergedPr()];
  AppView._mergedCtx = { majority: 2, activeUsers: 3 };
  AppView._mergedExpanded = false;
  const html = AppView._renderMergedInner();
  assert.match(html, /data-proposal-row="55"/, 'row carries the proposal-row hook');
  assert.match(html, /data-ref-pr="700"/, 'existing data-ref-pr preserved');
  assert.match(html, /hover:border-violet-300/, 'hover affordance present');
  assert.match(html, /title="Open this proposal's discussion"/, 'open hint title present');
  assert.match(html, /M9 5l7 7-7 7/, 'chevron svg path present');
});

test('_renderMergedInner shows a visible 💬 badge when chat_count > 0', () => {
  const { AppView } = makeAppView();
  AppView._merged = [mergedPr({ chat_count: 4 })];
  AppView._mergedCtx = { majority: 2, activeUsers: 3 };
  AppView._mergedExpanded = false;
  const html = AppView._renderMergedInner();
  assert.match(html, /dev-chat-badge[^"]*"[^>]*data-count="4"/, 'badge carries the count');
  // The badge wrapper for a non-zero count must NOT carry the `hidden` class.
  const badge = html.match(/<span class="dev-chat-badge[^>]*data-count="4"[^>]*>/)[0];
  assert.doesNotMatch(badge, /\bhidden\b/, 'non-empty badge is visible');
});

test('_renderMergedInner hides the 💬 badge when chat_count is 0', () => {
  const { AppView } = makeAppView();
  AppView._merged = [mergedPr({ chat_count: 0 })];
  AppView._mergedCtx = { majority: 2, activeUsers: 3 };
  AppView._mergedExpanded = false;
  const html = AppView._renderMergedInner();
  const badge = html.match(/<span class="dev-chat-badge[^>]*data-count="0"[^>]*>/)[0];
  assert.match(badge, /\bhidden\b/, 'empty badge is hidden');
});

test('#dev-body tap opens the proposal topic on a bare merged-row click', async () => {
  const { AppView, els } = makeAppView();
  // Stub the heavyweight bits renderDevView reaches so only the handler
  // wiring runs.
  AppView._saveFeedScroll = () => {};
  AppView._wirePlusMenu = () => {};
  AppView._wireViewToggle = () => {};
  AppView._loadChatCardPreview = () => {};
  AppView._renderSessionsStrip = () => {};
  AppView._syncStripPolling = () => {};
  AppView._loadDevFeed = async () => {};
  AppView._getFeedScroll = () => 0;
  const opened = [];
  AppView.openTopic = (kind, id) => opened.push([kind, id]);

  await AppView.renderDevView(undefined, null);

  // The card-open handler is now delegated on the stable #dev-body wrapper,
  // covering merged rows (data-proposal-row) alongside feed and kanban cards.
  const handler = els['dev-body']._handlers.click;
  assert.equal(typeof handler, 'function', 'dev-body click handler bound');

  // Bare-row tap → opens the proposal.
  handler({ target: makeTarget({ '[data-proposal-row]': { dataset: { proposalRow: '55' } } }) });
  assert.deepEqual(opened, [['proposal', 55]], 'bare row opens the topic');

  // Tap on an inner control (button/link) → ignored.
  opened.length = 0;
  handler({ target: makeTarget({ 'a, button, input, form': {}, '[data-proposal-row]': { dataset: { proposalRow: '55' } } }) });
  assert.deepEqual(opened, [], 'inner button/link taps do not open the topic');
});

test('_mountTopicThread mounts a merged proposal with a LIVE editable composer', () => {
  const threadSlot = makeEl('dev-topic-thread');
  const { AppView, sandbox } = makeAppView({ thread: threadSlot });
  AppView._devTopic = { kind: 'proposal', id: 55 };
  AppView._proposals = [];
  AppView._merged = [mergedPr()];

  AppView._mountTopicThread();

  const opts = sandbox.__mountOpts;
  assert.ok(opts, 'GroupChat.mountThread was called');
  assert.equal(opts.type, 'session', 'proposal maps to a session thread');
  assert.equal(opts.ref, 55);
  assert.ok(!opts.readOnly, 'no read-only lock on a merged proposal');
  assert.ok(!opts.notice, 'no "voting closed" notice');
});

// A fake event target whose closest(selector) returns the configured
// match for a given selector string (or null when absent).
function makeTarget(matches) {
  return {
    closest(selector) {
      return Object.prototype.hasOwnProperty.call(matches, selector)
        ? matches[selector]
        : null;
    },
  };
}
