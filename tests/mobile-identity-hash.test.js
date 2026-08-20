// The mobile app's local-storage namespace (src/services/mobile-identity-hash.js).
//
// The app prefixes persisted state — the on-chain account registry above all —
// with this value, so these tests are a stability contract, not a description:
// the pinned literals below must not change without a versioned migration
// shipping in the app first. Changing them silently orphans every install's
// local accounts.
//
// Run with: node --test tests/mobile-identity-hash.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mobileIdentityHash,
  MOBILE_IDENTITY_HASH_VERSION,
  HASH_LENGTH,
} = require('../src/services/mobile-identity-hash');

test('the namespace for a known user is pinned', () => {
  assert.equal(
    mobileIdentityHash({ id: 1, email: 'alice@example.com' }),
    'a145a65507b14025'
  );
  assert.equal(MOBILE_IDENTITY_HASH_VERSION, 'v1');
});

test('the namespace is 16 hex characters, matching the app bucket convention', () => {
  const hash = mobileIdentityHash({ id: 7, email: 'someone@example.com' });
  assert.equal(hash.length, HASH_LENGTH);
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test('different users never share a namespace', () => {
  const sameEmail = new Set([
    mobileIdentityHash({ id: 1, email: 'alice@example.com' }),
    mobileIdentityHash({ id: 2, email: 'alice@example.com' }),
  ]);
  assert.equal(sameEmail.size, 2, 'the id must separate them');

  const sameId = new Set([
    mobileIdentityHash({ id: 1, email: 'alice@example.com' }),
    mobileIdentityHash({ id: 1, email: 'bob@example.com' }),
  ]);
  assert.equal(sameId.size, 2, 'the email must separate them');
});

test('casing and surrounding whitespace cannot fork one account into two', () => {
  // `users_email_lower_unique` indexes lower(email), so the same account can
  // legitimately present differently-cased addresses. Both must resolve to
  // the one namespace, or the second login loses the first login's wallet.
  const canonical = mobileIdentityHash({ id: 1, email: 'alice@example.com' });
  assert.equal(mobileIdentityHash({ id: 1, email: 'ALICE@EXAMPLE.COM' }), canonical);
  assert.equal(mobileIdentityHash({ id: 1, email: '  Alice@Example.com ' }), canonical);
});

test('a username-only account has no email and still gets a namespace', () => {
  // Platform accounts predating the mobile signup flow have a NULL email.
  const nullEmail = mobileIdentityHash({ id: 42, email: null });
  assert.match(nullEmail, /^[0-9a-f]{16}$/);
  assert.equal(mobileIdentityHash({ id: 42 }), nullEmail);
  assert.equal(mobileIdentityHash({ id: 42, email: '' }), nullEmail);
  assert.notEqual(mobileIdentityHash({ id: 43, email: null }), nullEmail);
});

test('a row with no id yields null rather than a namespace to write under', () => {
  assert.equal(mobileIdentityHash(null), null);
  assert.equal(mobileIdentityHash(undefined), null);
  assert.equal(mobileIdentityHash({}), null);
  assert.equal(mobileIdentityHash({ id: null, email: 'a@b.c' }), null);
});

test('a numeric and a string id are the same account', () => {
  // Postgres bigints arrive as strings through some drivers; the app must not
  // land in a second namespace because of the wire type.
  assert.equal(
    mobileIdentityHash({ id: '1', email: 'alice@example.com' }),
    mobileIdentityHash({ id: 1, email: 'alice@example.com' })
  );
});
