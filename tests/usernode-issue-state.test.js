// Tests for the opt-in issue-state snapshot API added to the hosted
// bridge (issue #685). The API lives in
// public/usernode-bridge/v1/bridge.js (mirrored byte-for-byte in
// public/usernode-bridge.js): apps register a provider via
// usernode.issueState.register(fn); the bridge announces availability
// to the parent shell and answers `collect` requests with the
// serialized (and, when oversized, truncated) snapshot.
//
// The behavioural assertions extract the self-contained issue-state
// IIFE (between the __USERNODE_ISSUE_STATE_BEGIN__ / _END__ markers)
// and run it in a minimal fake-window sandbox — the same
// regex-extraction style as tests/usernode-invariants.test.js. Unlike
// that sandbox, setTimeout must NOT fire synchronously here (the
// collect path arms a provider-timeout timer before the provider
// resolves), so timers are captured and fired manually.
//
// Run with: node --test tests/usernode-issue-state.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const versioned = path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js');
const unversioned = path.join(root, 'public', 'usernode-bridge.js');

function bridgeSource() {
  return fs.readFileSync(versioned, 'utf8');
}

function extractIssueState(src) {
  const begin = src.indexOf('/* __USERNODE_ISSUE_STATE_BEGIN__ */');
  const end = src.indexOf('/* __USERNODE_ISSUE_STATE_END__ */');
  assert.ok(begin !== -1 && end !== -1 && end > begin, 'issue-state block markers present');
  return src.slice(begin, end);
}

// Build a sandbox whose `window` defines `usernode` (the bridge's outer
// IIFE normally does this) and captures parent postMessages, message
// listeners, and timers (fired manually via fireTimers()).
function makeSandbox() {
  const posts = [];
  const listeners = {};
  const timers = [];
  const fakeWindow = {
    usernode: {},
    parent: { postMessage: (msg) => posts.push(msg) },
    addEventListener: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
  };
  const sandbox = {
    window: fakeWindow,
    setTimeout: (cb, ms) => { timers.push({ cb, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, posts, listeners, timers, fakeWindow };
}

function loadRunner() {
  const ctx = makeSandbox();
  vm.runInContext(extractIssueState(bridgeSource()), ctx.sandbox);
  return ctx;
}

// Deliver a message event to the bridge's listener as if it came from
// the parent shell (the listener guards on e.source === window.parent).
function collect(ctx, id) {
  for (const cb of ctx.listeners.message || []) {
    cb({ source: ctx.fakeWindow.parent, data: { __usernode_issue_state: 'collect', id } });
  }
}

// The provider result rides Promise.resolve().then(...) inside the vm —
// flush the microtask queue so the response post has landed.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('the two hosted bridge copies stay byte-identical', () => {
  assert.equal(fs.readFileSync(unversioned, 'utf8'), bridgeSource());
});

test('register announces available; unregister announces unavailable', () => {
  const { posts, fakeWindow } = loadRunner();
  assert.equal(posts.length, 0, 'no-op until something registers');
  fakeWindow.usernode.issueState.register(() => ({}));
  // Posts are constructed inside the vm context — compare by value, not
  // deepEqual (which also checks prototype identity).
  assert.equal(posts.length, 1);
  assert.equal(posts[0].__usernode_issue_state, 'available');
  fakeWindow.usernode.issueState.unregister();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].__usernode_issue_state, 'unavailable');
});

test('register rejects a non-function provider', () => {
  const { fakeWindow } = loadRunner();
  assert.throws(() => fakeWindow.usernode.issueState.register('not-a-fn'), /must be a function/);
});

test('collect with no provider responds with an error', () => {
  const ctx = loadRunner();
  collect(ctx, 'c1');
  assert.equal(ctx.posts.length, 1);
  assert.equal(ctx.posts[0].__usernode_issue_state, 'response');
  assert.equal(ctx.posts[0].id, 'c1');
  assert.equal(ctx.posts[0].value, null);
  assert.equal(ctx.posts[0].error, 'no provider registered');
});

test('collect invokes the provider and responds with serialized state', async () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => ({ view: 'board', count: 3 }));
  collect(ctx, 'c2');
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.ok(resp, 'response posted');
  assert.equal(resp.id, 'c2');
  assert.equal(resp.error, null);
  assert.equal(resp.value.json, '{"view":"board","count":3}');
  assert.equal(resp.value.truncated, false);
});

test('an async (Promise-returning) provider works', async () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => Promise.resolve({ ok: true }));
  collect(ctx, 'c3');
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.value.json, '{"ok":true}');
});

test('a throwing provider responds with its error, not silence', async () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => { throw new Error('kaboom'); });
  assert.doesNotThrow(() => collect(ctx, 'c4'));
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.value, null);
  assert.match(resp.error, /kaboom/);
});

test('a rejecting provider responds with its error', async () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => Promise.reject(new Error('later-boom')));
  collect(ctx, 'c5');
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.value, null);
  assert.match(resp.error, /later-boom/);
});

test('non-serializable state (circular) responds with an error', async () => {
  const ctx = loadRunner();
  const circular = {};
  circular.self = circular;
  ctx.fakeWindow.usernode.issueState.register(() => circular);
  collect(ctx, 'c6');
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.value, null);
  assert.equal(resp.error, 'state not serializable');
});

test('oversized state is sliced to 32,768 chars and flagged truncated', async () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => ({ blob: 'x'.repeat(40000) }));
  collect(ctx, 'c7');
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.error, null);
  assert.equal(resp.value.json.length, 32768);
  assert.equal(resp.value.truncated, true);
});

test('a hung provider times out; a late resolve cannot double-respond', async () => {
  const ctx = loadRunner();
  let resolveLater;
  ctx.fakeWindow.usernode.issueState.register(
    () => new Promise((resolve) => { resolveLater = resolve; })
  );
  ctx.posts.length = 0; // drop the register announcement
  collect(ctx, 'c8');
  await flush();
  assert.equal(ctx.posts.length, 0, 'no response while the provider hangs');
  // Fire the armed provider-timeout timer manually.
  const pending = ctx.timers.filter((t) => !t.cleared);
  assert.equal(pending.length, 1, 'one provider-timeout timer armed');
  assert.equal(pending[0].ms, 3000);
  pending[0].cb();
  assert.equal(ctx.posts.length, 1);
  assert.equal(ctx.posts[0].error, 'provider timed out');
  // The provider resolving afterwards must not post a second response.
  resolveLater({ too: 'late' });
  await flush();
  assert.equal(ctx.posts.length, 1, 'settled guard suppresses the late resolve');
});

test('repeat register replaces the provider (last write wins)', async () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => ({ gen: 1 }));
  ctx.fakeWindow.usernode.issueState.register(() => ({ gen: 2 }));
  collect(ctx, 'c9');
  await flush();
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.value.json, '{"gen":2}');
});

test('collect after unregister responds with no-provider error', () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => ({}));
  ctx.fakeWindow.usernode.issueState.unregister();
  collect(ctx, 'c10');
  const resp = ctx.posts.find((p) => p.__usernode_issue_state === 'response');
  assert.equal(resp.error, 'no provider registered');
});

test('messages not from the parent are ignored', () => {
  const ctx = loadRunner();
  ctx.fakeWindow.usernode.issueState.register(() => ({}));
  const postsBefore = ctx.posts.length;
  for (const cb of ctx.listeners.message || []) {
    cb({ source: { some: 'other-frame' }, data: { __usernode_issue_state: 'collect', id: 'evil' } });
  }
  assert.equal(ctx.posts.length, postsBefore, 'no response to a non-parent source');
});

// ── Source-level guarantees (mirrors usernode-bridge.test.js style) ───

test('bridge exposes the issueState API on the __usernode_issue_state family', () => {
  const src = bridgeSource();
  assert.match(src, /window\.usernode\.issueState/);
  assert.match(src, /register: function register\(fn\)/);
  assert.match(src, /unregister: function unregister\(\)/);
  assert.match(src, /__usernode_issue_state/);
  assert.match(src, /"provider timed out"/);
  assert.match(src, /"state not serializable"/);
});
