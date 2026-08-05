// Backward/forward compatibility of the app-side token verifier across the
// RSA iframe cutover.
//
// There are ~40 app containers in production running scaffolds generated
// before the cutover. Their auth middleware is two lines long:
//
//     const JWT_SECRET = process.env.JWT_SECRET;
//     try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
//
// We cannot edit their source. The cutover therefore keeps injecting
// JWT_SECRET into every container — but with the RSA PUBLIC PEM as its
// value instead of the old shared HMAC secret (services/app-identity-env.js).
// `jwt.verify(token, pem)` verifies an RS256 token asymmetrically, so those
// apps keep authenticating users verbatim while losing the ability to mint
// an identity at all. That shim is load-bearing and completely invisible in
// the platform's own code paths, so it gets its own suite.
//
// Three things are pinned here, all by EXECUTING the middleware rather than
// grepping for it:
//
//   1. The frozen legacy middleware (verbatim from src/services/template.js
//      at 92714af, the commit before the cutover) accepts a real
//      platform-minted RS256 token when JWT_SECRET holds the public PEM.
//
//   2. The same legacy middleware REJECTS an HS256 token forged with that
//      public PEM as the HMAC secret. Every container knows the PEM, so if
//      this direction ever flipped, any app could forge any user for any
//      legacy app. It holds because jsonwebtoken infers the algorithm
//      family from the key material (a PEM ⇒ RSA family) even with no
//      explicit `algorithms` option — which is exactly the kind of library
//      behavior that must be pinned by a test rather than assumed.
//
//   3. The CURRENT scaffold, rendered live from getTemplateFiles(), pins
//      algorithm/issuer/audience/pur explicitly and rejects a token minted
//      for a DIFFERENT app — the cross-app replay the audience exists to
//      stop.
//
// Known and accepted limitation, stated here because a reader will
// otherwise assume the shim is complete: the legacy middleware checks no
// audience, so a legacy app still accepts a token minted for another app.
// It cannot be fixed without editing app source. What it does NOT expose is
// the platform's own surfaces — the LLM proxy, app storage, app files, the
// edge gate and the staging handshake all verify with an explicit appId
// (see tests/app-llm-proxy-auth.test.js and friends), so a replayed token
// buys nothing but that one legacy app's own routes. Regenerated or
// hand-updated apps get the full check.
//
// Run with: node --test tests/scaffold-token-compat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');
const { getTemplateFiles } = require('../src/services/template.js');
const { appIdentityEnv, normalizePem } = require('../src/services/app-identity-env');

const APP_ID = 7;
const OTHER_APP_ID = 8;
const PUBLIC_PEM = normalizePem(keys.IFRAME_JWT_PUBLIC_KEY);

// ── Sandbox: run a generated server.js and capture its auth middleware ──
//
// The scaffold is a whole express app that opens a pg Pool and listens on
// load, so express/pg are stubbed and the real jsonwebtoken is kept — the
// verification behavior is the entire point.
function loadScaffoldMiddleware(source, env) {
  const middlewares = [];
  const app = {
    use: (...args) => {
      const fn = args[args.length - 1];
      // express.json() is stubbed to a non-function marker; only real
      // (req, res, next) handlers are collected.
      if (typeof fn === 'function' && fn.length >= 3) middlewares.push(fn);
    },
    get: () => {},
    post: () => {},
    listen: (_port, cb) => { if (typeof cb === 'function') cb(); },
  };
  const express = () => app;
  express.json = () => '__json__';
  express.static = () => '__static__';

  const fakeRequire = (id) => {
    if (id === 'express') return express;
    if (id === 'path') return require('path');
    if (id === 'jsonwebtoken') return jwt;
    if (id === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
    throw new Error(`scaffold sandbox: unexpected require(${id})`);
  };
  const fakeProcess = { env, exit: () => {}, cwd: () => process.cwd(), on: () => {} };

  // eslint-disable-next-line no-new-func
  new Function('require', 'process', '__dirname', 'console', source)(
    fakeRequire, fakeProcess, __dirname, { log: () => {}, error: () => {} }
  );

  assert.equal(middlewares.length, 1,
    'expected exactly one (req, res, next) middleware — the auth one');
  return middlewares[0];
}

// Run the middleware and report whether it authenticated anyone.
function authenticate(mw, token) {
  const req = { query: token === undefined ? {} : { token }, headers: {}, method: 'GET', path: '/' };
  let status = null;
  const res = {
    status: (s) => { status = s; return res; },
    json: () => res,
    send: () => res,
    redirect: () => res,
    sendFile: () => res,
    type: () => res,
  };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { user: req.user || null, status, nexted };
}

// ── The frozen legacy scaffold ──────────────────────────────────────────
//
// Verbatim from `git show 92714af:src/services/template.js` — the last
// generated shape before the cutover. Deliberately a frozen literal and not
// a render of the current template: the whole question is what the code
// ALREADY DEPLOYED does, and that code can never change.
const LEGACY_SERVER = `
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});
`;

// The env a legacy container actually receives after the cutover.
const LEGACY_ENV = { PORT: '3000', DATABASE_URL: 'postgres://x', ...appIdentityEnv({ id: APP_ID }, { iframeJwtPublicKey: keys.IFRAME_JWT_PUBLIC_KEY }) };

function legacyMiddleware(env = LEGACY_ENV) {
  return loadScaffoldMiddleware(LEGACY_SERVER, env);
}

// ── 1. Legacy scaffold + the JWT_SECRET shim accepts RS256 ──────────────

test('the shim really does hand the legacy scaffold the public PEM under JWT_SECRET', () => {
  assert.equal(LEGACY_ENV.JWT_SECRET, PUBLIC_PEM);
  assert.match(LEGACY_ENV.JWT_SECRET, /^-----BEGIN PUBLIC KEY-----\n/,
    'real newlines, not \\n escapes — the legacy scaffold does no normalization');
});

test('legacy scaffold verbatim accepts a platform-minted RS256 token', () => {
  const mw = legacyMiddleware();
  const token = platformJwt.signAppIdentityToken({
    appId: APP_ID,
    user: { id: 42, username: 'alice', usernode_pubkey: null, locale: null },
  });
  const { user, nexted } = authenticate(mw, token);
  assert.equal(nexted, true);
  assert.ok(user, 'the pre-cutover two-liner must still authenticate');
  assert.equal(user.id, 42);
  assert.equal(user.username, 'alice');
  // The claims a legacy app reads are unchanged in name and shape.
  assert.ok('usernode_pubkey' in user);
  assert.ok('locale' in user);
  assert.equal(user.pur, 'iframe');
});

test('legacy scaffold still 401s an API call with no token', () => {
  const mw = legacyMiddleware();
  const req = { query: {}, headers: {}, method: 'GET', path: '/api/data' };
  let status = null;
  const res = { status: (s) => { status = s; return res; }, json: () => res };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(status, 401);
  assert.equal(nexted, false);
});

// ── 2. The HS256-forged-with-the-public-PEM attack ──────────────────────

test('legacy scaffold rejects an HS256 token forged with the public PEM', () => {
  const mw = legacyMiddleware();
  // Every app container holds this PEM. Signing with it as an HMAC secret
  // is trivial for any of them.
  const forged = jwt.sign(
    { id: 1, username: 'admin', pur: 'iframe' },
    PUBLIC_PEM,
    { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '1h' }
  );
  const { user } = authenticate(mw, forged);
  assert.equal(user, null, 'an HS256 forgery must not authenticate anyone');
});

// Pins the library behavior the assertion above depends on, so an upgrade
// that changed jsonwebtoken's key-family inference fails HERE with an
// unmistakable message rather than silently reopening the forgery.
test('jsonwebtoken infers the RSA family from a PEM key even with no algorithms option', () => {
  const forged = jwt.sign({ id: 1 }, PUBLIC_PEM, { algorithm: 'HS256' });
  assert.throws(() => jwt.verify(forged, PUBLIC_PEM), /invalid algorithm/,
    'jwt.verify(token, <PEM>) must refuse HS256 without being told to');
  const real = platformJwt.signAppIdentityToken({ appId: APP_ID, user: { id: 5 } });
  assert.doesNotThrow(() => jwt.verify(real, PUBLIC_PEM));
});

// The other half of the asymmetry: a container that tries to SIGN with what
// it was given cannot produce anything the platform will accept.
test('a container cannot mint a platform-acceptable token from the public PEM', () => {
  // RS256 with a public key: crypto refuses outright.
  assert.throws(() => jwt.sign({ id: 1, pur: 'iframe' }, PUBLIC_PEM, {
    algorithm: 'RS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`,
  }));
  // HS256 with the PEM as a secret: signs fine, verifies nowhere that
  // matters, because the platform pins RS256.
  const forged = jwt.sign(
    { id: 1, pur: 'iframe' }, PUBLIC_PEM,
    { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '1h' }
  );
  assert.throws(() => platformJwt.verifyAppIdentityToken(forged, { appId: APP_ID }),
    /invalid algorithm/);
});

// ── 3. The updated scaffold ─────────────────────────────────────────────

function currentScaffoldSource() {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x');
  return files.find((f) => f.path === 'server.js').content;
}

function currentEnv(appId = APP_ID) {
  return {
    PORT: '3000',
    DATABASE_URL: 'postgres://x',
    ...appIdentityEnv({ id: appId }, { iframeJwtPublicKey: keys.IFRAME_JWT_PUBLIC_KEY }),
  };
}

// This case used to assert the OPPOSITE — that the generated scaffold keeps
// `|| process.env.JWT_SECRET` as a fallback, for "an app cloned from the new
// template but deployed by an older platform". That fallback has been dropped,
// and the rationale for it does not survive inspection:
//
//   - template.js and app-identity-env.js ship in the SAME image, so within
//     one platform instance a new-template app is always deployed by a
//     platform that injects USERNODE_JWT_PUBLIC_KEY.
//   - The only way a new-template app meets an old platform is a ROLLBACK
//     (scripts/rollback.sh) to a pre-cutover build. There the fallback buys
//     nothing: that platform mints bare HS256, and the current scaffold pins
//     `algorithms: ['RS256']`, so the token is refused on ALGORITHM no matter
//     which env var supplied the key. Asserted below rather than argued.
//
// So the fallback protected nothing while teaching every newly generated app
// to depend on a name we are trying to retire. The alias itself is still
// INJECTED for pre-cutover apps (see the removal criterion in
// services/app-identity-env.js) — that is what the rest of this suite covers.
test('the current scaffold reads only USERNODE_JWT_PUBLIC_KEY', () => {
  const src = currentScaffoldSource();
  assert.match(src, /process\.env\.USERNODE_JWT_PUBLIC_KEY/);
  assert.ok(!/process\.env\.JWT_SECRET/.test(src),
    'a newly generated app must not acquire a dependency on the retired alias');
});

test('a new-template app with only JWT_SECRET set fails closed', () => {
  // The rollback scenario, both halves. First: the key is simply not found.
  const env = currentEnv();
  delete env.USERNODE_JWT_PUBLIC_KEY;
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), env);
  const token = platformJwt.signAppIdentityToken({ appId: APP_ID, user: { id: 42 } });
  assert.equal(authenticate(mw, token).user, null,
    'no verification key means no user — fail closed, never a bare pass');
});

test('the dropped fallback could not have rescued a rollback anyway', () => {
  // Second half: even WITH the old shared secret in JWT_SECRET, a
  // pre-cutover platform's bare-HS256 token is refused on algorithm by the
  // current scaffold. That is why removing the fallback costs nothing.
  const env = currentEnv();
  delete env.USERNODE_JWT_PUBLIC_KEY;
  env.JWT_SECRET = 'legacy-shared-secret-0123456789abcdef';
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), env);
  const legacyToken = jwt.sign({ id: 42, username: 'alice' }, env.JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
  assert.equal(authenticate(mw, legacyToken).user, null,
    'HS256 is refused by the RS256 pin regardless of where the key came from');
});

test('the current scaffold accepts a token minted for ITS app', () => {
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), currentEnv());
  const token = platformJwt.signAppIdentityToken({
    appId: APP_ID, user: { id: 42, username: 'alice' },
  });
  const { user } = authenticate(mw, token);
  assert.ok(user);
  assert.equal(user.id, 42);
  assert.equal(user.aud, `usernode:app:${APP_ID}`);
});

test('the current scaffold rejects a token minted for a DIFFERENT app', () => {
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), currentEnv(APP_ID));
  const token = platformJwt.signAppIdentityToken({
    appId: OTHER_APP_ID, user: { id: 42, username: 'alice' },
  });
  assert.equal(authenticate(mw, token).user, null,
    'cross-app replay must fail on audience');
});

test('the current scaffold rejects an HS256 forgery for its own audience', () => {
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), currentEnv());
  const forged = jwt.sign(
    { id: 1, username: 'admin', pur: 'iframe' }, PUBLIC_PEM,
    { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '1h' }
  );
  assert.equal(authenticate(mw, forged).user, null);
});

test('the current scaffold rejects a non-iframe purpose and a foreign issuer', () => {
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), currentEnv());
  // Right key, right audience, wrong purpose: a capture/worker-shaped
  // token must not authenticate a person.
  const wrongPur = jwt.sign(
    { id: 42, pur: 'worker' }, keys.IFRAME_JWT_PRIVATE_KEY,
    { algorithm: 'RS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '1h' }
  );
  assert.equal(authenticate(mw, wrongPur).user, null, 'pur must be re-checked');

  const wrongIss = jwt.sign(
    { id: 42, pur: 'iframe' }, keys.IFRAME_JWT_PRIVATE_KEY,
    { algorithm: 'RS256', issuer: 'not-usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '1h' }
  );
  assert.equal(authenticate(mw, wrongIss).user, null);
});

test('the current scaffold authenticates nobody when USERNODE_APP_ID is missing', () => {
  // No app id ⇒ no audience to expect ⇒ fail closed, rather than fall back
  // to an unaudienced verify that would accept any app's token.
  const env = currentEnv();
  delete env.USERNODE_APP_ID;
  const mw = loadScaffoldMiddleware(currentScaffoldSource(), env);
  const token = platformJwt.signAppIdentityToken({ appId: APP_ID, user: { id: 42 } });
  assert.equal(authenticate(mw, token).user, null);
});
