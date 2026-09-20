'use strict';

// #2522: one activation code could mint several accounts.
//
// POST /api/auth/register did check-then-act across three unsynchronised
// statements:
//
//   SELECT id FROM activation_codes WHERE code = $1 AND used_by IS NULL
//   INSERT INTO users ...
//   UPDATE activation_codes SET used_by = $1 WHERE id = $2      -- no guard
//
// Nothing held the row between the read and the write, and the write did
// not re-assert the condition the read relied on. Two requests racing on one
// code both passed the SELECT, both created an account, and both wrote
// `used_by` — the second simply overwrote the first. The window is not
// theoretical either: `bcrypt.hash(password, 12)` sits inside it, which is
// deliberately ~100ms of work.
//
// Each of those extra accounts is a real one: grantPlatformAccess and an
// included OpenRouter key follow.
//
// The claim is now the UPDATE, carrying `AND used_by IS NULL`, inside a
// transaction with the user insert. The database picks the winner; the loser
// rolls back so it leaves no orphaned user behind.
//
// Run with: node --test tests/activation-code-atomic.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/routes/auth.js'), 'utf8');

/** The register route's body, comments stripped (they quote the old SQL). */
function registerRoute() {
  const at = SRC.indexOf("router.post('/api/auth/register'");
  assert.notEqual(at, -1);
  const next = SRC.indexOf('\n  router.', at + 10);
  return SRC.slice(at, next === -1 ? SRC.length : next).replace(/^\s*\/\/.*$/gm, '');
}

test('the code is claimed by a guarded UPDATE, not a bare one', () => {
  const body = registerRoute();
  assert.match(body, /UPDATE activation_codes SET used_by = \$1, used_at = NOW\(\)\s*\n\s*WHERE code = \$2 AND used_by IS NULL/,
    'the write must re-assert the condition the read used to rely on');
  assert.match(body, /claim\.rowCount !== 1/,
    'and the row count is what decides the winner');
});

test('the unguarded claim-by-id is gone', () => {
  const body = registerRoute();
  assert.doesNotMatch(body, /WHERE id = \$2\b/,
    'an unguarded claim by id is what let the loser overwrite the winner');
});

test('a cheap preflight still refuses a bad code BEFORE bcrypt', () => {
  // Removing the lookup entirely was a real regression, and an adversarial
  // review caught it: every unknown or spent code then cost a cost-12 hash
  // (~100ms of CPU) on an unauthenticated route before being refused, which
  // the per-IP limiter does not bound for a distributed caller.
  //
  // So the SELECT is back — as an OPTIMISATION, not as the claim. It may go
  // stale in exactly the window this issue is about; the guarded UPDATE
  // below is what actually decides.
  const body = registerRoute();
  const pre = body.indexOf('SELECT 1 FROM activation_codes');
  const hash = body.indexOf('bcrypt.hash');
  const claim = body.indexOf('UPDATE activation_codes');
  assert.ok(pre > -1, 'the preflight exists');
  assert.ok(pre < hash, 'and it runs before the expensive hash');
  assert.ok(hash < claim, 'while the authority is still the guarded UPDATE after it');
});

test('the insert and the claim are one transaction', () => {
  const body = registerRoute();
  // Through `withTransaction`, not a bare pool.connect(): route tests and
  // some embedded deployments supply a transaction-capable query facade with
  // no pg.Pool#connect, and connecting directly turned every valid
  // registration into a 500 there. The helper owns BEGIN/COMMIT/ROLLBACK and
  // the release, so this asserts the boundary rather than the keywords.
  const open = body.indexOf('withTransaction(pool');
  const insert = body.indexOf('INSERT INTO users');
  const claim = body.indexOf('UPDATE activation_codes');
  assert.ok(open > -1, 'the shared helper opens it');
  assert.ok(open < insert && insert < claim, 'both statements are inside, in order');
  assert.doesNotMatch(body, /pool\.connect\(\)/,
    'a bare connect() breaks the query-only facades the helper supports');
});

test('a lost race THROWS, so the loser\u2019s user row is rolled back', () => {
  const body = registerRoute();
  // Returning normally from the callback would COMMIT the user the loser
  // had already inserted — an orphan account with no code behind it.
  assert.match(body, /if \(claim\.rowCount !== 1\) throw CODE_TAKEN;/);
  assert.match(SRC, /const CODE_TAKEN = Symbol\('activation-code-taken'\);/,
    'a Symbol, so it can never collide with a real database error');
  assert.match(body, /if \(err === CODE_TAKEN\)/, 'identity-compared');
  assert.match(body, /throw err;/, 'and anything else still propagates');
});

test('a loser is refused in the same words as an unknown code', () => {
  const body = registerRoute();
  // Two different causes, one message: which one it was is not something an
  // unauthenticated caller should be able to distinguish.
  const messages = [...body.matchAll(/'Invalid or already used activation code'/g)];
  assert.equal(messages.length, 2,
    'one wording, from the preflight and from the lost race alike');
});

test('the side effects still hang off a committed account', () => {
  const body = registerRoute();
  const commit = body.indexOf("client.query('COMMIT')");
  for (const after of ['grantPlatformAccess', 'ensureIncludedKey', 'INSERT INTO sessions']) {
    assert.ok(body.indexOf(after) > commit,
      `${after} must not run for a registration that rolled back`);
  }
});
