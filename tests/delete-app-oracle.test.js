'use strict';

// #2523: DELETE /api/apps/:slug answered questions about apps the caller
// cannot see.
//
// It loaded the row with a bare `SELECT * FROM apps WHERE slug = $1` and no
// access check at all, then branched BEFORE any visibility was considered:
//
//   404                        the slug does not exist
//   403 reason: 'core'         it exists AND is a core platform app
//   403 reason: 'not_owner'    it exists and you are not its creator
//
// So any signed-in account could probe a slug and learn whether a PRIVATE
// app existed, and whether it was core — neither of which it is entitled to
// know. A destructive verb is a poor oracle to leave open, because nothing
// about the request looks like reconnaissance.
//
// The fix is the wall every other app-scoped route already stands behind:
// `appAccess.getAppForUser(..., 'view')`, which returns null both for a slug
// that does not exist AND for one the caller cannot see, so the two are
// answered identically.
//
// 'view' and not 'collab' on purpose. The leak is about apps you cannot SEE;
// once you can see an app, that it is core, or that you did not create it,
// is not a secret — and a 404 there would be a lie about a row on screen.
// Admins are unaffected: checkAppAccess short-circuits on isAdmin. A
// VIEW-ONLY admin still passes the wall and is still refused by the
// canAdminWrite eligibility check below it, which is the behaviour it had.
//
// Run with: node --test tests/delete-app-oracle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src/routes/apps.js'), 'utf8'
);

/** The DELETE route's body, with comments stripped.
 *
 *  Stripped because the fix's own comment QUOTES the query it replaced, and
 *  a bare text search then finds the very string it is asserting is gone.
 *  These assertions are about code. */
function deleteRoute() {
  const at = SRC.indexOf("router.delete('/api/apps/:slug'");
  assert.notEqual(at, -1, 'the route should still exist');
  const next = SRC.indexOf("\n  router.", at + 10);
  const body = SRC.slice(at, next === -1 ? SRC.length : next);
  return body.replace(/^\s*\/\/.*$/gm, '');
}

test('the row is resolved through the access wall, not a bare slug lookup', () => {
  const body = deleteRoute();
  assert.match(body, /appAccess\.getAppForUser\(\s*pool,\s*req\.params\.slug,\s*req\.user,\s*'view'/,
    'a caller who cannot see the app must not get past this');
  assert.doesNotMatch(body, /SELECT \* FROM apps WHERE slug = \$1/,
    'the unguarded lookup is what made this an oracle');
});

test('a hidden app and a missing one answer identically', () => {
  const body = deleteRoute();
  // getAppForUser returns null for BOTH, and the single 404 below is the
  // only thing either can produce.
  const notFound = body.match(/if \(!app\) return res\.status\(404\)\.json\(\{ error: 'App not found' \}\);/);
  assert.ok(notFound, 'one 404, reached by both');
});

test('the core and not_owner answers are still reachable — behind the wall', () => {
  const body = deleteRoute();
  // Closing the oracle must not flatten the real errors for someone who can
  // see the app; they are what tell an owner why the button did nothing.
  assert.match(body, /reason: 'core'/);
  assert.match(body, /reason: 'not_owner'/);
  const wall = body.indexOf('getAppForUser');
  assert.ok(wall > -1 && wall < body.indexOf("reason: 'core'"),
    'the wall comes first');
  assert.ok(wall < body.indexOf("reason: 'not_owner'"),
    'for both of them');
});

test('admins are unaffected, including the view-only distinction', () => {
  const access = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/app-access.js'), 'utf8'
  );
  assert.match(access, /if \(user\?\.isAdmin\) return true;/,
    'an admin passes the wall on any app');
  // And the delete eligibility below the wall still asks for WRITE, so a
  // view-only admin sees the app and is still refused the deletion.
  assert.match(deleteRoute(), /req\.user\?\.canAdminWrite/);
});
