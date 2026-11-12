'use strict';

// What a search engine is told about the addresses the platform answers for
// (src/services/search-robots.js), and that each place it is said still
// says it: the app-host gate (behaviour in tests/app-gate-proxy.test.js),
// the shared asset server, the shell's front page, the starter app and the
// conventions an app is built from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const robots = require('../src/services/search-robots');
const template = require('../src/services/template');
const { requestOrigin } = require('../src/routes/community-invites');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('an app host: API routes and the platform’s own paths are noindex, pages are left alone', () => {
  const on = (url, host = 'reloop-a41163.onhomeroom.com') => robots.appHostRobots({ host, url });
  for (const url of ['/api', '/api/', '/api/my/items', '/api/pins?pubkey=', '/__usernode/cache/', '/__usernode_access',
    '/usernode-bridge/v1/bridge.js', '/usernode-native/v1/native.css', '/usernode-tailwind/v1/tailwind.js']) {
    assert.equal(on(url), 'noindex', url);
  }
  for (const url of ['/', '/read/12?c=4', '/apiary', '/api-docs', '/my-list', '/usernode-bridge', '']) {
    assert.equal(on(url), null, url || '(empty)');
  }
});

test('a preview host is noindex whatever the path; an app whose name merely looks close is not', () => {
  for (const host of ['viatales-125912--s13423.onhomeroom.app', 'a--s1.onhomeroom.com:443', 'A--S7--abc.onhomeroom.app']) {
    assert.equal(robots.appHostRobots({ host, url: '/' }), 'noindex', host);
    assert.equal(robots.isPreviewHost(host), true, host);
  }
  for (const host of ['viatales-125912.onhomeroom.com', 'a--staging.onhomeroom.com', 'a-s12.onhomeroom.com', '', undefined]) {
    assert.equal(robots.appHostRobots({ host, url: '/' }), null, String(host));
  }
});

test('an app’s own X-Robots-Tag is kept, and noindex is added once', () => {
  assert.equal(robots.withRobots(undefined, 'noindex'), 'noindex');
  assert.equal(robots.withRobots('', 'noindex'), 'noindex');
  assert.equal(robots.withRobots('nofollow', 'noindex'), 'nofollow, noindex');
  assert.equal(robots.withRobots('NoIndex, nofollow', 'noindex'), 'NoIndex, nofollow');
  assert.equal(robots.withRobots(['nofollow', 'noarchive'], 'noindex'), 'nofollow, noarchive, noindex');
  assert.equal(robots.withRobots('nofollow', null), 'nofollow');
});

test('the shell’s front page names one address; nothing else, and nothing on a staging copy', () => {
  const link = (over) => robots.shellCanonicalLink({ method: 'GET', path: '/', origin: 'https://app.onhomeroom.com', ...over });
  assert.equal(link(), '<https://app.onhomeroom.com/>; rel="canonical"');
  assert.equal(link({ method: 'HEAD' }), '<https://app.onhomeroom.com/>; rel="canonical"');
  assert.equal(link({ method: 'POST' }), null);
  assert.equal(link({ path: '/app/some-project' }), null, 'a project page carries its own');
  assert.equal(link({ path: '/invite/abc' }), null);
  assert.equal(link({ staging: true }), null);
  assert.equal(link({ origin: null }), null);
  assert.equal(link({ origin: 'https://evil.example/>; rel="x' }), null, 'only a plain origin is ever written into the header');
});

test('server.js sends that header ahead of the static handler, so `/?report=app` gets it too', async () => {
  const source = read('server.js');
  const at = source.indexOf('shellCanonicalLink(');
  assert.ok(at > 0, 'server.js asks for the front page’s canonical');
  assert.ok(at < source.indexOf("app.use(express.static(path.join(__dirname, 'public'), {"),
    'before express.static, which is what answers `/`');

  // The same middleware shape, driven for real.
  const app = express();
  app.use((req, res, next) => {
    const value = robots.shellCanonicalLink({
      method: req.method, path: req.path, origin: requestOrigin(req), staging: false,
    });
    if (value) res.setHeader('Link', value);
    next();
  });
  app.get('*', (req, res) => res.send('shell'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' },
    })).headers.get('link');
    assert.equal(await get('/?report=app'), '<https://app.example.com/>; rel="canonical"');
    assert.equal(await get('/app/some-project'), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the shared asset server marks everything it sends noindex', () => {
  const source = read('scripts/serve-platform-assets.js');
  assert.match(source, /require\('\.\.\/src\/services\/search-robots'\)/);
  // Its three ways out: send(), the streamed 200, and a sleeping preview's page.
  assert.equal(source.split("'X-Robots-Tag': searchRobots.NOINDEX").length - 1, 3);
});

test('the gate asks the same module, after the app has answered', () => {
  const source = read('scripts/app-gate.js');
  assert.match(source, /searchRobots\.appHostRobots\(\{ host: req\.headers\.host, url: req\.url \}\)/);
  assert.match(source, /searchRobots\.withRobots\(headers\['x-robots-tag'\], robots\)/);
});

test('a public project’s page, its og:url and its sitemap entry are one address', () => {
  const preview = require('../src/services/project-preview');
  const { sitemapXml } = require('../src/routes/project-preview');
  const origin = 'https://app.onhomeroom.com';
  const app = { slug: 'crabtopia-92bdbe', name: 'Crabtopia', description: 'A crab town.' };
  const address = preview.pageUrl(origin, app.slug);
  const tags = preview.previewTags(app, origin);
  assert.ok(tags.includes(`<link rel="canonical" href="${address}">`));
  assert.ok(tags.includes(`<meta property="og:url" content="${address}">`));
  assert.ok(sitemapXml(origin, [app]).includes(`<loc>${address}</loc>`));
});

test('the starter app’s page names itself without its query string', () => {
  const files = template.getTemplateFiles('Demo', { slug: 'demo-1' });
  const server = (Array.isArray(files) ? files : Object.values(files)).find((f) => f.path === 'server.js').content;
  assert.match(server, /res\.set\('Link', '<https:\/\/' \+ pageHost \+ req\.path \+ '>; rel="canonical"'\)/);
  assert.match(server, /\/\^\[A-Za-z0-9\.-\]\+\$\/\.test\(pageHost\)/, 'only a plain host is written into the header');
  assert.ok(server.indexOf("res.set('Link'") > server.indexOf('Open this app inside Homeroom'),
    'on the page it serves, not on the "open in Homeroom" answer');
});

test('the conventions say it: a canonical without state or paging parameters, no per-visitor state in URLs, API routes noindex', () => {
  const doc = read('src/prompts/app-conventions.md');
  const at = doc.indexOf('### Search engines: one address per page');
  assert.ok(at > 0);
  const section = doc.slice(at, doc.indexOf('\n## Database', at));
  assert.match(section, /carries a\s+canonical without it/);
  assert.match(section, /Never put per-visitor state in a URL a crawler can follow/);
  assert.match(section, /API routes are never pages/);
  assert.match(section, /Do not block these URLs in `robots\.txt`/);
  assert.ok(section.length < 1800, 'kept short: it is read on every build');
});
