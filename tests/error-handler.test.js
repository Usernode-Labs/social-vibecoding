'use strict';

// #2508: two independent problems that combined into one leak.
//
//   1. The platform had NO express error-handling middleware. Anything
//      thrown out of a route reached express's own DEFAULT handler.
//   2. The production image never set `NODE_ENV`. `Dockerfile` declared only
//      `ENV GIT_SHA`.
//
// Express's default handler puts `err.stack` IN THE RESPONSE BODY unless
// `NODE_ENV` is exactly 'production'. So in production — absolute source
// paths, the internal module layout, the shape of the failing query — one
// unhandled throw away from any client.
//
// Both halves are fixed, and deliberately do not depend on each other: the
// Dockerfile sets NODE_ENV=production, AND the new handler answers every
// error itself without ever consulting NODE_ENV. The env var is one line in
// a build file that a future edit can drop silently; a handler whose safety
// rested on it would be right back here. This file asserts BOTH, and asserts
// the handler's safety with NODE_ENV explicitly set to 'development'.
//
// Run with: node --test tests/error-handler.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { errorHandler, clientStatusFor, clientMessageFor } = require('../src/middleware/error-handler');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// A distinctive string that only ever appears in a stack trace, so an
// assertion about leakage cannot pass by accident.
const SECRET_FRAME = 'definitelyNotAPublicFunctionName';

function buildApp({ withHandler }) {
  const app = express();
  app.use(express.json({ limit: '1kb' }));

  app.get('/throws', () => {
    function definitelyNotAPublicFunctionName() {
      throw new Error('connection to postgres://user:hunter2@db:5432 failed');
    }
    definitelyNotAPublicFunctionName();
  });
  app.post('/body', (req, res) => res.json({ ok: true, got: req.body }));
  app.get('/streaming', (req, res) => {
    res.write('partial');
    throw new Error('failed mid-stream');
  });
  app.get('/fine', (_req, res) => res.json({ ok: true }));

  if (withHandler) app.use(errorHandler);
  return app;
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(server, p, init) {
  const { port } = server.address();
  const resp = await fetch(`http://127.0.0.1:${port}${p}`, init);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: resp.status, text, json };
}

// Both suites run with NODE_ENV explicitly NOT 'production' — that is the
// condition under which express's default handler leaks, and the condition
// the production image was actually running in.
const priorEnv = process.env.NODE_ENV;
test.before(() => { process.env.NODE_ENV = 'development'; });
test.after(() => {
  if (priorEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorEnv;
});

// ── What the default handler does, so the fix has something to be better than

test('WITHOUT the handler, express leaks the stack trace — the bug', async () => {
  const server = await listen(buildApp({ withHandler: false }));
  try {
    const res = await request(server, '/throws');
    assert.equal(res.status, 500);
    assert.match(res.text, /definitelyNotAPublicFunctionName/,
      'express default handler writes err.stack into the body');
    assert.match(res.text, /hunter2/, 'and the message with it');
  } finally { server.close(); }
});

// ── What the handler does instead ──────────────────────────────────────

test('a thrown error answers terse JSON, with no stack and no message', async () => {
  const server = await listen(buildApp({ withHandler: true }));
  try {
    const res = await request(server, '/throws');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'Internal server error' });
    assert.doesNotMatch(res.text, /definitelyNotAPublicFunctionName/, 'no stack frames');
    assert.doesNotMatch(res.text, /hunter2/, 'no error message — it can carry a secret');
    assert.doesNotMatch(res.text, /at /, 'nothing stack-shaped at all');
  } finally { server.close(); }
});

// THE KNOWN BOUNDARY, stated rather than papered over.
//
// Express 4 (4.22.2 here) does NOT forward a rejected promise from an async
// handler to the error middleware: `Route.dispatch` ignores the handler's
// return value, so the rejection becomes an unhandled promise rejection and
// the request never gets an answer. Express 5 changed this; this repo is on 4.
//
// That is PRE-EXISTING, and this change neither causes nor worsens it — with
// no error handler at all, the same request hung in exactly the same way. It
// is also not what #2508 is about: the leak being fixed is express's DEFAULT
// handler writing `err.stack` into a response, which only happens on the
// paths that do reach it.
//
// What covers the async routes today is that they write their own try/catch,
// the prevailing style across src/routes/. The two assertions below pin the
// facts this reasoning rests on, so that an express 5 upgrade — or an erosion
// of that style — surfaces here rather than silently.
//
// (This is asserted statically rather than by firing a rejecting route: an
// unhandled rejection terminates the test process, which is precisely the
// behaviour being described.)
test('express is still v4, where async rejections do not reach the handler', () => {
  assert.match(require('express/package.json').version, /^4\./,
    'on express 5 async rejections DO reach the error handler — revisit this file');
});

test('async routes still carry their own try/catch', () => {
  // A representative, heavily-trafficked router. Not a count to chase: the
  // point is that the style has not been abandoned wholesale, because the
  // error handler cannot stand in for it on express 4.
  const src = read('src/routes/apps.js');
  const asyncRoutes = (src.match(/async \(req, res\) =>/g) || []).length;
  const tryBlocks = (src.match(/\n\s*try \{/g) || []).length;
  assert.ok(asyncRoutes > 0, 'expected async routes in apps.js');
  assert.ok(tryBlocks >= asyncRoutes / 2,
    `only ${tryBlocks} try blocks for ${asyncRoutes} async routes — async errors would hang`);
});

// The handler must not consult NODE_ENV. This is the assertion that keeps
// the two halves of the fix independent.
test('the body is identical whatever NODE_ENV says', async () => {
  const bodies = [];
  for (const env of ['development', 'production', 'staging', undefined]) {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    const server = await listen(buildApp({ withHandler: true }));
    try {
      bodies.push((await request(server, '/throws')).text);
    } finally { server.close(); }
  }
  process.env.NODE_ENV = 'development';
  assert.equal(new Set(bodies).size, 1,
    `the handler must not read NODE_ENV, got ${JSON.stringify(bodies)}`);
});

// ── Client errors are still the client's ───────────────────────────────

test('malformed JSON is still a 400, with a fixed message', async () => {
  const server = await listen(buildApp({ withHandler: true }));
  try {
    const res = await request(server, '/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken":',
    });
    assert.equal(res.status, 400, 'the caller caused this and the status says so');
    assert.deepEqual(res.json, { error: 'Malformed request' });
    assert.doesNotMatch(res.text, /at .*\.js:/, 'no stack');
  } finally { server.close(); }
});

// Found by Codex. Node 22's JSON parser quotes the offending input back in
// its message, so forwarding a 4xx message reflects the caller's own body —
// including anything secret in it — into the response and into the
// operator-visible log ring.
test('a secret in a malformed body is never echoed back', async () => {
  // Node quotes only the first ~19 characters of the body back, so the
  // secret has to sit near the front to be inside that window — which is
  // exactly where a `{"token":...}` body puts it.
  const SECRET = 'sk-live-0f3a';
  const bad = `{"t":${SECRET}}`;
  // The premise, first: Node really does put it in the message.
  let parserMessage = '';
  try { JSON.parse(bad); } catch (e) { parserMessage = e.message; }
  assert.match(parserMessage, new RegExp(SECRET),
    `if Node stops quoting the input this test is no longer the right guard `
    + `(got ${JSON.stringify(parserMessage)})`);

  const server = await listen(buildApp({ withHandler: true }));
  try {
    const res = await request(server, '/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bad,
    });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.text, new RegExp(SECRET),
      "the caller's own secret must not come back in the response");
    assert.deepEqual(res.json, { error: 'Malformed request' });
  } finally { server.close(); }
});

test('clientMessageFor is a fixed phrase per family, never the error text', () => {
  assert.equal(clientMessageFor(400), 'Malformed request');
  assert.equal(clientMessageFor(413), 'Request body too large');
  assert.equal(clientMessageFor(415), 'Unsupported content type');
  assert.equal(clientMessageFor(499), 'Bad request', 'anything unlisted falls back');
  for (const status of [400, 413, 415, 422, 499]) {
    assert.equal(typeof clientMessageFor(status), 'string');
  }
});

test('a body over the limit is still a 413', async () => {
  const server = await listen(buildApp({ withHandler: true }));
  try {
    const res = await request(server, '/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4096) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(res.json, { error: 'Request body too large' });
  } finally { server.close(); }
});

test('clientStatusFor only forwards the 4xx family', () => {
  assert.equal(clientStatusFor({ status: 400 }), 400);
  assert.equal(clientStatusFor({ statusCode: 413 }), 413);
  assert.equal(clientStatusFor({ status: 499 }), 499);
  assert.equal(clientStatusFor({ status: 500 }), null, 'a 5xx is ours, not theirs');
  assert.equal(clientStatusFor({ status: 503 }), null);
  assert.equal(clientStatusFor({ status: 302 }), null);
  assert.equal(clientStatusFor({}), null);
  assert.equal(clientStatusFor(null), null);
  assert.equal(clientStatusFor({ status: 'nope' }), null);
});

// ── It must not break the ordinary paths ───────────────────────────────

test('a route that works is untouched', async () => {
  const server = await listen(buildApp({ withHandler: true }));
  try {
    const res = await request(server, '/fine');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  } finally { server.close(); }
});

test('an error after the response started does not corrupt it', async () => {
  const server = await listen(buildApp({ withHandler: true }));
  try {
    await assert.rejects(() => request(server, '/streaming'),
      'the connection is destroyed rather than a second body appended');
  } finally { server.close(); }
});

// ── The wiring, pinned ─────────────────────────────────────────────────

test('server.js mounts the handler, and mounts it LAST', () => {
  const src = read('server.js');
  assert.match(src, /app\.use\(errorHandler\);/, 'the handler must be mounted');

  // Express selects the error handler by ARRIVAL ORDER: only middleware
  // mounted after a route can catch that route's errors. Anything registered
  // below it is outside its reach, so nothing may be.
  const mountIndex = src.indexOf('app.use(errorHandler);');
  const after = src.slice(mountIndex + 'app.use(errorHandler);'.length);
  const laterRoute = /^app\.(use|get|post|put|patch|delete|all)\(/m.exec(after);
  assert.equal(laterRoute, null,
    `a route is registered after the error handler (${laterRoute?.[0]}) — it can never catch it`);
});

test('the production images set NODE_ENV=production', () => {
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes']) {
    assert.match(read(file), /^ENV NODE_ENV=production$/m,
      `${file} must set NODE_ENV, or express's default handler leaks stacks`);
  }
});

// `npm ci` reads NODE_ENV and treats 'production' as --omit=dev, so setting
// it before the build stages install would strip the dependencies the shell
// and Tailwind builds need. It has to come after them.
test('NODE_ENV is set after every npm ci, not before', () => {
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes']) {
    const src = read(file);
    const envAt = src.search(/^ENV NODE_ENV=production$/m);
    const lastCi = src.lastIndexOf('npm ci');
    assert.ok(envAt > lastCi,
      `${file}: ENV NODE_ENV=production must come after the last npm ci`);
  }
});

// The local dev stack builds from the same Dockerfile but serves plain HTTP,
// and SECURE_COOKIE is `NODE_ENV === 'production'` — inheriting it there
// would mark the session cookie Secure and the browser would silently drop
// it, breaking local sign-in with no error anywhere.
test('the local dev stack overrides NODE_ENV back to development', () => {
  const src = read('docker-compose.dev.yml');
  assert.match(src, /^\s+NODE_ENV: development$/m,
    'docker-compose.dev.yml serves http://localhost:3000 and must not inherit production');
});

test('SECURE_COOKIE is still what keys the cookie off NODE_ENV', () => {
  // If this moves, the docker-compose.dev.yml override above stops being
  // the reason it is there, and the comment there goes stale.
  assert.match(read('src/middleware/auth.js'),
    /const SECURE_COOKIE = process\.env\.NODE_ENV === 'production';/);
});
