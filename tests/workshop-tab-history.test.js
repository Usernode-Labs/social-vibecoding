'use strict';

// A project's tabs are places, so Back steps through them (issue #3620).
//
// These are the history helpers the Workshop page uses: a tab press and a
// door push a record at the SAME address naming the tab, arriving somewhere
// tags the entry with the tab it shows, and a traversal reads that tag back.
// Run with: node --test tests/workshop-tab-history.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const {
  WORKSHOP_TAB_STATE_KEY,
  isTabKey,
  readTabEntry,
  pushTabEntry,
  tagTabEntry,
  isProjectPageUrl,
  projectPageSlug,
  tabWindow,
} = loadTsx('frontend/src/features/dev-board/workshop/tab-history.ts');

/**
 * A window whose history records what was asked of it. `pushState` and
 * `replaceState` move `history.state` exactly as a browser does, so a record
 * this module writes can be read back the way a traversal reads it.
 */
function fixture(options = {}) {
  const href = options.href || '/app/garden/workshop';
  const calls = [];
  const win = {
    history: {
      state: options.state ?? null,
      pushState(state, title, url) {
        calls.push({ kind: 'push', state, title, url });
        this.state = state;
      },
      replaceState(state, title, url) {
        calls.push({ kind: 'replace', state, title, url });
        this.state = state;
      },
    },
    location: {
      href,
      pathname: options.pathname ?? href.split('#')[0].split('?')[0],
      hash: options.hash ?? (href.includes('#') ? `#${href.split('#')[1]}` : ''),
    },
  };
  return { win, calls };
}

test('the tab key is the one the page knows, and nothing else', () => {
  for (const key of ['status', 'discussion', 'needs', 'workshop', 'all']) {
    assert.equal(isTabKey(key), true, key);
  }
  for (const bad of [null, undefined, '', 'home', 0, {}, []]) {
    assert.equal(isTabKey(bad), false, String(bad));
  }
});

test('an entry names its tab, and only a real one is read', () => {
  const plain = fixture();
  assert.equal(readTabEntry(plain.win), null, 'a screen navigation names no tab');
  plain.win.history.state = 'not an object';
  assert.equal(readTabEntry(plain.win), null);
  plain.win.history.state = { [WORKSHOP_TAB_STATE_KEY]: 'made-up' };
  assert.equal(readTabEntry(plain.win), null, 'an unknown tab is ignored, not restored');

  const tagged = fixture({ state: { [WORKSHOP_TAB_STATE_KEY]: 'needs', other: 1 } });
  assert.equal(readTabEntry(tagged.win), 'needs');
  // No window at all (a test, a server render) is not an error.
  assert.equal(readTabEntry(null), null);
});

test('a tab press pushes at the current address and keeps the state that was there', () => {
  const { win, calls } = fixture({ state: { __unDismissDepth: 2, __unDismissId: 'abc' } });
  pushTabEntry(win, 'workshop');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'push');
  assert.equal(calls[0].url, '/app/garden/workshop', 'the address does not change');
  assert.deepEqual(calls[0].state, {
    __unDismissDepth: 2,
    __unDismissId: 'abc',
    [WORKSHOP_TAB_STATE_KEY]: 'workshop',
  }, 'a dialog record underneath keeps its markers');
  assert.equal(readTabEntry(win), 'workshop', 'and the page stands on the new record');
});

test('an unknown tab, or no window, pushes nothing', () => {
  const { win, calls } = fixture();
  pushTabEntry(win, 'nope');
  pushTabEntry(null, 'workshop');
  assert.deepEqual(calls, []);
});

test('arriving somewhere names the tab on the entry it arrived on, adding no step', () => {
  const { win, calls } = fixture({ state: { __unDismissId: 'kept' } });
  tagTabEntry(win, 'all');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'replace', 'replace, never push');
  assert.equal(calls[0].url, '/app/garden/workshop');
  assert.deepEqual(calls[0].state, { __unDismissId: 'kept', [WORKSHOP_TAB_STATE_KEY]: 'all' });
  tagTabEntry(win, 'bogus');
  assert.equal(calls.length, 1, 'a bogus tag writes nothing');
});

test('the address says which project\'s page it is, and which ones are not the page', () => {
  const at = (pathname, hash = '') => ({ location: { href: `${pathname}${hash}`, pathname, hash } });

  assert.equal(projectPageSlug(at('/app/garden/workshop')), 'garden', 'the arriving project');
  assert.equal(projectPageSlug(at('/app/garden%204f/board')), 'garden 4f', 'the board alias, decoded');
  assert.equal(projectPageSlug(at('/', '#app/garden/workshop')), 'garden', 'and the legacy hash spelling');
  assert.equal(projectPageSlug(at('/app/garden/dev/chat')), null, 'a card or topic is not the page');
  assert.equal(projectPageSlug(at('/#communities', '#communities')), null);
  assert.equal(projectPageSlug(null), null, 'no window');

  assert.equal(isProjectPageUrl(at('/app/garden/workshop'), 'garden'), true);
  assert.equal(isProjectPageUrl(at('/app/garden/board'), 'garden'), true, 'the board alias is the same page');
  assert.equal(isProjectPageUrl(at('/app/garden/workshop/'), 'garden'), true);
  assert.equal(isProjectPageUrl(at('/app/garden%204f/workshop'), 'garden 4f'), true,
    'the slug is compared decoded');
  // The legacy hash spelling, before restoreFromHash has canonicalised it.
  assert.equal(isProjectPageUrl(at('/', '#app/garden/workshop'), 'garden'), true);
  assert.equal(isProjectPageUrl(at('/app/x/app', '#app/garden/workshop'), 'garden'), true,
    'a hash route outranks the pathname, as it does in the router');

  assert.equal(isProjectPageUrl(at('/app/other/workshop'), 'garden'), false, 'another project');
  assert.equal(isProjectPageUrl(at('/app/garden'), 'garden'), false, 'the running app is not the page');
  assert.equal(isProjectPageUrl(at('/app/garden/dev/chat'), 'garden'), false, 'nor a card or topic');
  assert.equal(isProjectPageUrl(at('/app/garden/workshop'), null), false, 'no project, no page');
  assert.equal(isProjectPageUrl(at('/#communities', '#communities'), 'garden'), false);
  assert.equal(isProjectPageUrl(null, 'garden'), false, 'no window');
});

test('a history that refuses a write is not an error', () => {
  const win = {
    history: {
      state: null,
      pushState() { throw new Error('sandbox'); },
      replaceState() { throw new Error('sandbox'); },
    },
    location: { href: '/app/garden/workshop', pathname: '/app/garden/workshop', hash: '' },
  };
  assert.doesNotThrow(() => pushTabEntry(win, 'needs'));
  assert.doesNotThrow(() => tagTabEntry(win, 'needs'));
  assert.equal(readTabEntry(win), null);
});

test('tabWindow is the global window where there is one, and null where there is not', () => {
  assert.equal(tabWindow(), null, 'the Node test has no window');
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  globalThis.window = { marker: true };
  try {
    assert.equal(tabWindow(), globalThis.window);
  } finally {
    if (had) globalThis.window = was;
    else delete globalThis.window;
  }
});
