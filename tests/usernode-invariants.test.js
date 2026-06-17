// Tests for the opt-in rendering-invariants runner added to the hosted
// bridge (issue #360). The runner lives in
// public/usernode-bridge/v1/bridge.js (mirrored byte-for-byte in
// public/usernode-bridge.js) and reports violations through the
// existing `__usernodeDevConsole` postMessage sentinel.
//
// The behavioural assertions extract the self-contained invariants IIFE
// (between the __USERNODE_INVARIANTS_BEGIN__ / _END__ markers) and run
// it in a minimal fake-window sandbox — the same regex-extraction style
// the bridge is already tested with, without needing a real DOM.
//
// Run with: node --test tests/usernode-invariants.test.js

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

function extractInvariants(src) {
  const begin = src.indexOf('/* __USERNODE_INVARIANTS_BEGIN__ */');
  const end = src.indexOf('/* __USERNODE_INVARIANTS_END__ */');
  assert.ok(begin !== -1 && end !== -1 && end > begin, 'invariants block markers present');
  return src.slice(begin, end);
}

// Build a sandbox whose `window` defines `usernode` (the bridge's outer
// IIFE normally does this) and captures postMessages + listeners.
function makeSandbox() {
  const posts = [];
  const listeners = {};
  const fakeWindow = {
    usernode: {},
    parent: { postMessage: (msg) => posts.push(msg) },
    addEventListener: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    // Run rAF synchronously so a scheduled evaluation happens immediately.
    requestAnimationFrame: (cb) => { cb(); return 1; },
  };
  fakeWindow.parent.usernode = {}; // ensure parent !== window by identity anyway
  const sandbox = {
    window: fakeWindow,
    location: { href: 'http://app.example/' },
    Date: { now: () => 123 },
    setTimeout: (cb) => { cb(); return 0; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, posts, listeners, fakeWindow };
}

function loadRunner() {
  const ctx = makeSandbox();
  vm.runInContext(extractInvariants(bridgeSource()), ctx.sandbox);
  return ctx;
}

// Fire a synthetic resize so a registered-but-passing invariant gets
// re-evaluated (used to prove debouncing of an unchanged failure).
function fireResize(listeners) {
  for (const cb of listeners.resize || []) cb();
}

test('the two hosted bridge copies stay byte-identical', () => {
  assert.equal(fs.readFileSync(unversioned, 'utf8'), bridgeSource());
});

test('no-op until something is registered', () => {
  const { posts, listeners, fakeWindow } = loadRunner();
  assert.equal(typeof fakeWindow.usernode.invariants.register, 'function');
  assert.equal(posts.length, 0);
  // No resize/orientation listeners are wired before the first register.
  assert.equal((listeners.resize || []).length, 0);
  assert.equal((listeners.orientationchange || []).length, 0);
});

test('a passing invariant reports nothing', () => {
  const { posts, fakeWindow } = loadRunner();
  fakeWindow.usernode.invariants.register('always-true', () => true);
  assert.equal(posts.length, 0);
});

test('a failing invariant posts a kind:invariant error on the dev-console sentinel', () => {
  const { posts, fakeWindow } = loadRunner();
  fakeWindow.usernode.invariants.register('canvas-fills-window', () => 'canvas 800x600 != 1600x1200');
  assert.equal(posts.length, 1);
  const m = posts[0];
  assert.equal(m.sentinel, '__usernodeDevConsole');
  assert.equal(m.level, 'error');
  assert.equal(m.kind, 'invariant');
  // m.args is an Array constructed inside the vm context, so compare by
  // value rather than deepEqual (which also checks prototype identity).
  assert.equal(m.args.length, 1);
  assert.equal(m.args[0], 'canvas-fills-window: canvas 800x600 != 1600x1200');
});

test('a false return is a failure with a generic reason', () => {
  const { posts, fakeWindow } = loadRunner();
  fakeWindow.usernode.invariants.register('bool-check', () => false);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].level, 'error');
  assert.match(posts[0].args[0], /^bool-check: /);
});

test('a throwing invariant is reported, not propagated', () => {
  const { posts, fakeWindow } = loadRunner();
  assert.doesNotThrow(() => {
    fakeWindow.usernode.invariants.register('boom', () => { throw new Error('kaboom'); });
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].level, 'error');
  assert.match(posts[0].args[0], /boom: .*kaboom/);
});

test('an identical persistent failure is debounced (one report, not per tick)', () => {
  const { posts, listeners, fakeWindow } = loadRunner();
  fakeWindow.usernode.invariants.register('still-broken', () => false);
  assert.equal(posts.length, 1);
  fireResize(listeners); // re-evaluate: still failing
  fireResize(listeners);
  assert.equal(posts.length, 1, 'no new report while the state is unchanged');
});

test('recovery reports once, at info level (no red badge)', () => {
  const { posts, listeners, fakeWindow } = loadRunner();
  let broken = true;
  fakeWindow.usernode.invariants.register('flapping', () => (broken ? 'down' : true));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].level, 'error');
  broken = false;
  fireResize(listeners); // transition back to passing
  assert.equal(posts.length, 2);
  assert.equal(posts[1].level, 'info');
  assert.match(posts[1].args[0], /flapping: recovered/);
  fireResize(listeners); // still passing → no further report
  assert.equal(posts.length, 2);
});

test('register rejects a non-function check', () => {
  const { fakeWindow } = loadRunner();
  assert.throws(() => fakeWindow.usernode.invariants.register('bad', 'not-a-fn'), /must be a function/);
});

// ── Source-level guarantees (mirrors usernode-bridge.test.js style) ───

test('bridge exposes the invariants API and rides the existing sentinel', () => {
  const src = bridgeSource();
  assert.match(src, /window\.usernode\.invariants/);
  assert.match(src, /register: function register\(name, fn\)/);
  assert.match(src, /__usernodeDevConsole/);
  assert.match(src, /kind: "invariant"/);
  // It listens for geometry changes — the "canvas fills window" trigger.
  assert.match(src, /addEventListener\("resize"/);
  assert.match(src, /addEventListener\("orientationchange"/);
});
