// The focused topic head is repainted from a model, and its vote roster is
// filled by a loader the RENDERER calls on every paint (`_loadVoteRoster`,
// from `_voteRosterView`'s miss).
//
// Before the React conversion the loader wrote into the DOM in place, so
// re-entering the renderer was never on the table. Painting from a model
// puts it on the table: a loader that repaints unconditionally closes a
// cycle with the renderer that called it.
//
//   render → load → (cached) paint → render → load → …
//
// The first pass through survives because it awaits its fetch, which
// unwinds the stack. The pass AFTER it finds the cache, stays synchronous,
// and blows the stack.
//
// The rule the loader follows: a loader a renderer calls per paint must not
// unconditionally re-enter that renderer. The roster guards with an
// in-flight set plus its cache.
//
// Run with: node --test tests/topic-head-loader-reentry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const APP_VIEW_SRC = read('app-view.js');

function makeAppView(opts = {}) {
  const slot = { innerHTML: '' };
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null,
      querySelector: () => slot,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => (opts.fetchData || {}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(
    `${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`,
    sandbox
  );
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  return { AppView, slot };
}

// Stand in for the real `_renderTopicHead`, which rebuilds the model and, on
// a proposal being voted on, ends with `_loadVoteRoster(id)`. Counting its
// calls is how a cycle shows up as a number rather than as a crash.
function renderingSpy(AppView, load) {
  const calls = { n: 0 };
  AppView._renderTopicHead = () => {
    calls.n += 1;
    // A runaway cycle would recurse here forever; stop counting well before
    // the stack does, so a regression reports a count instead of a
    // RangeError from inside the test harness.
    if (calls.n > 50) return;
    load();
  };
  return calls;
}

test('the vote roster loader is guarded against the same cycle', async () => {
  const { AppView } = makeAppView({
    fetchData: { yes: [], no: [], policy: 'anyone' },
  });

  const calls = renderingSpy(AppView, () => AppView._loadVoteRoster(7));
  await AppView._loadVoteRoster(7);
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(calls.n <= 2, `roster repaints settle (saw ${calls.n})`);
  assert.ok(AppView._voteRoster[7], 'and the roster is cached for the next paint');
  assert.equal(AppView._voteRosterInFlight.has(7), false, 'with the in-flight mark cleared');
});
