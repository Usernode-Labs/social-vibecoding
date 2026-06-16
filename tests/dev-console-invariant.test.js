// Regression test for issue #360: the platform shell's developer-console
// receiver (public/js/dev-console.js) already keys only off the
// `__usernodeDevConsole` sentinel and stores any `kind`, so an
// invariant-failure message (kind:'invariant', level:'error') posted by
// the bridge surfaces and badges exactly like a console.error — with no
// receiver change. This pins that behaviour.
//
// dev-console.js is a browser script (no module.exports); we load it in
// a vm with a minimal stubbed DOM and exercise _onMessage directly.
//
// Run with: node --test tests/dev-console-invariant.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDevConsole() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'dev-console.js'), 'utf8'
  );
  const stubEl = { classList: { add() {}, remove() {}, toggle() {} }, textContent: '' };
  const sandbox = {
    window: { addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } },
    document: { getElementById: () => null, addEventListener() {}, createElement: () => stubEl },
    Map,
    String,
    Date,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.DevConsole;
}

test('an invariant-failure message is stored and bumps the error badge', () => {
  const DevConsole = loadDevConsole();
  DevConsole._onMessage({
    data: {
      sentinel: '__usernodeDevConsole',
      level: 'error',
      kind: 'invariant',
      args: ['canvas-fills-window: canvas 800x600 != 1600x1200'],
      ts: 1,
      url: 'http://app.example/',
    },
  });
  assert.equal(DevConsole.entries.length, 1);
  const entry = DevConsole.entries[0];
  assert.equal(entry.kind, 'invariant');
  assert.equal(entry.level, 'error');
  assert.equal(entry.args[0], 'canvas-fills-window: canvas 800x600 != 1600x1200');
  // level === 'error' while the panel is closed → counts toward the badge.
  assert.equal(DevConsole.unseenErrors, 1);
});

test('an invariant recovery (info level) is stored but does not badge', () => {
  const DevConsole = loadDevConsole();
  DevConsole._onMessage({
    data: {
      sentinel: '__usernodeDevConsole',
      level: 'info',
      kind: 'invariant',
      args: ['flapping: recovered'],
      ts: 2,
      url: 'http://app.example/',
    },
  });
  assert.equal(DevConsole.entries.length, 1);
  assert.equal(DevConsole.unseenErrors, 0);
});

test('messages without the sentinel are ignored', () => {
  const DevConsole = loadDevConsole();
  DevConsole._onMessage({ data: { level: 'error', kind: 'invariant', args: ['nope'] } });
  DevConsole._onMessage({ data: null });
  assert.equal(DevConsole.entries.length, 0);
  assert.equal(DevConsole.unseenErrors, 0);
});
