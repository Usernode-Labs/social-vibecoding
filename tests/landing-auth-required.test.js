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
const waitingSource = fs.readFileSync(path.join(__dirname, '../frontend/src/features/auth/waiting.tsx'), 'utf8');
const opener = source.match(/const openLandingApp = useCallback\(\s*(async \(app: PublicApp\) => \{[\s\S]*?\n    \}),\s*\[clearViewerCover, refreshHeader, st\],\s*\);/);
assert.ok(opener, 'extract the real viewer callback, not a copy of its gate');
const compiled = esbuild.transformSync(`globalThis.openApp = ${opener[1]};`, { loader: 'ts' }).code;

function harness({ signedIn = false, token = 'app-token', mint } = {}) {
  const remembered = [];
  const domReads = [];
  const historyEntries = [];
  const tokenMints = [];
  const toasts = [];
  const frame = { src: 'about:blank' };
  const region = { classList: { add() {}, remove() {} } };
  const location = { href: 'https://platform.example/#landing', hash: '#landing' };
  const st = { timers: [], launchId: 0 };
  const sandbox = {
    URL,
    location,
    hasSession: () => signedIn,
    legacy: () => ({
      App: { user: signedIn ? { hasPlatformAccess: false } : null },
      AuthScreens: { rememberDeepLink: (link) => remembered.push(link) },
      AppView: {
        _mintToken: async (slug) => {
          tokenMints.push(slug);
          return mint ? mint(slug) : token;
        },
      },
      PlatformUI: { toast: (message, opts) => toasts.push({ message, opts }) },
    }),
    byId: (id) => { domReads.push(id); return id === 'app-viewer-frame' ? frame : region; },
    st,
    setOpenApp() {},
    clearViewerCover() {},
    landingTileFor: () => null,
    zoomFx: (fn, opts) => { fn(); opts.after?.(); },
    refreshHeader() {},
    history: { pushState: (state) => historyEntries.push(state) },
  };
  vm.runInNewContext(compiled, sandbox);
  return {
    open: sandbox.openApp,
    remembered,
    domReads,
    historyEntries,
    tokenMints,
    toasts,
    frame,
    location,
    st,
  };
}

for (const [label, value] of [
  ['required', true],
  ['missing', undefined],
  ['unknown', null],
  ['malformed string', 'false'],
  ['malformed number', 0],
]) {
  test(`a ${label} login flag shows the lock and routes a signed-out visitor to signup`, async () => {
    const app = { slug: 'needs/account', name: 'Account app', url: 'https://app.example/', requires_login: value };
    const html = renderToHtml(createElement(LandingTile, { app, onOpen() {} }));
    assert.match(html, /data-gated="true"/);
    assert.match(html, /title="Account required"/);
    assert.match(html, /grayscale-\[0\.75\]/);

    const h = harness();
    await h.open(app);
    assert.deepEqual(h.remembered, ['/app/needs%2Faccount']);
    assert.equal(h.location.hash, '#signup');
    assert.deepEqual(h.domReads, [], 'the gate runs before touching viewer DOM');
    assert.equal(h.frame.src, 'about:blank');
    assert.deepEqual(h.tokenMints, [], 'signed-out visitors cannot mint app identity');
    assert.equal(h.historyEntries.length, 0, 'no anonymous-viewer history entry is created');
  });
}

test('a signed-in waitlist user sees an account-required app unlocked and opens it with identity', async () => {
  const app = {
    slug: 'account-app',
    name: 'Account app',
    url: 'https://app.example/?mode=compact#today',
    requires_login: true,
  };
  const html = renderToHtml(createElement(LandingTile, {
    app,
    onOpen() {},
    signedIn: true,
  }));
  assert.match(html, /data-gated="false"/);
  assert.doesNotMatch(html, /Account required/);

  const h = harness({ signedIn: true, token: 'a+b/c' });
  await h.open(app);
  assert.deepEqual(h.tokenMints, ['account-app']);
  assert.equal(h.frame.src, 'https://app.example/?mode=compact&token=a%2Bb%2Fc#today');
  assert.equal(h.historyEntries.length, 1);
  assert.deepEqual(h.remembered, []);
  assert.deepEqual(h.toasts, []);
});

test('a signed-in waitlist user never loads an account-required app when identity minting fails', async () => {
  const h = harness({ signedIn: true, token: null });
  await h.open({ slug: 'account-app', url: 'https://app.example/', requires_login: true });
  assert.deepEqual(h.tokenMints, ['account-app']);
  assert.equal(h.frame.src, 'about:blank');
  assert.deepEqual(h.domReads, [], 'the viewer stays untouched without a token');
  assert.equal(h.historyEntries.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /Could not sign in/);
  assert.equal(h.toasts[0].opts.error, true);
});

test('leaving the landing screen while a token mint is pending cancels the late launch', async () => {
  let settle;
  const h = harness({
    signedIn: true,
    mint: () => new Promise((resolve) => { settle = resolve; }),
  });
  const opening = h.open({ slug: 'slow-app', url: 'https://app.example/', requires_login: true });
  h.st.launchId += 1;
  settle('late-token');
  await opening;
  assert.equal(h.frame.src, 'about:blank');
  assert.deepEqual(h.domReads, []);
  assert.equal(h.historyEntries.length, 0);
});

test('an explicitly public app still opens normally, without a lock, signup, or token', async () => {
  const app = { slug: 'public-app', name: 'Public app', url: 'https://app.example/', requires_login: false };
  const html = renderToHtml(createElement(LandingTile, { app, onOpen() {} }));
  assert.match(html, /data-gated="false"/);
  assert.doesNotMatch(html, /Account required/);
  const h = harness();
  await h.open(app);
  assert.equal(h.frame.src, app.url);
  assert.equal(h.location.hash, '#landing');
  assert.equal(h.historyEntries.length, 1);
  assert.equal(h.historyEntries[0].svAnonAppViewer, true);
  assert.deepEqual(h.remembered, []);
  assert.deepEqual(h.tokenMints, []);
});

test('a public app without a launch URL does not open an empty viewer', async () => {
  const h = harness();
  await h.open({ slug: 'no-url', requires_login: false });
  assert.deepEqual(h.domReads, []);
  assert.equal(h.historyEntries.length, 0);
});

test('the waiting-room CTA describes the expanded app access', () => {
  assert.match(waitingSource, />\s*Use apps while you wait\s*</);
  assert.doesNotMatch(waitingSource, /Browse public apps while you wait/);
});
