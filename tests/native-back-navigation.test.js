const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { nativeBackEnabled, createBackNavigationPublisher } = loadTsx(
  'frontend/src/features/header/native-back-navigation.ts'
);

const arrow = { visible: true, mode: 'arrow', href: '#settings', slug: null, tab: null };
test('only a visible Back destination outside embedded app content enables swiping', () => {
  assert.equal(nativeBackEnabled(arrow), true);
  assert.equal(nativeBackEnabled({ ...arrow, slug: 'example', tab: 'dev' }), true);
  for (const override of [
    { visible: false }, { mode: 'home' }, { mode: 'none' }, { href: null },
    { slug: 'example', tab: 'app' },
  ]) assert.equal(nativeBackEnabled({ ...arrow, ...override }), false);
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
  assert.equal(nativeBackEnabled({ ...topic, tab: 'app' }), false,
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
