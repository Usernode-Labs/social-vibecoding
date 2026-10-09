'use strict';

// #4087 part 4: the shots browsers open every page with the mobile install
// strip already dismissed, so phone-size before/after shots show the screen
// rather than the banner over its top, unless the page was opened with the
// shots install-strip flag. Declared checks and real visitors are
// untouched: only the shots MCP browsers load the init script.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const INIT = 'worker/shots-page-init.js';
const IMAGE_PATH = '/usr/local/share/usernode/shots-page-init.js';

test('the init script records the exact dismissal the banner reads', () => {
  const banner = read('frontend/src/features/mobile-install/install-banner.tsx');
  const key = banner.match(/const DISMISS_KEY = '([^']+)';/)[1];
  const store = new Map();
  const sessionStorage = { setItem: (k, v) => store.set(k, String(v)) };
  const window = {}; window.top = window;
  vm.runInNewContext(read(INIT), { sessionStorage, window });
  assert.equal(store.get(key), '1', 'banner reads sessionStorage[DISMISS_KEY] === "1"');
});

test('a framed page (a hosted app inside the shell) is left alone', () => {
  const store = new Map();
  const sessionStorage = { setItem: (k, v) => store.set(k, String(v)) };
  vm.runInNewContext(read(INIT), { sessionStorage, window: { top: {} } });
  assert.equal(store.size, 0);
});

// A change to the strip itself (4420, 4321) opens its start path with the
// flag the brief names: that page has the dismissal taken away instead.
test('a page opened with the shots install-strip flag shows the strip; any other page dismisses it', () => {
  const banner = read('frontend/src/features/mobile-install/install-banner.tsx');
  const key = banner.match(/const DISMISS_KEY = '([^']+)';/)[1];
  const { INSTALL_STRIP } = require('../src/services/shots-orchestrator');
  const run = (search, { framed = false, before = null } = {}) => {
    const store = new Map(before == null ? [] : [[key, before]]);
    const sessionStorage = {
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    const window = { location: { search } };
    window.top = framed ? {} : window;
    vm.runInNewContext(read(INIT), { sessionStorage, window });
    return store.has(key) ? store.get(key) : null;
  };
  // The flag the brief tells the agent to add is the one the script reads.
  assert.equal(INSTALL_STRIP.param, 'shots-install-strip=show');
  for (const search of [`?${INSTALL_STRIP.param}`, `?un-now=2026-10-08T18:00:00.000Z&${INSTALL_STRIP.param}`,
    `?${INSTALL_STRIP.param}&demo=1`]) {
    assert.equal(run(search, { before: '1' }), null, `${search} takes the dismissal away`);
    assert.equal(run(search), null, search);
  }
  // Without the flag, exactly as before: every page dismisses it.
  for (const search of ['', '?demo=1', '?shots-install-strip=hide', '?xshots-install-strip=show',
    '?shots-install-strip=shown']) {
    assert.equal(run(search), '1', JSON.stringify(search));
  }
  // A framed page (a hosted app) is left alone either way.
  assert.equal(run(`?${INSTALL_STRIP.param}`, { framed: true, before: '1' }), '1');
  assert.equal(run('', { framed: true }), null);
});

test('a page with no storage does not throw', () => {
  const sessionStorage = { setItem() { throw new Error('SecurityError'); } };
  const window = {}; window.top = window;
  assert.doesNotThrow(() => vm.runInNewContext(read(INIT), { sessionStorage, window }));
});

test('every shots browser loads it, and the image puts it where they look', () => {
  const config = read('worker/write-shots-mcp-config.js');
  assert.ok(config.includes(`'--init-script', '${IMAGE_PATH}'`),
    'browserArgs passes the init script to Playwright MCP');
  const dockerfile = read('worker/Dockerfile');
  assert.ok(dockerfile.includes(`COPY shots-page-init.js ${IMAGE_PATH}`),
    'the worker image copies the script to the path the config names');
});
