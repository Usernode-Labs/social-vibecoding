'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pairing = require('../worker/shots-appearance-pair');
const boundary = require('../worker/shots-boundary');
const { png } = require('./fixtures/shots');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-pair-'));
  const state = { preference: 'dark', storage: true, shell: true, shellMode: 'dark', osMode: 'light' };
  const calls = [];
  const page = { url: () => 'https://after.example/state',
    evaluate: async (fn, value) => {
      calls.push(['evaluate', value]);
      if (value === undefined) return { ...state };
      state.shellMode = typeof value === 'string' ? value : value.shellMode;
      state.preference = typeof value === 'string' ? value : value.preference;
    },
    emulateMedia: async (options) => calls.push(['media', options.colorScheme]),
  };
  const capture = async (name, dark) => {
    calls.push(['capture', name, dark, state.shellMode]);
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), png({ shade: dark ? 20 : 240 }));
  };
  return { directory, state, calls, page, capture, origins: ['https://after.example'] };
}

test('final shot captures both appearances in the same page, restores preference and stamps both bytes', async () => {
  const f = fixture();
  try {
    await pairing.photoPair({ ...f, filename: 'pair-state-after.png' });
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'capture').map((c) => c.slice(1)), [
      ['pair-state-after.png', false, 'light'], ['dark/pair-state-after.png', true, 'dark'],
    ]);
    assert.equal(f.state.preference, 'dark');
    assert.equal(f.state.shellMode, 'dark');
    assert.equal(f.calls.filter(([kind]) => kind === 'media').at(-1)[1], 'light');
    assert.equal(pairing.readPair(f.directory, 'pair-state-after.png').origin, 'https://after.example');
    for (const dir of [f.directory, path.join(f.directory, 'dark')]) {
      const data = fs.readFileSync(path.join(dir, 'pair-state-after.png'));
      assert.equal(boundary.screenshotOrigin(dir, 'pair-state-after.png', data), 'https://after.example');
    }
    fs.writeFileSync(path.join(f.directory, 'dark', 'pair-state-after.png'), 'changed');
    assert.equal(pairing.readPair(f.directory, 'pair-state-after.png'), null, 'changed bytes cannot claim an automatic pair');
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a failed second capture restores original preference and never publishes an incomplete pair', async () => {
  const f = fixture();
  try {
    await assert.rejects(pairing.photoPair({ ...f, filename: 'pair-state-after.png',
      capture: async (name, dark) => { if (dark) throw new Error('capture failed'); return f.capture(name, dark); },
    }), /capture failed/);
    assert.equal(f.state.preference, 'dark');
    assert.equal(f.state.shellMode, 'dark');
    assert.equal(pairing.readPair(f.directory, 'pair-state-after.png'), null);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('inspection screenshots stay single-mode and foreign origins cannot opt into final pairing', async () => {
  const f = fixture();
  try {
    await pairing.photoPair({ ...f, filename: 'inspection.png' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], 'capture');
    await assert.rejects(pairing.photoPair({ ...f, filename: 'pair-state-after.png', origins: ['https://before.example'] }), /supplied before\/after/);
    assert.equal(f.calls.length, 1, 'origin refusal happens before any theme or screenshot call');
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

// Execute the real shell Theme and hook callbacks, rather than stubbing out
// evaluate: this pins deep-link overrides, reader identity and OS restoration.
test('the historical pinned shell captures real appearances and restores its exact reader and preference after failure', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/head.html'), 'utf8')
    .match(/window\.Theme = \(function \(\) \{[\s\S]*?\}\(\)\);/)[0];
  for (const fail of [false, true]) {
    const classes = new Set(); const attributes = new Map(); const stored = new Map([['theme', 'dark']]);
    let osDark = false;
    const context = vm.createContext({ URLSearchParams, Symbol, Promise,
      location: { search: '?shot=light' },
      localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
      document: { documentElement: { classList: {
        contains: (key) => classes.has(key), add: (key) => classes.add(key), remove: (key) => classes.delete(key),
        toggle: (key, force) => force ? classes.add(key) : classes.delete(key),
      } }, querySelector: () => ({ getAttribute: (key) => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key) }) },
      matchMedia: () => ({ matches: osDark, addEventListener() {} }),
      addEventListener() {}, requestAnimationFrame: (fn) => fn(),
    });
    context.window = context; vm.runInContext(source, context);
    const originalGet = context.Theme.get; const originalColor = attributes.get('content'); const notices = [];
    context.Theme.onChange((mode) => notices.push([mode, context.Theme.get()]));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-shell-pair-'));
    const page = { url: () => 'https://after.example/state?shot=light',
      evaluate: (fn, value) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(value)})`, context),
      emulateMedia: async ({ colorScheme }) => { osDark = colorScheme === 'dark'; },
    };
    const capture = async (name, dark) => {
      assert.equal(context.Theme.get(), dark ? 'dark' : 'light');
      assert.equal(classes.has('dark'), dark); assert.equal(osDark, dark);
      if (fail && dark) throw new Error('second photo failed');
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.writeFileSync(path.join(directory, name), png({ shade: dark ? 20 : 240 }));
    };
    try {
      const operation = pairing.photoPair({ page, directory, filename: 'pair-pinned.png', capture, origins: ['https://after.example'] });
      if (fail) await assert.rejects(operation, /second photo failed/); else await operation;
      assert.equal(context.Theme.get, originalGet); assert.equal(context.Theme.get(), 'light');
      assert.equal(Object.getOwnPropertySymbols(context.Theme).length, 0);
      assert.equal(stored.get('theme'), 'dark'); assert.equal(osDark, false); assert.equal(classes.has('dark'), false);
      assert.equal(attributes.get('content'), originalColor);
      assert.deepEqual(notices, [['dark', 'dark'], ['light', 'light']]);
      assert.equal(!!pairing.readPair(directory, 'pair-pinned.png'), !fail);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});
