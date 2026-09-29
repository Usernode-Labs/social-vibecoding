// The Homeroom mark the hosted bridge draws in the corner of an app opened
// on its own subdomain (#2705). The block lives between the
// __USERNODE_PLATFORM_LINK_START__ / _END__ markers in
// public/usernode-bridge/v1/bridge.js, mirrored byte-for-byte in
// public/usernode-bridge.js.
//
// WHY THESE ARE BEHAVIOURAL and not another source-text match. The mark
// replaces a pill that had never once rendered: it derived the platform host
// from `document.currentScript.src` and returned null when that came out
// equal to location.host, which is precisely what happens for an app loading
// the bridge at the relative path the conventions mandate. Every source-text
// assertion covering it passed the whole time. So this file runs the real
// block, against a fake DOM, on the hostnames that matter — a shared app
// link, a staging preview, the platform's own apex, a dev host — and asserts
// what ends up in the document.
//
// The extraction + fake-window style is the one tests/usernode-invariants.js
// established for the bridge's other self-contained IIFEs.
//
// Run with: node --test tests/bridge-platform-mark.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const versioned = path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js');
const unversioned = path.join(root, 'public', 'usernode-bridge.js');
const markFile = path.join(root, 'public', 'usernode-bridge', 'v1', 'mark.svg');
const wordmark = path.join(root, 'frontend', '@', 'components', 'ui', 'wordmark.tsx');

function platformLinkBlock(file) {
  const src = fs.readFileSync(file, 'utf8');
  const begin = src.indexOf('/* __USERNODE_PLATFORM_LINK_START__ */');
  const end = src.indexOf('/* __USERNODE_PLATFORM_LINK_END__ */');
  assert.ok(begin !== -1 && end !== -1 && end > begin, `${file}: block markers present`);
  return src.slice(begin, end);
}

// ---------------------------------------------------------------------------
// A DOM just large enough for the block: element creation, the two id lookups
// it guards on, and the two append points. Elements record what was set on
// them so the assertions can read the result rather than the source.

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    style: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name] : null;
    },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  return el;
}

function descendants(el) {
  return el.children.flatMap((child) => [child, ...descendants(child)]);
}

// `host` is the document's hostname; `scriptSrc` is what the app wrote in its
// <script> tag, resolved against it the way the browser would.
function render(block, {
  host,
  scriptSrc = '/usernode-bridge/v1/bridge.js',
  inIframe = false,
  hasNativeChannel = false,
  platformShell = false,
  legacyUsernodeGlobal = false,
  readyState = 'loading',
  runs = 1,
} = {}) {
  const origin = `https://${host}`;
  const head = makeElement('head');
  const body = makeElement('body');
  const currentScript = makeElement('script');
  currentScript.src = scriptSrc ? new URL(scriptSrc, `${origin}/`).href : '';

  const listeners = {};
  const document = {
    head,
    body,
    currentScript,
    readyState,
    createElement: makeElement,
    getElementById(id) {
      return [...descendants(head), ...descendants(body)]
        .find((el) => el.id === id) || null;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };

  const window = { document, location: { host, href: `${origin}/` }, URL };
  if (platformShell) window.__usernodePlatformShell = true;
  if (legacyUsernodeGlobal) window.Usernode = {};
  window.window = window;

  const sandbox = { window, document, location: window.location, URL, console };
  vm.createContext(sandbox);
  for (let i = 0; i < runs; i += 1) {
    vm.runInContext(
      `(function (_inIframe, _hasNativeChannel) {\n${block}\n})(${inIframe}, ${hasNativeChannel});`,
      sandbox,
    );
  }

  // The block defers to DOMContentLoaded while the document is still parsing,
  // which is the real load order — fire it the way the browser would.
  for (const fn of listeners.DOMContentLoaded || []) fn();

  const link = document.getElementById('__un-platform-link');
  return { link, head, body, document };
}

const SHARED_APP = { host: 'bread-bot-3e3f5c.onhomeroom.com' };

for (const [name, file] of [['versioned', versioned], ['legacy flat', unversioned]]) {
  test(`${name} bridge: a shared app link gets the mark`, () => {
    const { link, body } = render(platformLinkBlock(file), SHARED_APP);

    assert.ok(link, 'the mark is in the document');
    assert.equal(link.parentNode, body, 'appended to <body>, above the app');
    assert.equal(link.href, 'https://onhomeroom.com/app/bread-bot-3e3f5c',
      'links to the app’s canonical in-platform route, on the platform host');
    assert.equal(link.getAttribute('aria-label'), 'Open this app on Homeroom');
    assert.equal(link.title, 'Open this app on Homeroom');

    const img = link.children[0];
    assert.equal(img.tagName, 'IMG');
    assert.equal(img.src, '/usernode-bridge/v1/mark.svg',
      'relative: the app carries no platform hostname');
    assert.equal(img.alt, '', 'the anchor already carries the accessible name');
  });
}

// THE REGRESSION. Every app loads the bridge at the relative path the
// conventions mandate, and that is the case the old script-src derivation got
// wrong — silently, on every shared link there has ever been.
test('the relative bridge tag — every app’s — still yields the platform host', () => {
  const block = platformLinkBlock(versioned);
  const relative = render(block, { host: 'bread-bot.onhomeroom.com', scriptSrc: '/usernode-bridge/v1/bridge.js' });
  assert.ok(relative.link, 'a relative tag draws the mark');
  assert.equal(relative.link.href, 'https://onhomeroom.com/app/bread-bot');

  // An older app that names the platform outright agrees, and gets the same
  // link rather than being second-guessed.
  const absolute = render(block, {
    host: 'bread-bot.onhomeroom.com',
    scriptSrc: 'https://onhomeroom.com/usernode-bridge/v1/bridge.js',
  });
  assert.ok(absolute.link, 'an absolute tag naming the platform draws it too');
  assert.equal(absolute.link.href, 'https://onhomeroom.com/app/bread-bot');
});

test('a page that names some OTHER host in the tag gets nothing', () => {
  // A foreign site embedding the platform's bridge: the host it names is not
  // the one its own hostname implies, so it is not an app subdomain.
  const { link } = render(platformLinkBlock(versioned), {
    host: 'blog.example.com',
    scriptSrc: 'https://onhomeroom.com/usernode-bridge/v1/bridge.js',
  });
  assert.equal(link, null);
});

test('the mark is suppressed everywhere a second one would be wrong', () => {
  const block = platformLinkBlock(versioned);

  // Inside the platform the app is in an iframe and the shell draws its own
  // affordance (features/header/chromeless-pill.tsx) — this is the "must not
  // appear twice" case.
  assert.equal(render(block, { ...SHARED_APP, inIframe: true }).link, null,
    'in the platform iframe');
  // The Flutter WebView navigates itself; a web link to the platform origin
  // is the wrong gesture there.
  assert.equal(render(block, { ...SHARED_APP, hasNativeChannel: true }).link, null,
    'in the native WebView');
  // The platform's own document loads this same bridge in the TOP frame from
  // its apex, and is indistinguishable from an app subdomain by hostname
  // shape alone — so it says so.
  assert.equal(render(block, { host: 'social-vibecoding.usernodelabs.org', platformShell: true }).link, null,
    'on the platform shell');
  // A dapp that vendors its own bridge publishes the legacy global.
  assert.equal(render(block, { ...SHARED_APP, legacyUsernodeGlobal: true }).link, null,
    'with a vendored bridge already present');
});

test('only a production app subdomain qualifies', () => {
  const block = platformLinkBlock(versioned);
  const drawn = (host) => !!render(block, { host }).link;

  assert.ok(drawn('bread-bot-3e3f5c.onhomeroom.com'), 'a production app');
  assert.ok(drawn('a.social-vibecoding.usernodelabs.org'), 'a deeper platform domain');

  assert.ok(!drawn('bread-bot--s42.onhomeroom.com'), 'a staging preview');
  assert.ok(!drawn('bread-bot--s42--ab12cd.onhomeroom.com'), 'a legacy staging preview');
  assert.ok(!drawn('onhomeroom.com'), 'the apex itself, label-less');
  assert.ok(!drawn('localhost:3000'), 'plain local dev');
  assert.ok(!drawn('bread-bot.localhost:3000'), 'a single-label dev host');
});

// The suppression above is only as good as the flag the shell sets, and the
// two live in different trees — so pin the pair. Without this the shell would
// quietly grow a mark of its own, linking one label up from its apex.
test('the platform shell publishes the flag the bridge reads', () => {
  const head = fs.readFileSync(path.join(root, 'frontend', 'src', 'head.html'), 'utf8');
  assert.match(head, /window\.__usernodePlatformShell = true;/,
    'the shell declares itself');
  // Before DOMContentLoaded, which is when the block reads it: the bridge tag
  // and this marker are both head-blocking, and the marker follows it.
  assert.ok(head.indexOf('window.__usernodePlatformShell')
    > head.indexOf('<script src="/usernode-bridge.js"></script>'),
    'set after the bridge loads, read long after that');
  assert.match(platformLinkBlock(versioned), /window\.__usernodePlatformShell/,
    'and the bridge reads that exact name');
});

test('the mark is permanent: no dismiss control, nothing remembered', () => {
  const { link } = render(platformLinkBlock(versioned), SHARED_APP);
  const buttons = descendants(link).filter((el) => el.tagName === 'BUTTON');
  assert.equal(buttons.length, 0, 'nothing to dismiss it with');
  assert.equal(descendants(link).length, 1, 'the anchor holds the mark and nothing else');
});

test('the mark is injected once, however often the block runs', () => {
  // A page that loads the hosted bridge AND vendors a copy runs the block
  // twice against one document; the id guard is what stops two marks
  // stacking in the same corner.
  const { body, head } = render(platformLinkBlock(versioned), { ...SHARED_APP, runs: 2 });
  const marks = body.children.filter((el) => el.id === '__un-platform-link');
  assert.equal(marks.length, 1, 'one mark');
  const styles = head.children.filter((el) => el.id === '__usernode-platform-link-styles');
  assert.equal(styles.length, 1, 'one stylesheet');
});

// ---------------------------------------------------------------------------
// The asset itself.

test('the mark is served under a centrally hosted prefix, as a real SVG', () => {
  const svg = fs.readFileSync(markFile, 'utf8');
  assert.match(svg, /^<svg /, 'an SVG document');
  assert.match(svg, /viewBox="0 0 32 32"/);

  // The three prefixes the platform serves on every app's own hostname —
  // Caddy's @platform_assets matcher and kubernetes.js's
  // PLATFORM_ASSET_PREFIXES. The file has to be under one of them or the
  // relative src in the bridge resolves to the app's own container.
  const assets = require('../scripts/serve-platform-assets.js');
  assert.ok(assets.resolveAsset('/usernode-bridge/v1/mark.svg'),
    'the Kubernetes asset sidecar resolves it');
  assert.equal(assets.isAssetPath('/usernode-bridge/v1/mark.svg'), true);
});

test('the mark’s star is the logotype’s star, character for character', () => {
  // public/brand/README.md makes wordmark.tsx the logotype's source of truth.
  // This file is a second copy of one of its subpaths — the only one that
  // reads at 28px — so the two are pinned together rather than left to drift.
  const paths = [...fs.readFileSync(wordmark, 'utf8')
    .matchAll(/^ {2}'(M[^']+)',$/gm)].map((m) => m[1]);
  assert.equal(paths.length, 8, 'the logotype is eight subpaths');

  const svg = fs.readFileSync(markFile, 'utf8');
  assert.ok(svg.includes(`d="${paths[7]}"`),
    'the mark draws the logotype’s eighth subpath, unmodified');
});
