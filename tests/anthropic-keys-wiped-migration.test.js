'use strict';

// Task 2275: the migration that wipes people's own Anthropic keys
// (src/db/migrations/anthropic-keys-wiped.sql). Pinned on its text, since
// the Postgres suites run on the platform rather than here: it clears the
// two columns without dropping them (a rollback to the build before still
// boots and finds no key), turns the generic store's copies into the
// tombstones credential-store.js revoke() leaves, and removes the Anthropic
// credit balance the admin card recorded. It is recorded in the manifest.
//
// Run with: node --test tests/anthropic-keys-wiped-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src/db/migrations');
const sql = fs.readFileSync(path.join(DIR, 'anthropic-keys-wiped.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');

test('every stored Anthropic key is wiped, and the columns stay for a rollback', () => {
  assert.match(code, /UPDATE users\s+SET anthropic_key_enc = NULL,\s+anthropic_key_last4 = NULL\s+WHERE anthropic_key_enc IS NOT NULL OR anthropic_key_last4 IS NOT NULL;/);
  assert.doesNotMatch(code, /DROP\s+COLUMN/i, 'the columns go in a later release');
  assert.doesNotMatch(code, /DROP\s+TABLE|DELETE\s+FROM\s+(users|credentials)/i, 'no row is deleted');
});

test('the generic copies become tombstones, the shape revoke() leaves', () => {
  const update = code.match(/UPDATE credentials\.user_ai_credentials[\s\S]*?;/);
  assert.ok(update, 'the generic store is updated');
  for (const set of [
    /secret_enc = NULL/, /secret_last4 = NULL/, /secret_fingerprint = NULL/,
    /status = 'revoked'/, /verified_at = NULL/, /revoked_at = COALESCE\(revoked_at, NOW\(\)\)/,
    /revision = revision \+ 1/,
  ]) {
    assert.match(update[0], set, String(set));
  }
  assert.match(update[0], /WHERE provider = 'anthropic'/, 'only Anthropic rows');
  // verified_at NULL with a non-valid status is what the table's
  // valid_verified CHECK requires; the revoke() upsert writes the same.
  const store = fs.readFileSync(path.join(ROOT, 'src/services/credential-store.js'), 'utf8');
  assert.match(store, /status = 'revoked',\s+verified_at = NULL,\s+revoked_at = NOW\(\),\s+revision = credentials\.user_ai_credentials\.revision \+ 1,/);
});

test('the Anthropic credit balance the admin card recorded is removed', () => {
  assert.match(code, /DELETE FROM platform_settings\s+WHERE key IN \('anthropic_credit_balance_cents', 'anthropic_credit_as_of'\);/);
});

test('it is transactional and recorded in the manifest, last', () => {
  assert.doesNotMatch(code, /\b(BEGIN|COMMIT|ROLLBACK)\b/i, 'the runner owns the transaction');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const ids = manifest.migrations.map((m) => m.id);
  assert.ok(ids.includes('anthropic-keys-wiped'));
  const { loadPlan } = require('../src/db/schema-source');
  assert.doesNotThrow(() => loadPlan(DIR), 'its checksums are the ones the plan verifies');
});
