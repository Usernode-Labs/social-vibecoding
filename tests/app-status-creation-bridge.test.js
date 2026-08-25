// `App.handleAppStatusUpdate` must forward every app_status message to
// the create dialog's progress store.
//
// public/js/app.js is a classic script with no imports, so it reaches the
// React store through the window.UsernodeReact bridge — the same seam the
// chunk-H stores use. This is the one line that connects the server's
// phase broadcasts to the dialog, and nothing else asserts it: the store
// tests (tests/creation-progress-store.test.js) cover the receiving half,
// and the app-creator tests cover the sending half.
//
// app.js is evaluated in a vm with stubbed globals, the same harness
// shape as tests/app-status-placeholder.test.js uses for app-view.js.
//
// Run with: node --test tests/app-status-creation-bridge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8',
);

function makeApp({ bridge = true } = {}) {
  const published = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    relTime: () => 'just now',
    Home: { load: () => {} },
    AppView: { appData: null, renderAppTab: () => {}, refreshToken: async () => {} },
    ...(bridge ? {
      UsernodeReact: {
        appCreationProgress: { publish: (data) => published.push(data) },
      },
    } : {}),
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }),
      body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
      documentElement: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '', pathname: '/', href: 'http://localhost/' },
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { userAgent: 'node', serviceWorker: undefined },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    WebSocket: function WebSocketStub() {},
    URL, URLSearchParams, JSON, Date, Math, Promise, Object, Array, String, Number,
    Intl, Set, Map, RegExp, Error, TextEncoder, TextDecoder, btoa, atob,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__App = App;`, sandbox);
  return { App: sandbox.__App, published };
}

test('a creation-phase broadcast reaches the dialog store', () => {
  const { App, published } = makeApp();
  App.handleAppStatusUpdate({
    appId: 7, slug: 'fresh-app', status: 'creating', phase: 'build',
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].slug, 'fresh-app');
  assert.equal(published[0].phase, 'build', 'the phase is what the dialog is waiting for');
});

test('terminal broadcasts are forwarded too, with their outcome detail', () => {
  const { App, published } = makeApp();
  App.handleAppStatusUpdate({ slug: 'a', status: 'running', url: 'https://a.example.test' });
  App.handleAppStatusUpdate({ slug: 'b', status: 'error', errorReason: 'Build failed' });
  App.handleAppStatusUpdate({ slug: 'c', status: 'awaiting_secrets', missingSecrets: ['K'] });
  assert.deepEqual(published.map((p) => p.status),
    ['running', 'error', 'awaiting_secrets']);
  assert.equal(published[0].url, 'https://a.example.test');
  assert.equal(published[1].errorReason, 'Build failed');
  assert.deepEqual(published[2].missingSecrets, ['K']);
});

test('a missing bridge is survivable — app.js loads before the React bundle', () => {
  // The legacy scripts are classic <script> tags at the end of <body>;
  // the React entry is a deferred module and runs AFTER them. A status
  // message arriving in that window has no store to publish into, and
  // must not throw its way out of the socket handler.
  const { App } = makeApp({ bridge: false });
  assert.doesNotThrow(() => {
    App.handleAppStatusUpdate({ slug: 'x', status: 'running' });
  });
});
