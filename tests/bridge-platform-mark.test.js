// The Homeroom button the hosted bridge draws in the corner of an app opened
// at its own address (#3657; it replaced #2705's bottom-left mark). The block
// lives between the __USERNODE_PLATFORM_LINK_START__ / _END__ markers in
// public/usernode-bridge/v1/bridge.js, mirrored byte-for-byte in
// public/usernode-bridge.js.
//
// WHY THESE ARE BEHAVIOURAL and not another source-text match. The first
// version of this affordance never rendered on a single shared link while
// every source-text assertion covering it passed, and the second linked to a
// platform host that does not exist on the hosted deployment (the apex of
// <slug>.onhomeroom.com is the marketing site; the platform is app.<domain>).
// So this file runs the real block, against a fake DOM and a fake fetch, on
// the hostnames and platform documents that matter, and asserts what ends up
// in the document.
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
// A DOM just large enough for the block: element creation, attributes,
// `hidden`, text, listeners, a closed shadow root, and id lookups over the
// LIGHT tree only (a closed root is not reachable from the document, which is
// the property the button relies on).

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    hidden: false,
    textContent: '',
    className: '',
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
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
  };
  if (tag === 'div') {
    el.attachShadow = function attachShadow(init) {
      this.shadowMode = init && init.mode;
      this._shadow = { children: [], appendChild(child) { child.parentNode = this; this.children.push(child); return child; } };
      return this._shadow;
    };
  }
  return el;
}

function descendants(el) {
  return el.children.flatMap((child) => [child, ...descendants(child)]);
}

const CONFIG_HOSTED = {
  version: 1,
  platform_origin: 'https://app.onhomeroom.com',
  apps_domain: 'onhomeroom.com',
  site_url: 'https://onhomeroom.com',
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

// `host` is the document's hostname; `scriptSrc` is what the app wrote in its
// <script> tag; `config` is what /usernode-bridge/v1/platform.json answers on
// this origin (a status number for a failure).
async function render(block, {
  host,
  scriptSrc = '/usernode-bridge/v1/bridge.js',
  config = CONFIG_HOSTED,
  inIframe = false,
  hasNativeChannel = false,
  platformShell = false,
  legacyUsernodeGlobal = false,
  readyState = 'loading',
  title = 'Bread Bot',
  runs = 1,
  noShadow = false,
} = {}) {
  const origin = `https://${host}`;
  const head = makeElement('head');
  const body = makeElement('body');
  const currentScript = makeElement('script');
  currentScript.src = scriptSrc ? new URL(scriptSrc, `${origin}/`).href : '';

  const listeners = {};
  const fetched = [];
  const document = {
    head,
    body,
    currentScript,
    readyState,
    title,
    createElement(tag) {
      const el = makeElement(tag);
      if (noShadow) delete el.attachShadow;
      return el;
    },
    getElementById(id) {
      return [...descendants(head), ...descendants(body)]
        .find((el) => el.id === id) || null;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };

  const fetch = (url, init) => {
    fetched.push({ url, init });
    if (typeof config === 'number') return Promise.resolve({ ok: false, status: config, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(config)) });
  };

  const hostname = host.replace(/:\d+$/, '');
  const window = { document, location: { host, hostname, href: `${origin}/` }, URL, fetch };
  if (platformShell) window.__usernodePlatformShell = true;
  if (legacyUsernodeGlobal) window.Usernode = {};
  window.window = window;

  const sandbox = { window, document, location: window.location, URL, console, Promise };
  vm.createContext(sandbox);
  for (let i = 0; i < runs; i += 1) {
    vm.runInContext(
      `(function (_inIframe, _hasNativeChannel) {\n${block}\n})(${inIframe}, ${hasNativeChannel});`,
      sandbox,
    );
  }
  // The block defers to DOMContentLoaded while the document is parsing,
  // which is the real load order; fire it the way the browser would, then
  // let the config fetch settle.
  for (const fn of listeners.DOMContentLoaded || []) fn();
  for (let i = 0; i < 5; i += 1) await tick();

  const hostEl = document.getElementById('__un-platform-link');
  const shadow = hostEl ? hostEl._shadow : null;
  const all = shadow ? shadow.children.flatMap((c) => [c, ...descendants(c)]) : [];
  const byClass = (cls) => all.find((el) => el.className === cls) || null;
  const rows = all.filter((el) => el.className === 'row');
  return {
    host: hostEl, shadow, all, byClass, rows, body, head, document, listeners, fetched,
    fab: byClass('fab'), panel: byClass('panel'), bar: byClass('bar'),
  };
}

const SHARED_APP = { host: 'bread-bot-3e3f5c.onhomeroom.com' };

for (const [name, file] of [['versioned', versioned], ['legacy flat', unversioned]]) {
  test(`${name} bridge: an app at its own address gets the button`, async () => {
    const r = await render(platformLinkBlock(file), SHARED_APP);

    assert.ok(r.host, 'the button host is in the document');
    assert.equal(r.host.parentNode, r.body, 'appended to <body>, above the app');
    assert.equal(r.host.shadowMode, 'closed', 'in a CLOSED shadow root');
    assert.equal(r.fab.tagName, 'BUTTON');
    assert.equal(r.fab.getAttribute('aria-label'), 'Homeroom');
    assert.equal(r.fab.getAttribute('aria-expanded'), 'false');
    const img = r.fab.children[0];
    assert.equal(img.tagName, 'IMG');
    assert.equal(img.src, '/usernode-bridge/v1/mark.svg', 'relative: the app carries no hostname');
    assert.equal(img.alt, '', 'the button already carries the accessible name');

    // The config is read from this origin, with no credentials.
    assert.equal(r.fetched.length, 1);
    assert.equal(r.fetched[0].url, '/usernode-bridge/v1/platform.json');
    assert.equal(r.fetched[0].init.credentials, 'omit');
  });
}

test('the panel: the app’s name, one line about Homeroom, and three rows', async () => {
  const r = await render(platformLinkBlock(versioned), SHARED_APP);
  assert.equal(r.panel.hidden, true, 'closed until asked for');

  r.fab.click();
  assert.equal(r.panel.hidden, false, 'the button opens it');
  assert.equal(r.fab.getAttribute('aria-expanded'), 'true');
  assert.equal(r.byClass('name').textContent, 'Bread Bot', 'the app’s name');
  assert.equal(r.byClass('about').textContent, 'A Homeroom app, built and voted on by its community.');

  const [open, toggle, what] = r.rows;
  assert.equal(open.tagName, 'A');
  assert.equal(open.textContent, 'Open in Homeroom');
  assert.equal(open.href, 'https://app.onhomeroom.com/#app/bread-bot-3e3f5c',
    'the app inside the platform, on the PLATFORM host');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.textContent, 'Show the Homeroom header');
  assert.equal(what.tagName, 'A');
  assert.equal(what.textContent, 'What is Homeroom?');
  assert.equal(what.href, 'https://onhomeroom.com/');
  assert.equal(what.target, '_blank');
  assert.equal(what.rel, 'noopener');

  r.fab.click();
  assert.equal(r.panel.hidden, true, 'the button closes it again');
});

test('the header row toggles a slim bar with the wordmark and the app’s name', async () => {
  const r = await render(platformLinkBlock(versioned), SHARED_APP);
  const toggle = r.rows[1];
  assert.equal(r.bar.hidden, true);

  r.fab.click();
  toggle.click();
  assert.equal(r.bar.hidden, false, 'the bar shows');
  assert.equal(r.panel.hidden, true, 'the panel gets out of the way');
  assert.equal(r.byClass('brand').textContent, 'Homeroom');
  assert.equal(r.byClass('title').textContent, 'Bread Bot');
  assert.equal(toggle.textContent, 'Hide the Homeroom header');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  toggle.click();
  assert.equal(r.bar.hidden, true, 'the same row hides it');
  assert.equal(toggle.textContent, 'Show the Homeroom header');

  toggle.click();
  r.byClass('close').click();
  assert.equal(r.bar.hidden, true, 'and so does the bar’s own close');
});

test('Escape and a tap outside close the panel; a tap inside does not', async () => {
  const r = await render(platformLinkBlock(versioned), SHARED_APP);
  r.fab.click();
  for (const fn of r.listeners.click || []) fn({ composedPath: () => [r.byClass('about'), r.panel, r.shadow, r.host, r.body] });
  assert.equal(r.panel.hidden, false, 'inside the button’s tree: stays open');
  for (const fn of r.listeners.click || []) fn({ composedPath: () => [r.body] });
  assert.equal(r.panel.hidden, true, 'outside: closes');

  r.fab.click();
  for (const fn of r.listeners.keydown || []) fn({ key: 'Escape' });
  assert.equal(r.panel.hidden, true, 'Escape closes');
});

test('the app’s name is text, clamped, and falls back to the slug', async () => {
  const long = await render(platformLinkBlock(versioned), { ...SHARED_APP, title: `  ${'x'.repeat(80)}  ` });
  long.fab.click();
  assert.ok(long.byClass('name').textContent.length <= 60);

  const untitled = await render(platformLinkBlock(versioned), { ...SHARED_APP, title: '' });
  untitled.fab.click();
  assert.equal(untitled.byClass('name').textContent, 'bread bot', 'slug without its suffix');

  const markup = await render(platformLinkBlock(versioned), { ...SHARED_APP, title: '<img src=x onerror=alert(1)>' });
  markup.fab.click();
  assert.equal(markup.byClass('name').textContent, '<img src=x onerror=alert(1)>', 'set as text, never parsed');
  assert.ok(!markup.all.some((el) => el.tagName === 'IMG' && el.src === 'x'));
});

test('a single-domain deployment links to its own apex', async () => {
  const r = await render(platformLinkBlock(versioned), {
    host: 'bread-bot.social-vibecoding.usernodelabs.org',
    config: {
      version: 1,
      platform_origin: 'https://social-vibecoding.usernodelabs.org',
      apps_domain: 'social-vibecoding.usernodelabs.org',
      site_url: 'https://onhomeroom.com',
    },
  });
  assert.ok(r.host);
  assert.equal(r.rows[0].href, 'https://social-vibecoding.usernodelabs.org/#app/bread-bot');
});

test('no config, or a config that disagrees with this host, draws nothing', async () => {
  const block = platformLinkBlock(versioned);
  const drawn = async (opts) => !!(await render(block, { ...SHARED_APP, ...opts })).host;

  assert.ok(!(await drawn({ config: 404 })), 'the path is not answered');
  assert.ok(!(await drawn({ config: null })), 'an empty answer');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, apps_domain: 'example.com' } })),
    'this host is not under the apps domain');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, platform_origin: 'https://evil.example' } })),
    'a platform outside this deployment');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, platform_origin: 'http://app.onhomeroom.com' } })),
    'not https');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, platform_origin: 'https://user:pw@app.onhomeroom.com' } })),
    'credentials in the URL');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, platform_origin: 'javascript:alert(1)' } })),
    'not a URL at all');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, platform_origin: 'https://bread-bot-3e3f5c.onhomeroom.com' } })),
    'the app’s own host');
  assert.ok(!(await drawn({ config: { ...CONFIG_HOSTED, apps_domain: 'onhomeroom.com/x' } })),
    'a malformed apps domain');
});

test('a bad site_url falls back to the platform rather than linking anywhere', async () => {
  const r = await render(platformLinkBlock(versioned), {
    ...SHARED_APP, config: { ...CONFIG_HOSTED, site_url: 'javascript:alert(1)' },
  });
  assert.equal(r.rows[2].href, 'https://app.onhomeroom.com/');
});

test('a tag that names some other host gets nothing', async () => {
  // A foreign site, or an app naming a host that is not this deployment's
  // platform, is not an app at its own address.
  const r = await render(platformLinkBlock(versioned), {
    ...SHARED_APP, scriptSrc: 'https://cdn.example.com/usernode-bridge/v1/bridge.js',
  });
  assert.equal(r.host, null);
  // Naming the platform itself is fine.
  const named = await render(platformLinkBlock(versioned), {
    ...SHARED_APP, scriptSrc: 'https://app.onhomeroom.com/usernode-bridge/v1/bridge.js',
  });
  assert.ok(named.host);
});

test('the button is suppressed everywhere a second one would be wrong', async () => {
  const block = platformLinkBlock(versioned);
  const none = async (opts) => {
    const r = await render(block, { ...SHARED_APP, ...opts });
    return r.host === null && r.fetched.length === 0;
  };
  // Inside the platform the app is in an iframe and the shell draws its own
  // chrome: the "must not appear twice" case. The app cannot change this.
  assert.ok(await none({ inIframe: true }), 'in the platform iframe');
  assert.ok(await none({ hasNativeChannel: true }), 'in the native WebView');
  assert.ok(await none({ host: 'app.onhomeroom.com', platformShell: true }), 'on the platform shell');
  assert.ok(await none({ legacyUsernodeGlobal: true }), 'with a vendored bridge already present');
});

test('only a production app host qualifies', async () => {
  const block = platformLinkBlock(versioned);
  const drawn = async (host, config) => !!(await render(block, { host, config })).host;

  assert.ok(await drawn('bread-bot-3e3f5c.onhomeroom.com'), 'a production app');
  assert.ok(!(await drawn('bread-bot--s42.onhomeroom.com')), 'a staging preview');
  assert.ok(!(await drawn('bread-bot--s42--ab12cd.onhomeroom.com')), 'a legacy staging preview');
  assert.ok(!(await drawn('onhomeroom.com')), 'the apex itself');
  assert.ok(!(await drawn('localhost:3000')), 'plain local dev');
  assert.ok(!(await drawn('bread-bot.localhost:3000')), 'a single-label dev host');
  assert.ok(!(await drawn('a.b.onhomeroom.com')), 'deeper than one label under the apps domain');
});

test('no shadow DOM, no button (never an unprotected one)', async () => {
  const r = await render(platformLinkBlock(versioned), { ...SHARED_APP, noShadow: true });
  assert.equal(r.host, null);
});

test('the platform shell publishes the flag the bridge reads', () => {
  const head = fs.readFileSync(path.join(root, 'frontend', 'src', 'head.html'), 'utf8');
  assert.match(head, /window\.__usernodePlatformShell = true;/, 'the shell declares itself');
  assert.ok(head.indexOf('window.__usernodePlatformShell')
    > head.indexOf('<script src="/usernode-bridge.js"></script>'),
    'set after the bridge loads, read long after that');
  assert.match(platformLinkBlock(versioned), /window\.__usernodePlatformShell/,
    'and the bridge reads that exact name');
});

test('the button is drawn once, however often the block runs', async () => {
  // A page that loads the hosted bridge AND vendors a copy runs the block
  // twice against one document; the id guard stops two buttons stacking.
  const r = await render(platformLinkBlock(versioned), { ...SHARED_APP, runs: 2 });
  assert.equal(r.body.children.filter((el) => el.id === '__un-platform-link').length, 1);
});

test('nothing is remembered between loads', () => {
  const block = platformLinkBlock(versioned);
  assert.doesNotMatch(block, /localStorage|sessionStorage|document\.cookie/);
});

test('the copy carries no em dash', () => {
  // Comments may say what they like; strings a person reads may not.
  const strings = platformLinkBlock(versioned).split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.doesNotMatch(strings, /—|\\u2014/);
});

// ---------------------------------------------------------------------------
// The document it reads, and the asset itself.

test('both servers answer platform.json from deployment settings', () => {
  const cfg = require('../src/services/app-host-config');
  assert.equal(cfg.CONFIG_PATH, '/usernode-bridge/v1/platform.json');
  assert.deepEqual(cfg.appHostConfig({
    platformDomain: 'app.onhomeroom.com', appsDomain: 'onhomeroom.com', marketingBaseUrl: 'https://onhomeroom.com/',
  }), {
    version: 1,
    platform_origin: 'https://app.onhomeroom.com',
    apps_domain: 'onhomeroom.com',
    site_url: 'https://onhomeroom.com',
  });
  // Single-domain: apps sit under the platform's own domain.
  assert.equal(cfg.appHostConfig({ platformDomain: 'example.org' }).apps_domain, 'example.org');
  // A dev box (or a missing setting) yields no document at all.
  assert.equal(cfg.appHostConfig({ platformDomain: 'localhost:3000' }), null);
  assert.equal(cfg.appHostConfig({}), null);
  assert.deepEqual(cfg.appHostConfigFromEnv({
    USERNODE_DOMAIN: 'app.onhomeroom.com', USERNODE_APPS_DOMAIN: 'onhomeroom.com', MARKETING_BASE_URL: '',
  }).apps_domain, 'onhomeroom.com');
  assert.equal(cfg.CONFIG_HEADERS['Access-Control-Allow-Origin'], '*');

  // The platform serves it; so does the Kubernetes asset server, from the
  // env its Deployment is given.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/usernode-bridge\/v1\/platform\.json',/);
  const assets = fs.readFileSync(path.join(root, 'scripts', 'serve-platform-assets.js'), 'utf8');
  assert.match(assets, /pathname === appHostConfig\.CONFIG_PATH/);
  const k8s = require('../src/services/kubernetes');
  const env = k8s._platformAssetEnvForTest({
    marketingBaseUrl: 'https://onhomeroom.com',
    kubernetes: { platformDomain: 'app.onhomeroom.com', appDomain: 'onhomeroom.com' },
  });
  assert.deepEqual(env, [
    { name: 'USERNODE_DOMAIN', value: 'app.onhomeroom.com' },
    { name: 'USERNODE_APPS_DOMAIN', value: 'onhomeroom.com' },
    { name: 'MARKETING_BASE_URL', value: 'https://onhomeroom.com' },
  ]);
});

test('the asset server answers platform.json and still nothing else outside the prefixes', async () => {
  const http = require('node:http');
  const saved = { ...process.env };
  process.env.USERNODE_DOMAIN = 'app.onhomeroom.com';
  process.env.USERNODE_APPS_DOMAIN = 'onhomeroom.com';
  process.env.MARKETING_BASE_URL = 'https://onhomeroom.com';
  const { server } = require('../scripts/serve-platform-assets.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  try {
    const ok = await get('/usernode-bridge/v1/platform.json');
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /application\/json/);
    assert.equal(ok.headers['access-control-allow-origin'], '*');
    assert.equal(JSON.parse(ok.body).platform_origin, 'https://app.onhomeroom.com');
    assert.equal((await get('/platform.json')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of ['USERNODE_DOMAIN', 'USERNODE_APPS_DOMAIN', 'MARKETING_BASE_URL']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    }
  }
});

test('the mark is served under a centrally hosted prefix, as a real SVG', () => {
  const svg = fs.readFileSync(markFile, 'utf8');
  assert.match(svg, /^<svg /, 'an SVG document');
  assert.match(svg, /viewBox="0 0 32 32"/);
  const assets = require('../scripts/serve-platform-assets.js');
  assert.ok(assets.resolveAsset('/usernode-bridge/v1/mark.svg'),
    'the Kubernetes asset sidecar resolves it');
  assert.equal(assets.isAssetPath('/usernode-bridge/v1/mark.svg'), true);
});

test('the mark’s star is the logotype’s star, character for character', () => {
  // public/brand/README.md makes wordmark.tsx the logotype's source of truth.
  const paths = [...fs.readFileSync(wordmark, 'utf8')
    .matchAll(/^ {2}'(M[^']+)',$/gm)].map((m) => m[1]);
  assert.equal(paths.length, 8, 'the logotype is eight subpaths');
  const svg = fs.readFileSync(markFile, 'utf8');
  assert.ok(svg.includes(`d="${paths[7]}"`),
    'the mark draws the logotype’s eighth subpath, unmodified');
});
