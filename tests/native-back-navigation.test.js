const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { nativeBackEnabled, createBackNavigationPublisher } = loadTsx(
  'frontend/src/features/header/native-back-navigation.ts'
);

const arrow = { visible: true, mode: 'arrow', href: '#settings', inApp: false };
test('only a visible Back destination outside embedded app content enables swiping', () => {
  assert.equal(nativeBackEnabled(arrow), true);
  // The route's screen decides, not the Improve target: a platform screen
  // showing a stale slug/tab pair from an app just left is still eligible.
  assert.equal(nativeBackEnabled({ ...arrow, slug: 'example', tab: 'dev' }), true);
  for (const override of [
    { visible: false }, { mode: 'home' }, { mode: 'none' }, { href: null },
    { inApp: true },
  ]) assert.equal(nativeBackEnabled({ ...arrow, ...override }), false);
});

// #3623: improveStore.tab stays 'app' once a platform screen has replaced
// the running app — App.setTarget(null) WRITES that value, and the initial
// one agrees with it — so the gesture read as "inside a running app" on
// every screen the app had been left for. The header now answers from
// navStore's screen instead; the stale slug/tab pair must never matter.
test('a stale Improve tab cannot hold the gesture down on a platform screen', () => {
  // The pair the store really holds after an app is left: the platform
  // target's own slug (published by Home.publishImproveTarget) with the tab
  // App.setTarget(null) or the initial value leaves behind. This is the one
  // that fails under the old derivation.
  assert.equal(nativeBackEnabled({ ...arrow, slug: 'example', tab: 'app' }), true,
    'the screen decides; the Improve target never does');
  // …and even the impossible pair must not matter either way.
  assert.equal(nativeBackEnabled({ ...arrow, slug: null, tab: 'app' }), true,
    'slug null with tab app is exactly the stale pair the store holds; the screen decides');
});

// #2916: a Workshop topic's back is the "‹ Workshop" chip inside the pane, and
// the header draws no arrow there. The swipe must stay on for those pages: it
// follows the page's back control, whichever bar or pane draws it.
const topic = {
  visible: true, mode: 'none', href: '/', slug: 'example', tab: 'dev',
  paneHref: '#app/example/workshop',
};
test('a Workshop topic keeps swiping through its in-pane back chip', () => {
  assert.equal(nativeBackEnabled(topic), true);
  assert.equal(nativeBackEnabled({ ...topic, paneHref: null }), false,
    'without the chip and without an arrow there is no back to swipe to');
  assert.equal(nativeBackEnabled({ ...topic, visible: false }), false,
    'a hidden header (chromeless) still publishes false');
  assert.equal(nativeBackEnabled({ ...topic, inApp: true }), false,
    'and embedded App-tab content never gets the gesture');
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture({ info, write, native = true } = {}) {
  const calls = [];
  const host = {
    usernode: { isNative: native, async setBackNavigationEnabled({ enabled }) {
      calls.push(enabled);
      if (write) await write(enabled);
    } },
    NativeChrome: { getInfo: info || (async () => ({ capabilities: ['setBackNavigationEnabled'] })) },
  };
  return { calls, publisher: createBackNavigationPublisher(host) };
}

test('leaving during capability detection never sends a stale enable', async () => {
  const probe = deferred();
  const { calls, publisher } = fixture({ info: () => probe.promise });
  const pending = publisher.setEnabled(true);
  publisher.setEnabled(false);
  probe.resolve({ capabilities: ['setBackNavigationEnabled'] });
  await pending;
  assert.ok(calls.length > 0);
  assert.ok(calls.every(enabled => enabled === false));
});

test('an in-flight enable finishes before the subsequent disable', async () => {
  const gate = deferred();
  const started = deferred();
  const { calls, publisher } = fixture({ write: async enabled => {
    if (enabled) { started.resolve(); await gate.promise; }
  } });
  const pending = publisher.setEnabled(true);
  await started.promise;
  publisher.setEnabled(false);
  assert.deepEqual(calls, [true]);
  gate.resolve();
  await pending;
  assert.deepEqual(calls, [true, false]);
});

test('browsers, old clients and degraded probes do not call unsupported methods', async () => {
  for (const options of [
    { native: false }, { info: async () => ({ capabilities: [] }) },
    { info: async () => ({ degraded: true, capabilities: ['setBackNavigationEnabled'] }) },
  ]) {
    const { publisher, calls } = fixture(options);
    await publisher.setEnabled(true);
    assert.deepEqual(calls, []);
  }
});

test('failed publications can retry and pageshow can republish unchanged state', async () => {
  let fail = true;
  const { publisher, calls } = fixture({ write: async () => {
    if (fail) throw new Error('retired document');
  } });
  await publisher.setEnabled(true);
  fail = false;
  await publisher.setEnabled(true);
  await publisher.setEnabled(true);
  assert.deepEqual(calls, [true, true, true]);
});
