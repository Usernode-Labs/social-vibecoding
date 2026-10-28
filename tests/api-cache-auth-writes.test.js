'use strict';

// Every write under /api/auth/ is either a session boundary or one that keeps
// the session (AUTH_WRITES_KEEPING_SESSION, frontend/src/lib/api-cache-
// identity.ts). The browser's session guard fences the reads on their way
// and reloads the other tabs on a boundary, so a write in the wrong list
// either reloads every tab for nothing (adding a phone did, 28 Oct 2026) or
// lets an old account's replies through a sign-in. This reads the server's
// routes and fails until a new one is put in one list or the other.
//
// Run with: node --test tests/api-cache-auth-writes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { AUTH_WRITES_KEEPING_SESSION, authWriteKeepsSession } = loadTsx('frontend/src/lib/api-cache-identity.ts');

// The routes that start a session: the server's own list (src/routes/auth.js).
function sessionMintPaths() {
  const block = /const SESSION_MINT_PATHS = \[([\s\S]*?)\];/.exec(read('src/routes/auth.js'));
  assert.ok(block, 'src/routes/auth.js still names SESSION_MINT_PATHS');
  return [...block[1].matchAll(/'(\/api\/auth\/[^']+)'/g)].map((m) => m[1]);
}

// The other boundaries: a session ended, or an identity proved outside fetch.
const ENDS_OR_REPLACES_SESSION = [
  '/api/auth/logout', // clears the session cookie
  '/api/auth/account', // DELETE: the account and its sessions go
  '/api/auth/password-reset/confirm', // account recovery can end sessions
  '/api/auth/oauth/apple/callback', // Apple's form post, a navigation, not a fetch
];

function serverAuthWrites() {
  const dir = path.join(ROOT, 'src', 'routes');
  const routes = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of source.matchAll(/\b(?:router|app)\.(?:post|put|patch|delete)\(\s*'(\/api\/auth\/[^']+)'/g)) routes.add(m[1]);
  }
  return [...routes].sort();
}

test('every write under /api/auth/ is classified: it keeps the session or it is a boundary', () => {
  const boundaries = new Set([...sessionMintPaths(), ...ENDS_OR_REPLACES_SESSION]);
  const keeps = new Set(AUTH_WRITES_KEEPING_SESSION);
  const routes = serverAuthWrites();
  assert.ok(routes.length >= 20, `found the auth routes (${routes.length})`);
  for (const route of routes) {
    assert.ok(keeps.has(route) !== boundaries.has(route),
      `${route}: add it to AUTH_WRITES_KEEPING_SESSION if it never writes or clears the session cookie, `
      + 'or to this test\'s boundaries (or the server\'s SESSION_MINT_PATHS) if it does');
  }
  for (const route of keeps) assert.ok(routes.includes(route), `${route} is listed as keeping the session but is not a route`);
});

test('a route that starts a session is never one that keeps it', () => {
  for (const route of sessionMintPaths()) assert.equal(authWriteKeepsSession(route.replace(':provider', 'google')), false, route);
  for (const route of ENDS_OR_REPLACES_SESSION) assert.equal(authWriteKeepsSession(route), false, route);
});

test('the list matches the paths a request names, parameters included and nothing more', () => {
  assert.equal(authWriteKeepsSession('/api/auth/phone-link/request'), true);
  assert.equal(authWriteKeepsSession('/api/auth/oauth/google/native/start'), true);
  assert.equal(authWriteKeepsSession('/api/auth/oauth/google/native'), false, 'the native sign-in itself is a boundary');
  assert.equal(authWriteKeepsSession('/api/auth/oauth/a/b/native/start'), false);
  assert.equal(authWriteKeepsSession('/api/auth/phone-link/request/extra'), false);
  assert.equal(authWriteKeepsSession('/api/auth/login'), false);
});
