// Tests for the TEMPORARY staging-only on-screen debug overlay.
//
// The contract that MUST hold so this never leaks into production:
//   - In production (env !== 'staging') StagingDebug.active stays false and
//     log()/snapshot() are inert no-ops that never touch the DOM.
//   - The instrumentation call sites use optional chaining (window.StagingDebug?.)
//     so they can't throw even if the script failed to load.
//   - /api/version exposes `env` so the shell can arm the overlay on staging.
//
// Run with: node --test tests/staging-debug.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEBUG_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'staging-debug.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function load(versionEnv) {
  let appended = false;
  const sandbox = {
    fetch: async () => ({ json: async () => ({ env: versionEnv }) }),
    document: {
      _appended: () => appended,
      createElement: () => ({ style: {}, appendChild() {}, querySelector: () => null, remove() {}, onclick: null, textContent: '' }),
      body: { appendChild() { appended = true; } },
      addEventListener() {},
    },
    getComputedStyle: () => ({}),
    navigator: { clipboard: { writeText() {} } },
    setTimeout, clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Strip the trailing auto-init so the test controls when init() runs.
  const src = DEBUG_SRC.replace(/StagingDebug\.init\(\);\s*$/, '');
  vm.runInContext(src + '\n;globalThis.__SD = StagingDebug;', sandbox);
  return { SD: sandbox.__SD, appended: () => appended };
}

test('production: stays inert — log/snapshot never touch the DOM', async () => {
  const { SD, appended } = load('production');
  await SD.init();
  assert.equal(SD.active, false, 'not armed in production');
  SD.log('hello');
  SD.snapshot({ classList: { contains: () => false } }, 'x');
  assert.equal(appended(), false, 'no overlay element created in production');
  assert.equal(SD._lines.length, 0, 'nothing buffered in production');
});

test('staging: arms and buffers lines + builds the overlay on first log', async () => {
  const { SD, appended } = load('staging');
  await SD.init();
  assert.equal(SD.active, true, 'armed on staging');
  assert.ok(SD._lines.length >= 1, 'init logs the armed line');
  assert.equal(appended(), true, 'overlay element created on staging');
  SD.log('step one');
  assert.ok(SD._lines.some((l) => l.includes('step one')), 'log buffered');
});

test('snapshot reports the reveal-relevant fields', async () => {
  const { SD } = load('staging');
  await SD.init();
  SD._lines.length = 0;
  const el = { classList: { contains: (c) => c === 'hidden' } };
  SD.snapshot(el, 'after reveal');
  const line = SD._lines.join('\n');
  for (const field of ['hidden=true', 'display=', 'visibility=', 'opacity=', 'rect=']) {
    assert.ok(line.includes(field), `snapshot includes ${field}`);
  }
});

test('init failure leaves it inert (fetch throws)', async () => {
  const sandbox = { fetch: async () => { throw new Error('offline'); }, console, setTimeout, clearTimeout,
    document: { createElement: () => ({ style: {}, appendChild() {} }), body: { appendChild() {} }, addEventListener() {} } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DEBUG_SRC.replace(/StagingDebug\.init\(\);\s*$/, '') + '\n;globalThis.__SD = StagingDebug;', sandbox);
  await sandbox.__SD.init();
  assert.equal(sandbox.__SD.active, false, 'inert when /api/version is unreachable');
});

test('call sites use optional chaining so they never throw when unloaded', () => {
  // A bare `StagingDebug.log(` (no `?.` and not `window.StagingDebug`) would
  // throw a ReferenceError in prod if the script were ever dropped.
  for (const [name, src] of [['app.js', APP_SRC], ['app-view.js', VIEW_SRC]]) {
    const bad = src.match(/(?<!window\.)(?<!\?\.)\bStagingDebug\.(log|snapshot)\(/g) || [];
    assert.equal(bad.length, 0, `${name} guards every StagingDebug call (found ${bad.length} unguarded)`);
  }
});

test('/api/version exposes the platform env for gating', () => {
  assert.match(SERVER_SRC, /env:\s*process\.env\.USERNODE_ENV/, '/api/version returns env');
});
