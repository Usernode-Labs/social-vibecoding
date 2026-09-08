'use strict';

// #1522: render the actual lock treatment, and execute the actual viewer
// callback to prove account-required apps never reach iframe/history writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const { LandingTile } = loadTsx('frontend/src/features/auth/landing.tsx');
const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '../frontend')] }));
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/features/auth/landing.tsx'), 'utf8');
const opener = source.match(/const openLandingApp = useCallback\(\s*(\(app: PublicApp\) => \{[\s\S]*?\n    \}),\s*\[clearViewerCover, refreshHeader, st\],\s*\);/);
assert.ok(opener, 'extract the real viewer callback, not a copy of its gate');
const compiled = esbuild.transformSync(`globalThis.openApp = ${opener[1]};`, { loader: 'ts' }).code;

function harness() {
  const remembered = [];
  const domReads = [];
  const historyEntries = [];
  const frame = { src: 'about:blank' };
  const region = { classList: { add() {}, remove() {} } };
  const location = { href: 'https://platform.example/#landing', hash: '#landing' };
  const sandbox = {
    location,
    legacy: () => ({ AuthScreens: { rememberDeepLink: (link) => remembered.push(link) } }),
    byId: (id) => { domReads.push(id); return id === 'app-viewer-frame' ? frame : region; },
    st: { timers: [], launchId: 0 },
    setOpenApp() {},
    clearViewerCover() {},
    landingTileFor: () => null,
    zoomFx: (fn, opts) => { fn(); opts.after?.(); },
    refreshHeader() {},
    history: { pushState: (state) => historyEntries.push(state) },
  };
  vm.runInNewContext(compiled, sandbox);
  return { open: sandbox.openApp, remembered, domReads, historyEntries, frame, location };
}

for (const [label, value] of [
  ['required', true],
  ['missing', undefined],
  ['unknown', null],
  ['malformed string', 'false'],
  ['malformed number', 0],
]) {
  test(`a ${label} login flag shows the lock and routes to signup without loading an app`, () => {
    const app = { slug: 'needs/account', name: 'Account app', url: 'https://app.example/', requires_login: value };
    const html = renderToHtml(createElement(LandingTile, { app, onOpen() {} }));
    assert.match(html, /data-gated="true"/);
    assert.match(html, /title="Account required"/);
    assert.match(html, /grayscale-\[0\.75\]/);

    const h = harness();
    h.open(app);
    assert.deepEqual(h.remembered, ['/app/needs%2Faccount']);
    assert.equal(h.location.hash, '#signup');
    assert.deepEqual(h.domReads, [], 'the gate runs before touching viewer DOM');
    assert.equal(h.frame.src, 'about:blank');
    assert.equal(h.historyEntries.length, 0, 'no anonymous-viewer history entry is created');
  });
}

test('an explicitly public app still opens normally, without a lock or signup redirect', () => {
  const app = { slug: 'public-app', name: 'Public app', url: 'https://app.example/', requires_login: false };
  const html = renderToHtml(createElement(LandingTile, { app, onOpen() {} }));
  assert.match(html, /data-gated="false"/);
  assert.doesNotMatch(html, /Account required/);
  const h = harness();
  h.open(app);
  assert.equal(h.frame.src, app.url);
  assert.equal(h.location.hash, '#landing');
  assert.equal(h.historyEntries.length, 1);
  assert.equal(h.historyEntries[0].svAnonAppViewer, true);
  assert.deepEqual(h.remembered, []);
});

test('a public app without a launch URL does not open an empty viewer', () => {
  const h = harness();
  h.open({ slug: 'no-url', requires_login: false });
  assert.deepEqual(h.domReads, []);
  assert.equal(h.historyEntries.length, 0);
});
