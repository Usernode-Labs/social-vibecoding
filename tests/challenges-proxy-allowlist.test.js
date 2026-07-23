// Pins the /challenges-api proxy allowlist in server.js (app-as-SV-chrome
// + profile-and-settings-to-web migrations). The proxy is a READ-ONLY
// passthrough to the leaderboard service's public endpoints; this test
// guards the two contracts that keep it safe to expose unauthenticated:
//
//   1. The allowlist is exactly the paths SV's challenges + profile
//      screens need — in particular the /me/* GETs backing #profile,
//      and never the participant-scoped /register surface.
//   2. The handler is GET-only and 404s everything off-allowlist.
//
// The handler lives inline in server.js (mounted before authMiddleware),
// so this follows the repo's source-pinning pattern (see
// tests/board-order.test.js) rather than booting the full server.
//
// Run with: node --test tests/challenges-proxy-allowlist.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(
  path.join(__dirname, '..', 'server.js'), 'utf8');

function extractAllowlist(src) {
  const m = src.match(
    /const CHALLENGES_ALLOWED_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'CHALLENGES_ALLOWED_PATHS set literal not found in server.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('allowlist is exactly the challenges + profile read endpoints', () => {
  const paths = extractAllowlist(serverSrc);
  assert.deepEqual(paths.sort(), [
    '/challenges',
    '/leaderboard',
    '/me/breakdown',
    '/me/ranking',
    '/seasons',
  ]);
});

test('profile /me/* endpoints are allowlisted', () => {
  const paths = new Set(extractAllowlist(serverSrc));
  assert.ok(paths.has('/me/ranking'), '/me/ranking must be proxied');
  assert.ok(paths.has('/me/breakdown'), '/me/breakdown must be proxied');
});

test('write-capable leaderboard surfaces are never proxied', () => {
  const paths = new Set(extractAllowlist(serverSrc));
  for (const forbidden of ['/register', '/me', '/wallet', '/admin']) {
    assert.ok(!paths.has(forbidden),
      `${forbidden} must not be reachable through /challenges-api`);
  }
});

test('handler gates on GET + allowlist membership', () => {
  const handler = serverSrc.match(
    /app\.use\('\/challenges-api',([\s\S]*?)\n\}\);/);
  assert.ok(handler, '/challenges-api handler not found in server.js');
  assert.match(handler[1],
    /req\.method !== 'GET' \|\| !CHALLENGES_ALLOWED_PATHS\.has\(/,
    'handler must reject non-GET and off-allowlist paths');
  assert.match(handler[1], /status\(404\)/,
    'off-allowlist requests must 404');
});
