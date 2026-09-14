const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'public/usernode-bridge/v1/bridge.js'), 'utf8');
const sender = bridge.split('/* __USERNODE_BACKGROUND_BEGIN__ */')[1]
  .split('/* __USERNODE_BACKGROUND_END__ */')[0];
const appView = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');

function senderHarness({ loading = false, standalone = false } = {}) {
  const reports = [], timers = [], observers = [], events = {};
  const html = { backgroundColor: 'rgba(0, 0, 0, 0)' };
  const body = { backgroundColor: 'rgb(250, 246, 238)' };
  let reads = 0;
  const document = {
    documentElement: html, body: loading ? null : body,
    readyState: loading ? 'loading' : 'complete',
    addEventListener(name, fn) { events['doc:' + name] = fn; },
  };
  const window = {
    parent: { postMessage(message) { reports.push(message); } },
    getComputedStyle(node) { reads++; return node; },
    addEventListener(name, fn) { events[name] = fn; },
    matchMedia() { return { addEventListener(name, fn) { events['media:' + name] = fn; } }; },
  };
  if (standalone) window.parent = window;
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target, options) { assert.ok(target); this.targets.push({ target, options }); }
  }
  vm.runInNewContext(sender, { window, document, MutationObserver, setTimeout(fn) { timers.push(fn); } });
  return { reports, timers, observers, events, html, body, document,
    reads: () => reads, flush() { while (timers.length) timers.shift()(); } };
}

test('bridge starts after body exists and uses body when the root is transparent', () => {
  const h = senderHarness({ loading: true });
  assert.equal(h.reports.length, 0);
  assert.equal(h.observers.length, 0);
  h.document.body = h.body;
  h.events['doc:DOMContentLoaded']();
  assert.equal(h.reports[0].color, '#faf6ee');
});

test('theme changes follow the root color, deduplicate, and clear a transparent document', () => {
  const h = senderHarness();
  h.html.backgroundColor = 'rgb(10, 13, 20)';
  h.observers[0].callback();
  h.observers[0].callback();
  assert.equal(h.timers.length, 1);
  h.flush();
  assert.equal(h.reports.at(-1).color, '#0a0d14');
  h.observers[0].callback(); h.flush();
  assert.equal(h.reports.length, 2, 'no repeated color messages');
  h.html.backgroundColor = h.body.backgroundColor = 'rgba(0, 0, 0, 0)';
  h.observers[0].callback(); h.flush();
  assert.equal(h.reports.at(-1).color, null);
});

test('late app styles and OS theme changes refresh the background', () => {
  const h = senderHarness();
  h.html.backgroundColor = 'rgb(10 13 20 / 1)';
  h.observers[1].callback([{ target: { nodeType: 1, tagName: 'DIV' },
    addedNodes: [{ nodeType: 1, tagName: 'STYLE' }] }]);
  h.flush();
  assert.equal(h.reports.at(-1).color, '#0a0d14');
  h.html.backgroundColor = 'rgb(250, 246, 238)';
  h.events['media:change'](); h.flush();
  assert.equal(h.reports.at(-1).color, '#faf6ee');
});

test('ordinary game DOM updates do not recompute styles or send messages', () => {
  const h = senderHarness();
  const reads = h.reads();
  h.observers[1].callback([{ target: { nodeType: 1, tagName: 'SPAN' },
    addedNodes: [{ nodeType: 3 }], removedNodes: [{ nodeType: 3 }] }]);
  h.flush();
  assert.equal(h.reads(), reads);
  assert.equal(h.reports.length, 1);
  assert.ok(h.observers[0].targets.every(({ options }) => !options.subtree));
});

test('standalone pages do not install background observers or report colors', () => {
  const h = senderHarness({ standalone: true });
  assert.equal(h.observers.length, 0);
  assert.equal(h.reads(), 0);
});

function hostHarness() {
  const frames = Object.fromEntries(['app-iframe', 'staging-iframe', 'app-viewer-frame']
    .map(id => [id, { contentWindow: {}, style: {} }]));
  const colors = {};
  const context = {
    window: { addEventListener() {}, UsernodeReact: {
      appFrame: { setBackground(color) { colors.app = color; } },
      staging: { setBackground(color) { colors.staging = color; } },
    } },
    document: { getElementById(id) { return frames[id] || null; } },
  };
  vm.runInNewContext(appView, context);
  return { frames, colors, host: context.window.AppView,
    send(id, color) { context.window.AppView.handleBackgroundBridgeMessage({
      source: frames[id]?.contentWindow || {}, data: { __usernode_background: 'changed', color },
    }); } };
}

test('the host paints only the source frame through its owner', () => {
  const h = hostHarness();
  h.send('app-iframe', '#FAF6EE');
  assert.deepEqual(h.colors, { app: '#faf6ee' });
  assert.deepEqual(h.frames['app-iframe'].style, {}, 'React owns the actual style');
  h.send('staging-iframe', '#0a0d14');
  assert.equal(h.colors.staging, '#0a0d14');
  h.send('app-viewer-frame', '#faf6ee');
  assert.equal(h.frames['app-viewer-frame'].style.backgroundColor, '#faf6ee');
  h.send('app-iframe', null);
  assert.equal(h.colors.app, '');
});

test('foreign sources and non-color values cannot change an iframe background', () => {
  const h = hostHarness();
  h.send('other-frame', '#123456');
  for (const value of [undefined, 123, {}, '#fff', 'red', 'url(https://example.com)', '#123456; opacity:0']) {
    h.send('app-iframe', value);
  }
  assert.deepEqual(h.colors, {});
});

test('legacy and versioned bridge endpoints carry the same background behavior', () => {
  assert.equal(fs.readFileSync(path.join(root, 'public/usernode-bridge.js'), 'utf8'), bridge);
});
