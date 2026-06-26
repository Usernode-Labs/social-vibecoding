// #47 fix: the proposal-checks ASSERTION suite must run as a view-only
// admin so the admin-gated check routes (/admin, /dashboard) render under
// test, while the public before/after SCREENSHOTS keep signing as the
// non-admin capture user. Two layers, mirroring tests/dashboard-spend-
// distribution.test.js:
//   1. Behavioural — the pure token helpers in src/services/visuals.js
//      (mintCaptureToken / selectCaptureTokens) plus withToken, exercised
//      with a real jwt secret so the routing + fallback is verifiable.
//   2. Source guards — the read-only-admin capture identity seed contract
//      on src/db/migrate.js (idempotent, is_admin + admin_readonly), and
//      the visuals.js wiring that routes testsToken to the test URLs only.
//
// Run with: node --test tests/capture-admin-token.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const visuals = require('../src/services/visuals');
const { mintCaptureToken, selectCaptureTokens, withToken } = visuals;

const SECRET = 'test-jwt-secret';
const CAPTURE_USER = { id: 7, username: 'usernode-capture', usernode_pubkey: null };
const ADMIN_USER = { id: 8, username: 'usernode-capture-admin', usernode_pubkey: null };

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// Decode the `token=` query param out of a capture URL and verify it.
function tokenOf(url) {
  const m = /[?&]token=([^&#]+)/.exec(url);
  return m ? jwt.verify(decodeURIComponent(m[1]), SECRET) : null;
}

// ── 1. Behavioural: mintCaptureToken ────────────────────────────────────

test('mintCaptureToken returns "" for a missing user (degrade to unauth)', () => {
  assert.equal(mintCaptureToken(null, SECRET), '');
  assert.equal(mintCaptureToken(undefined, SECRET), '');
});

test('mintCaptureToken signs the iframe-token payload shape', () => {
  const tok = mintCaptureToken(ADMIN_USER, SECRET);
  assert.ok(tok);
  const decoded = jwt.verify(tok, SECRET);
  assert.equal(decoded.id, 8);
  assert.equal(decoded.username, 'usernode-capture-admin');
  assert.equal(decoded.usernode_pubkey, null);
});

// ── 1. Behavioural: selectCaptureTokens routing + fallback ──────────────

test('selectCaptureTokens: screenshots keep capture token, tests prefer admin token', () => {
  const captureToken = mintCaptureToken(CAPTURE_USER, SECRET);
  const adminToken = mintCaptureToken(ADMIN_USER, SECRET);
  const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken, adminToken });
  // Screenshots always sign as the non-admin capture user.
  assert.equal(screenshotToken, captureToken);
  assert.equal(tokenOf(withToken('http://staging:3000/', screenshotToken)).username, 'usernode-capture');
  // Tests sign as the view-only admin so admin routes render.
  assert.equal(testsToken, adminToken);
  assert.equal(tokenOf(withToken('http://staging:3000/admin', testsToken)).username, 'usernode-capture-admin');
  assert.notEqual(screenshotToken, testsToken);
});

test('selectCaptureTokens: missing admin identity falls tests back to capture token', () => {
  const captureToken = mintCaptureToken(CAPTURE_USER, SECRET);
  const adminToken = mintCaptureToken(null, SECRET); // ''
  const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken, adminToken });
  assert.equal(testsToken, captureToken);
  assert.equal(screenshotToken, captureToken);
  assert.equal(tokenOf(withToken('http://staging:3000/admin', testsToken)).username, 'usernode-capture');
});

test('selectCaptureTokens: both missing → tests + screenshots unauthenticated', () => {
  const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken: '', adminToken: '' });
  assert.equal(screenshotToken, '');
  assert.equal(testsToken, '');
  // withToken with an empty token leaves the URL unchanged (no ?token=).
  assert.equal(withToken('http://staging:3000/admin', testsToken), 'http://staging:3000/admin');
});

test('exports name both capture identities', () => {
  assert.equal(visuals.CAPTURE_USERNAME, 'usernode-capture');
  assert.equal(visuals.CAPTURE_ADMIN_USERNAME, 'usernode-capture-admin');
});

// ── 2. Source guards: migrate seed contract ─────────────────────────────

test('migrate.js seeds usernode-capture-admin as an idempotent view-only admin', () => {
  const src = read('src/db/migrate.js');
  // The seeder exists and is invoked in the boot migration sequence.
  assert.match(src, /async function seedCaptureAdminUser\(pool\)/);
  assert.match(src, /await seedCaptureAdminUser\(pool\)/);
  // Isolate the function body and pin its contract.
  const body = src.slice(src.indexOf('async function seedCaptureAdminUser'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.match(fn, /usernode-capture-admin/);
  // View-only admin: is_admin TRUE + admin_readonly TRUE.
  assert.match(fn, /is_admin,\s*admin_readonly,\s*can_create_apps/);
  assert.match(fn, /VALUES\s*\(\$1,\s*\$2,\s*TRUE,\s*TRUE,\s*FALSE\)/);
  // Idempotent: existence check + ON CONFLICT DO NOTHING.
  assert.match(fn, /ON CONFLICT \(username\) DO NOTHING/);
  assert.match(fn, /SELECT id FROM users WHERE username = \$1/);
});

// ── 2. Source guards: visuals.js routes testsToken to tests only ────────

test('visuals.js signs test URLs with testsToken and screenshots with screenshotToken', () => {
  const src = read('src/services/visuals.js');
  // The test-suite URL uses testsToken.
  assert.match(src, /url:\s*withToken\(`http:\/\/\$\{stagingName\}:3000\$\{visitPath\}`,\s*testsToken\)/);
  // The "after" screenshot keeps the non-admin screenshotToken.
  assert.match(src, /afterUrl\s*=\s*withToken\(`http:\/\/\$\{stagingName\}:3000\$\{visitPath\}`,\s*screenshotToken\)/);
  // testsToken is never wired into the screenshot TARGETS.
  assert.doesNotMatch(src, /beforeUrl\s*=\s*withToken\([^)]*testsToken\)/);
});
