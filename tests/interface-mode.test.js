const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { readInterfaceMode, saveInterfaceMode, INTERFACE_MODE_KEY } = loadTsx('frontend/src/features/settings/interface-mode.ts');

test('mode defaults safely, persists both choices, and rejects unavailable storage', () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  assert.equal(readInterfaceMode(storage), 'advanced');
  values.set(INTERFACE_MODE_KEY, 'unknown');
  assert.equal(readInterfaceMode(storage), 'advanced');
  for (const mode of ['basic', 'advanced']) {
    assert.equal(saveInterfaceMode(mode, storage), true);
    assert.equal(readInterfaceMode(storage), mode);
  }
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.equal(readInterfaceMode(denied), 'advanced');
  assert.equal(saveInterfaceMode('basic', denied), false);
  assert.equal(saveInterfaceMode('basic', null), false);
});

test('Experimental prerenders the labelled Advanced toggle and its device scope', () => {
  const html = renderComponent('frontend/src/features/settings/sections/experimental.tsx', 'ExperimentalSection');
  assert.match(html, /data-interface-mode="advanced"/);
  assert.match(html, /Advanced mode/);
  assert.match(html, /Your choice is saved on this device/);
});
