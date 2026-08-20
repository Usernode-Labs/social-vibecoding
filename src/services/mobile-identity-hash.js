'use strict';

// The stable per-user namespace the mobile app prefixes its local storage
// with.
//
// A mobile install keeps local state across sign-out — the on-chain account
// registry above all — so two people sharing one phone must never resolve to
// the same namespace, and the SAME person signing back in must resolve to the
// one they left, or their wallet becomes unreachable.
//
// Derived from `users.id` + `users.email`. The id alone would satisfy
// uniqueness (it is the primary key); the email is folded in so the value
// discloses neither on its own. Domain-separated and versioned, so changing
// the recipe is an explicit new version rather than a silent re-namespacing
// of every install.
//
// STABILITY CONTRACT: this value must never change for a user. Nothing in
// this codebase updates `users.email` — it is written only at INSERT (the OTP
// signup in src/routes/topochain/mobile-auth.js), which is what makes folding
// it in safe. Adding a change-email flow without bumping VERSION and shipping
// the app a migration would silently orphan the affected installs' local
// accounts.

const crypto = require('node:crypto');

const MOBILE_IDENTITY_HASH_VERSION = 'v1';
const DOMAIN = `usernode:mobile-identity:${MOBILE_IDENTITY_HASH_VERSION}`;

// 16 hex characters, matching the app's existing account-bucket convention
// (NetworkPrefs.bucketForAddress) so both namespaces read alike in a
// SharedPreferences dump.
const HASH_LENGTH = 16;

// Returns null for a user row with no id — callers serialize that as a null
// field rather than inventing a namespace the app would then write under.
function mobileIdentityHash(user) {
  const id = user == null ? null : user.id;
  if (id === null || id === undefined || id === '') return null;
  // Username-only platform accounts legitimately have no email; they hash
  // over the empty string and stay unique on the id alone. Lower-cased to
  // match the `users_email_lower_unique` index, so a differently-cased login
  // can never produce a second namespace for one account.
  const email = (user.email == null ? '' : String(user.email))
    .trim()
    .toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`${DOMAIN}|${String(id)}|${email}`, 'utf8')
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

module.exports = {
  mobileIdentityHash,
  MOBILE_IDENTITY_HASH_VERSION,
  HASH_LENGTH,
};
