// Tests for the friendly "app is restarting" error page (issue #426):
//
//   1. GET /__app_unavailable (src/routes/app-error.js) — the route
//      Caddy's wildcard-site handle_errors proxies dead-upstream errors
//      to. Pool + app-heal are stubbed via require.cache (same pattern
//      as tests/edge-gate.test.js).
//   2. The Caddyfile contract: the wildcard site rewrites 502/503/504 to
//      /__app_unavailable and proxies it to usernode:3000, while the
//      apex site keeps its plain terse handle_errors (same assertion
//      style as tests/chromeless-share-links.test.js).
//
// Run with: node --test tests/app-unavailable-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

// USERNODE_DOMAIN env is unset in tests → services/caddy.js default.
const DOMAIN = 'social-vibecoding.usernodelabs.org';
const PUB_HOST = `puzzle-chain.${DOMAIN}`;
const PRIV_HOST = `secretapp.${DOMAIN}`;

// ── stubs ──────────────────────────────────────────────────────────────
const healCalls = [];
const fakePool = {
  async query(sql, params = []) {
    if (/SELECT id, view_visibility FROM apps WHERE slug/.test(sql)) {
      if (params[0] === 'puzzle-chain') return { rows: [{ id: 1, view_visibility: 'public' }] };
      if (params[0] === 'secretapp') return { rows: [{ id: 2, view_visibility: 'private' }] };
      return { rows: [] };
    }
    if (/SELECT name FROM apps WHERE id/.test(sql)) {
      if (params[0] === 1) return { rows: [{ name: 'PUZZLE CHAIN' }] };
      return { rows: [] };
    }
    throw new Error(`app-unavailable stub: unexpected query: ${sql}`);
  },
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const poolPath = require.resolve('../src/db/pool');
const appHealPath = require.resolve('../src/services/app-heal');
stub(poolPath, { getPool: () => fakePool });
stub(appHealPath, { requestHeal: (slug) => healCalls.push(slug) });
delete require.cache[require.resolve('../src/services/app-access')];
delete require.cache[require.resolve('../src/routes/app-error')];

const { appErrorRoutes } = require('../src/routes/app-error');

// ── tiny http harness ──────────────────────────────────────────────────
let server;
let port;

test.before(async () => {
  const app = express();
  app.use(appErrorRoutes({ jwtSecret: 'test-secret' }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function get(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/__app_unavailable', method: 'GET', headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── route behavior ─────────────────────────────────────────────────────

test('document navigation gets a 503 HTML page with the neutral restarting copy', async () => {
  const res = await get({ host: PUB_HOST, 'sec-fetch-dest': 'document' });
  assert.equal(res.status, 503);
  assert.equal(res.headers['retry-after'], '10');
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.headers['content-type'], /text\/html/);
  // Public app: display name shown; copy is calm (this page also renders
  // during ordinary redeploys), never alarming.
  assert.match(res.body, /PUZZLE CHAIN is restarting/);
  assert.match(res.body, /back in a moment/);
  assert.ok(!/having trouble/i.test(res.body), 'copy must not say "having trouble"');
  // Escalation copy + auto-retry script are baked into the page.
  assert.match(res.body, /Still not responding/);
  assert.match(res.body, /window\.location\.reload/);
});

test('iframe loads (the shell embed) also get the HTML page', async () => {
  const res = await get({ host: PUB_HOST, 'sec-fetch-dest': 'iframe' });
  assert.equal(res.status, 503);
  assert.match(res.headers['content-type'], /text\/html/);
});

test('non-document fetches get JSON, not HTML', async () => {
  const res = await get({ host: PUB_HOST, 'sec-fetch-dest': 'empty' });
  assert.equal(res.status, 503);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), { error: 'app_unavailable' });
});

test('view-private apps get generic copy — no name leak', async () => {
  const res = await get({ host: PRIV_HOST, 'sec-fetch-dest': 'document' });
  assert.equal(res.status, 503);
  assert.match(res.body, /This app is restarting/);
  assert.ok(!res.body.includes('secretapp'), 'slug must not leak into the page');
});

test('unknown hosts still render the generic page instead of erroring', async () => {
  const res = await get({ host: `nosuchapp.${DOMAIN}`, 'sec-fetch-dest': 'document' });
  assert.equal(res.status, 503);
  assert.match(res.body, /This app is restarting/);
});

test('a production-host hit kicks the on-demand heal for the slug', async () => {
  healCalls.length = 0;
  await get({ host: PUB_HOST, 'sec-fetch-dest': 'document' });
  assert.deepEqual(healCalls, ['puzzle-chain']);
});

test('staging-preview hosts do NOT kick the production heal', async () => {
  healCalls.length = 0;
  await get({ host: `puzzle-chain--s42.${DOMAIN}`, 'sec-fetch-dest': 'document' });
  assert.deepEqual(healCalls, []);
});

// ── Caddyfile contract ─────────────────────────────────────────────────

function readCaddyfile() {
  return fs.readFileSync(path.join(__dirname, '..', 'Caddyfile'), 'utf8');
}

test('Caddyfile: wildcard site routes upstream 502/503/504 to /__app_unavailable via the platform', () => {
  const caddy = readCaddyfile();
  const wildcardIdx = caddy.indexOf('*.{$USERNODE_DOMAIN}');
  assert.ok(wildcardIdx > -1, 'wildcard site block exists');
  const wildcard = caddy.slice(wildcardIdx);
  const errIdx = wildcard.indexOf('handle_errors');
  assert.ok(errIdx > -1, 'wildcard site has a handle_errors block');
  const errBlock = wildcard.slice(errIdx);
  assert.match(errBlock, /\{err\.status_code\} in \[502, 503, 504\]/,
    'matches exactly the upstream-unreachable codes');
  assert.match(errBlock, /rewrite \* \/__app_unavailable/,
    'rewrites to the platform error route');
  assert.match(errBlock, /reverse_proxy usernode:3000/,
    'proxies the error page render to the platform');
  assert.match(errBlock, /respond "\{err\.status_code\} \{err\.status_text\}"/,
    'other error codes keep the terse respond fallback');
});

test('Caddyfile: apex site never proxies its error page (platform is the dead upstream there)', () => {
  const caddy = readCaddyfile();
  const apexIdx = caddy.indexOf('{$USERNODE_DOMAIN} {');
  const wildcardIdx = caddy.indexOf('*.{$USERNODE_DOMAIN}');
  assert.ok(apexIdx > -1 && wildcardIdx > apexIdx, 'apex block precedes wildcard block');
  const apex = caddy.slice(apexIdx, wildcardIdx);
  // #711 changed the apex handle_errors from the plain terse respond to a
  // caddy-served static "updating" page for document navigations — but the
  // original invariant this test pinned still holds: when the platform is
  // the dead upstream, the apex must not try to render its error page THROUGH
  // the platform (no /__app_unavailable proxy), and non-document requests
  // must keep the terse status respond. tests/caddy-deploy-grace.test.js
  // pins the updating-page half.
  assert.ok(!apex.includes('__app_unavailable'), 'apex does not reference the error route');
  const apexErrIdx = apex.indexOf('handle_errors');
  assert.ok(apexErrIdx > -1, 'apex site has a handle_errors block');
  const apexErr = apex.slice(apexErrIdx);
  assert.ok(!apexErr.includes('reverse_proxy'),
    'apex handle_errors must not proxy anywhere — its upstream is the thing that just died');
  assert.match(apexErr, /respond "\{err\.status_code\} \{err\.status_text\}"/,
    'non-document errors keep the terse respond fallback');
});
