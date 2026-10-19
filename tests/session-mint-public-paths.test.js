// Every route that signs somebody in is reachable WITHOUT a session.
//
// SESSION_MINT_PATHS (src/routes/auth.js) lists the credential exchanges that
// mint a session, and each of them is used from a signed-out page: a password,
// an email code, a phone code, a provider sign-in, a wallet, and the waitlist
// release mail's one-time sign-in link. The auth middleware
// (src/middleware/auth.js) answers any /api/ request it does not know with
// 401 unless its path is in PUBLIC_PATHS, and the two lists live in different
// files. #4594 added `/api/auth/release-link` to the first and not the
// second, so every signed-out visitor who tapped "Create my account" got 401
// and the sheet quietly fell back to emailing a code: the link never signed
// anybody in. The route's own tests mounted the router without the
// middleware, so nothing noticed.
//
// So this runs the REAL middleware, signed out, against every path the mint
// list names, and checks each one reaches the route behind it.
//
// Run with: node --test tests/session-mint-public-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const ROUTES = path.join(__dirname, '..', 'src/routes/auth.js');

// The bare string entries of SESSION_MINT_PATHS, one per line; comments
// inside the array are skipped because they are not a quoted line of their
// own.
function sessionMintPaths() {
  const src = fs.readFileSync(ROUTES, 'utf8');
  const block = /const SESSION_MINT_PATHS = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'SESSION_MINT_PATHS is still declared in src/routes/auth.js');
  const paths = [...block[1].matchAll(/^\s*'([^']+)',\s*$/gm)].map((m) => m[1]);
  assert.ok(paths.length >= 10, `read ${paths.length} mint paths; the parse has drifted`);
  return paths;
}

// The middleware, with a pool that fails loudly: a signed-out request must be
// decided without one.
function withServer(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => ({ query: async (sql) => { throw new Error(`unexpected query: ${sql}`); } }) },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const authModulePath = require.resolve('../src/middleware/auth');
  delete require.cache[authModulePath];
  const { authMiddleware } = require('../src/middleware/auth');
  const app = express();
  app.use(cookieParser());
  app.use(authMiddleware({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
  // Reaching this stand-in means the gate let the request through.
  app.use((_req, res) => res.json({ reached: true }));
  const server = app.listen(0);
  const restore = () => {
    server.close();
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[authModulePath];
  };
  return new Promise((resolve) => server.once('listening', resolve))
    .then(() => fn(`http://127.0.0.1:${server.address().port}`))
    .finally(restore);
}

const post = (base, route) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});

test('a signed-out visitor reaches every route that mints a session', async () => {
  const paths = sessionMintPaths();
  assert.ok(paths.includes('/api/auth/release-link'), 'the release link is a mint path (#4594)');
  await withServer(async (base) => {
    for (const route of paths) {
      const res = await post(base, route.replace(/:provider\b/, 'google'));
      assert.equal(res.status, 200, `${route} answered ${res.status} to a signed-out visitor`);
      assert.deepEqual(await res.json(), { reached: true }, `${route} reached its route`);
    }
  });
});

test('the gate is live: a signed-out visitor is still refused elsewhere', async () => {
  // Without this the test above would pass against a middleware that let
  // everything through.
  await withServer(async (base) => {
    const res = await post(base, '/api/apps');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Not authenticated' });
  });
});
