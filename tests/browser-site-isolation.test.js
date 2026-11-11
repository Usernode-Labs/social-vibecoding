'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserSite, appHostIsIsolated, generatedHosts, validateBrowserSiteIsolation } = require('../src/services/browser-site-isolation');
const { isolationMode, sessionCookieName, scopeCookieName, readSessionCookie,
  sessionCookieOptions, setSessionCookie, clearSessionCookies } = require('../src/services/browser-session-cookies');

const strict = { NODE_ENV: 'production', APP_RUNTIME: 'kubernetes', BROWSER_SITE_ISOLATION: 'strict',
  USERNODE_DOMAIN: 'app.platform.example.com', USERNODE_APPS_DOMAIN: 'apps.example.net' };

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

test('strict configuration requires different browser sites, not just different hosts', () => {
  assert.equal(validateBrowserSiteIsolation(strict), 'strict');
  assert.equal(validateBrowserSiteIsolation({}), 'legacy');
  assert.throws(() => isolationMode({ BROWSER_SITE_ISOLATION: 'strcit' }), /legacy or strict/);
  assert.throws(() => isolationMode({ BROWSER_SITE_ISOLATION: '' }), /legacy or strict/);
  assert.throws(() => validateBrowserSiteIsolation({ ...strict, APP_RUNTIME: 'docker' }), /Kubernetes/);
  assert.throws(() => isolationMode({ BROWSER_SITE_ISOLATION: 'strict' }), /HTTPS/);
  for (const domain of ['', 'apps.example.com', 'example.com', 'platform.example.com',
    'https://example.net', 'example.net:443', '127.0.0.1', 'localhost', '*.example.net', 'com']) {
    assert.throws(() => validateBrowserSiteIsolation({ ...strict, USERNODE_APPS_DOMAIN: domain }),
      /different registrable site/, domain);
  }
});

test('site comparison follows the ICANN suffixes only, including international names', () => {
  assert.equal(browserSite('APP.Example.CO.UK.'), 'example.co.uk');
  assert.equal(appHostIsIsolated('apps.example.co.uk', 'platform.example.co.uk'), false);
  assert.equal(appHostIsIsolated('apps.example.co.uk', 'platform.other.co.uk'), true);
  assert.equal(browserSite('app.bücher.de'), 'xn--bcher-kva.de');
  // A private entry (github.io) separates sites only in browsers that ship
  // it, so the check never counts on one: under the ICANN section these
  // hosts share github.io, and only a different ICANN domain isolates.
  assert.equal(browserSite('app.tenant.github.io'), 'github.io');
  assert.equal(appHostIsIsolated('app.tenant.github.io', 'platform.other.github.io'), false);
  assert.equal(appHostIsIsolated('app.tenant.github.io', 'platform.example.com'), true);
  assert.throws(() => validateBrowserSiteIsolation({ ...strict,
    USERNODE_DOMAIN: 'platform.tenant.github.io', USERNODE_APPS_DOMAIN: 'apps.github.io' }),
  /different registrable site/, 'a private suffix never satisfies strict mode');
  for (const host of ['co.uk', 'bad..example.com', '-bad.example.com', 'localhost', 'x.test',
    'x.example.com/path', 'x.example.com\\path', 'x.example.com?x', ' x.example.com']) {
    assert.equal(browserSite(host), null, host);
  }
});

test('strict mode probes the app and preview hosts caddy.js actually builds', () => {
  const caddy = require('../src/services/caddy');
  const hosts = generatedHosts({ USERNODE_DOMAIN: caddy.USERNODE_DOMAIN, USERNODE_APPS_DOMAIN: caddy.USERNODE_APPS_DOMAIN });
  assert.equal(hosts.app, caddy.productionHostname('probe'));
  assert.equal(hosts.preview, caddy.stagingHostname('probe', 's1'));
  assert.deepEqual(generatedHosts(strict), { platform: 'app.platform.example.com', apps: 'apps.example.net',
    app: 'probe.apps.example.net', preview: 'probe--s1.apps.example.net' });
});

test('protected session authority ignores legacy cookies and refuses duplicate names', () => {
  assert.equal(sessionCookieName(strict), '__Host-usernode_session');
  assert.equal(scopeCookieName(strict), '__Host-usernode_api_scope');
  assert.equal(sessionCookieName({}), 'session');
  assert.equal(scopeCookieName({}), 'usernode_api_scope');
  const read = header => readSessionCookie({ headers: { cookie: header } }, strict);
  assert.equal(read('session=old'), null);
  assert.equal(read('session=old; __Host-usernode_session=new'), 'new');
  assert.equal(read('__Host-usernode_session=new; session=old'), 'new');
  assert.equal(read('__Host-usernode_session=new; __Host-usernode_session=other'), null);
  assert.equal(read('__Host-usernode_session=new; __Host-usernode_session=new'), null);
  assert.equal(read('__Host-usernode_session=%zz'), null);
  assert.equal(read('prefix__Host-usernode_session=new'), null);
  assert.equal(readSessionCookie({ headers: { cookie: '' }, cookies: { '__Host-usernode_session': 'forged' } }, strict), null);
  assert.equal(readSessionCookie({ cookies: { '__Host-usernode_session': 'adapter' } }, strict), 'adapter');
});

test('cookie writes and deletion preserve host-prefix attributes without widening Domain', t => {
  environment(t, { NODE_ENV: 'production', BROWSER_SITE_ISOLATION: 'strict' });
  const expiry = new Date(Date.now() + 3600e3), writes = [], clears = [];
  setSessionCookie({ cookie: (...args) => writes.push(args) }, 'fake-only', expiry);
  assert.equal(writes[0][0], '__Host-usernode_session');
  assert.deepEqual(writes[0][2], sessionCookieOptions(expiry, strict));
  assert.equal(writes[0][2].secure, true);
  assert.equal(writes[0][2].httpOnly, true);
  assert.equal(writes[0][2].path, '/');
  clearSessionCookies({ clearCookie: (...args) => clears.push(args) });
  assert.deepEqual(clears.map(([name]) => name),
    ['__Host-usernode_session', '__Host-usernode_api_scope', 'session', 'usernode_api_scope']);
  for (const [name, options] of clears) {
    assert.equal(options.domain, undefined);
    assert.equal(options.path, '/');
    if (name.startsWith('__Host-')) assert.equal(options.secure, true);
  }
});

test('strict generated hosts cannot share the platform site', t => {
  environment(t, { NODE_ENV: 'production', BROWSER_SITE_ISOLATION: 'strict' });
  const caddy = require('../src/services/caddy');
  assert.throws(() => caddy.assertAppHostname('app.example.com', 'platform.example.com'), /different browser site/);
  assert.equal(caddy.assertAppHostname('app.example.net', 'platform.example.com'), 'app.example.net');
});

test('strict custom-domain admission and cached resolution refuse the platform site', async t => {
  environment(t, { NODE_ENV: 'production', BROWSER_SITE_ISOLATION: 'legacy' });
  const caddy = require('../src/services/caddy');
  const before = { platform: caddy.USERNODE_DOMAIN, apps: caddy.USERNODE_APPS_DOMAIN };
  caddy.USERNODE_DOMAIN = 'platform.example.com';
  caddy.USERNODE_APPS_DOMAIN = 'apps.example.net';
  t.after(() => { caddy.USERNODE_DOMAIN = before.platform; caddy.USERNODE_APPS_DOMAIN = before.apps; });
  const domains = require('../src/services/app-domains');
  let queries = 0;
  const pool = { async query() { queries++; return { rows: [{ slug: 'fake-project' }] }; } };
  assert.equal((await domains.resolveAppHost(pool, 'sibling.example.com')).slug, 'fake-project');
  process.env.BROWSER_SITE_ISOLATION = 'strict';
  assert.throws(() => domains.normalizeHostname('sibling.example.com'), { code: 'platform_domain' });
  assert.equal(await domains.resolveAppHost(pool, 'sibling.example.com'), null);
  assert.equal(queries, 1, 'a previously cached custom host is refused without querying data');
  assert.equal(domains.normalizeHostname('www.project.example.org'), 'www.project.example.org');
});

test('invalid strict deployment stops configuration loading before other boot work', t => {
  environment(t, { ...strict, USERNODE_APPS_DOMAIN: 'apps.example.com' });
  assert.throws(() => require('../src/config').load(), /different registrable site/);
});

test('the shell document may be framed only by the platform itself', () => {
  const { applyShellDocumentHeaders, shellFrameAncestors } = require('../src/services/static-cache');
  // A preview of Homeroom inherits production's USERNODE_DOMAIN, so the
  // production shell that frames it stays allowed; nothing else does.
  assert.equal(shellFrameAncestors({ USERNODE_DOMAIN: 'app.onhomeroom.com' }), "frame-ancestors 'self' https://app.onhomeroom.com");
  assert.equal(shellFrameAncestors({}), "frame-ancestors 'self'");
  assert.equal(shellFrameAncestors({ USERNODE_DOMAIN: "x'; script-src *" }), "frame-ancestors 'self'");
  const headers = new Map();
  applyShellDocumentHeaders({ setHeader: (k, v) => headers.set(k, v) }, __filename, { USERNODE_DOMAIN: 'app.onhomeroom.com' });
  assert.equal(headers.get('Content-Security-Policy'), "frame-ancestors 'self' https://app.onhomeroom.com",
    'set on every shell document, a checkout without a build id included');
});
