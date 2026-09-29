// Cross-origin access for the anonymous `/api/public/*` tier.
//
// The waitlist join and check-my-status forms live on marketing pages the
// platform does not host, so they are browser calls from another origin. Two
// things had to be true for them to work, and neither was: the response has
// to carry an Access-Control-Allow-Origin header, and the OPTIONS preflight
// that a JSON POST triggers has to be answered (POST /api/public/waitlist/
// status is registered for POST only, so its preflight used to fall through
// to the SPA catch-all and come back as an HTML 200 with no CORS headers).
//
// Four properties pinned here, because each is the kind of thing that keeps
// "working" while being wrong:
//
//   1. the preflight on the waitlist STATUS route is a 204 carrying the
//      allowed origin, methods and headers;
//   2. the real POST that follows it carries the allowed origin too — a
//      preflight that passes in front of a response the browser then
//      discards is the same outage with an extra round trip;
//   3. Access-Control-Allow-Credentials is never sent and the origin is
//      never echoed, so no cookie can ride a cross-origin call; and
//   4. the scope really is this prefix — a route outside `/api/public/`
//      gains no CORS header and its OPTIONS is not swallowed.
//
// Run with: node --test tests/public-api-cors.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  publicApiCors,
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
} = require('../src/middleware/public-cors');

// The middleware mounts ahead of every gate in server.js, so the app under
// test is that shape: the CORS middleware, then a stand-in for the routes it
// fronts. Nothing here needs a database — the header contract is decided
// before any handler runs.
function buildApp() {
  const app = express();
  app.use(publicApiCors());
  app.use(express.json());
  app.post('/api/public/waitlist/status', (_req, res) => {
    res.json({ ok: true, on_list: false, admitted: false, status: null });
  });
  app.get('/api/public/waitlist/options', (_req, res) => res.json({ ok: true }));
  // Stands in for every cookie-authenticated route on the platform.
  app.get('/api/apps', (_req, res) => res.json({ apps: [] }));
  app.post('/api/apps', (_req, res) => res.json({ ok: true }));
  return app;
}

function request(server, { method, path: reqPath, headers = {}, body = null }) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The origin from the report: a Framer-hosted landing page, i.e. an origin
// the platform has never heard of and cannot enumerate in advance. That is
// the whole reason the allowed origin is a wildcard and not a list.
const ORIGIN = 'https://inclusive-team-584922.framer.app';

test('the waitlist status preflight is answered with the CORS contract', async () => {
  await withServer(async (server) => {
    const res = await request(server, {
      method: 'OPTIONS',
      path: '/api/public/waitlist/status',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-methods'], ALLOWED_METHODS);
    assert.equal(res.headers['access-control-allow-headers'], ALLOWED_HEADERS);
    // POST is what the status and join calls use; the reads are GETs.
    assert.match(res.headers['access-control-allow-methods'], /\bPOST\b/);
    assert.match(res.headers['access-control-allow-methods'], /\bGET\b/);
    // Content-Type is the one header a JSON POST cannot do without: it is
    // outside the CORS safelist, so a preflight that omitted it would fail
    // with the body already written.
    assert.match(res.headers['access-control-allow-headers'], /Content-Type/i);
    // A preflight nobody has to repeat per keystroke.
    assert.ok(Number(res.headers['access-control-max-age']) > 0);
  });
});

test('the status POST behind that preflight carries the allowed origin', async () => {
  await withServer(async (server) => {
    const body = JSON.stringify({ email: 'nobody@example.invalid' });
    const res = await request(server, {
      method: 'POST',
      path: '/api/public/waitlist/status',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.deepEqual(JSON.parse(res.text).on_list, false);
  });
});

test('the public waitlist reads carry it too', async () => {
  await withServer(async (server) => {
    const res = await request(server, {
      method: 'GET',
      path: '/api/public/waitlist/options',
      headers: { Origin: ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });
});

test('no credentials, and the origin is never echoed', async () => {
  await withServer(async (server) => {
    for (const method of ['OPTIONS', 'GET']) {
      const res = await request(server, {
        method,
        path: '/api/public/waitlist/options',
        headers: { Origin: ORIGIN, Cookie: 'sv_session=whatever' },
      });
      // A wildcard origin is what makes "no cookies here" structural: the
      // browser refuses to pair it with credentials at all.
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.notEqual(res.headers['access-control-allow-origin'], ORIGIN);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
      // No echoed origin means no per-origin response to keep apart, so no
      // cache in front of the platform needs to Vary on it.
      assert.equal(res.headers.vary, undefined);
    }
  });
});

test('the integrator key header is not reachable from a browser', async () => {
  // The shared secret in src/services/waitlist-integrator.js re-keys the join
  // endpoint's rate-limit budget for a server-to-server caller. Leaving it
  // out of the allowlist is what keeps every browser signup on the ordinary
  // per-IP budget, and keeps a careless page from shipping the secret.
  assert.doesNotMatch(ALLOWED_HEADERS, /waitlist-client-key/i);
  assert.doesNotMatch(ALLOWED_HEADERS, /authorization/i);
  assert.doesNotMatch(ALLOWED_HEADERS, /cookie/i);
});

test('nothing outside /api/public/ is touched', async () => {
  await withServer(async (server) => {
    const get = await request(server, {
      method: 'GET',
      path: '/api/apps',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(get.status, 200);
    assert.equal(get.headers['access-control-allow-origin'], undefined);
    assert.equal(get.headers['access-control-allow-methods'], undefined);

    // And the preflight is NOT swallowed: it has to reach whatever the
    // platform would otherwise do with it, rather than being told 204 by a
    // middleware that has no business answering for that route.
    const preflight = await request(server, {
      method: 'OPTIONS',
      path: '/api/apps',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.notEqual(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  });
});

test('server.js mounts it scoped, ahead of the auth middleware', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  const corsAt = SRC.indexOf('app.use(publicApiCors())');
  const authAt = SRC.indexOf('app.use(authMiddleware(config))');
  assert.ok(corsAt > 0, 'server.js must mount publicApiCors()');
  assert.ok(authAt > 0);
  // A preflight must not depend on a cookie, a bearer, a body parser or a
  // route, so the middleware goes ahead of all of them.
  assert.ok(corsAt < authAt, 'publicApiCors() must mount before authMiddleware');

  // The prefix check lives inside the middleware; server.js must not widen
  // it by mounting the handler on a different path.
  assert.match(SRC.slice(corsAt, corsAt + 40), /^app\.use\(publicApiCors\(\)\);/);

  // And the entry point writes no CORS header of its own: every one on the
  // platform comes from the one path-scoped middleware above. (Prose
  // mentioning the header is fine; a res.setHeader call here is not.)
  const strays = SRC.match(/res\.(?:set|setHeader|header)\(\s*['"`]Access-Control/gi) || [];
  assert.deepEqual(strays, []);
});
