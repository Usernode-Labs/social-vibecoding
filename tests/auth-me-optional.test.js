'use strict';

// GET /api/auth/me answers "nobody is signed in" as a 200 with no-store when
// it is asked optionally (#5678). The boot of a device with no saved session
// asks that way, so a signed-out page load no longer logs a failed request
// in the console. Every other caller keeps the 401, and a signed-in session
// is answered exactly as before either way.
//
// This checkout installs no server dependencies, so the route is pinned as
// source: the branch, its query, its body and its cache header, in the
// handler and nowhere else.
//
// Run with: node --test tests/auth-me-optional.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUTH = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');

test('a signed-out read is refused plainly, and answered "nobody" when optional', () => {
  const at = AUTH.indexOf("router.get('/api/auth/me'");
  assert.ok(at > -1, 'the route is there');
  const handler = AUTH.slice(at, AUTH.indexOf('res.json(', at + 1200) + 40);
  assert.match(handler, /if \(!req\.user\) \{/, 'the no-session branch');
  const branch = handler.slice(handler.indexOf('if (!req.user) {'), handler.indexOf('return res.status(401)'));
  assert.match(branch, /if \(req\.query\.optional === '1'\) \{/, 'only the exact value asks that way');
  assert.match(branch, /res\.set\('Cache-Control', 'no-store'\)/, 'a "nobody" answer is never cached');
  assert.match(branch, /return res\.json\(\{ user: null \}\)/, 'and it is a 200, not an error');
  // Every other caller still gets the 401.
  assert.match(handler, /return res\.status\(401\)\.json\(\{ error: 'Not authenticated' \}\)/);
});
