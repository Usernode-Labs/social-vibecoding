'use strict';

// #4087 part 4: the shots browsers open every page with the mobile install
// strip already dismissed, so phone-size before/after shots show the screen
// rather than the banner over its top. Declared checks and real visitors are
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
  vm.runInNewContext(read(INIT), { sessionStorage });
  assert.equal(store.get(key), '1', 'banner reads sessionStorage[DISMISS_KEY] === "1"');
});

test('a page with no storage does not throw', () => {
  const sessionStorage = { setItem() { throw new Error('SecurityError'); } };
  assert.doesNotThrow(() => vm.runInNewContext(read(INIT), { sessionStorage }));
});

test('every shots browser loads it, and the image puts it where they look', () => {
  const config = read('worker/write-shots-mcp-config.js');
  assert.ok(config.includes(`'--init-script', '${IMAGE_PATH}'`),
    'browserArgs passes the init script to Playwright MCP');
  const dockerfile = read('worker/Dockerfile');
  assert.ok(dockerfile.includes(`COPY shots-page-init.js ${IMAGE_PATH}`),
    'the worker image copies the script to the path the config names');
});
