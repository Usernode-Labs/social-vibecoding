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

// A storage stub with the slice of the Storage API the script uses.
function storage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

test('every page opens as a first visit to a project\'s Workshop, on both sides alike', () => {
  // "Since your last visit" counts from the stamp the previous load wrote
  // (AppView._workshopBaseline); the agent loads the two addresses a
  // different number of times, so the stamp is dropped before the page reads it.
  const appView = read('public/js/app-view.js');
  const prefix = appView.match(/WORKSHOP_SEEN_KEY: '([^']+)'/)[1];
  assert.match(appView, /localStorage\.getItem\(`\$\{AppView\.WORKSHOP_SEEN_KEY\}:\$\{slug\}`\)/,
    'the Workshop reads its baseline from `<WORKSHOP_SEEN_KEY>:<slug>`');
  const localStorage = storage({
    [`${prefix}:usernode-2d5619`]: '1760000000000',
    [`${prefix}:staging-demo-forkable`]: '1760000000001',
    // Everything else a page remembers on purpose stays: a tab chosen, a draft.
    'usernode:workshop-tab': 'workshop',
    'usernode:messages-draft:general': 'hello',
  });
  const window = {}; window.top = window;
  vm.runInNewContext(read(INIT), { sessionStorage: storage({}), localStorage, window });
  assert.deepEqual([...localStorage.map.keys()], ['usernode:workshop-tab', 'usernode:messages-draft:general']);
});

test('a framed page keeps its visit stamps, and a page with no local storage does not throw', () => {
  const localStorage = storage({ 'workshopSeen:usernode-2d5619': '1' });
  vm.runInNewContext(read(INIT), { sessionStorage: storage({}), localStorage, window: { top: {} } });
  assert.equal(localStorage.map.size, 1);
  const window = {}; window.top = window;
  const refusing = { get length() { throw new Error('SecurityError'); } };
  assert.doesNotThrow(() => vm.runInNewContext(read(INIT), { sessionStorage: storage({}), localStorage: refusing, window }));
});
