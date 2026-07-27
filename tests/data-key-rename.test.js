// Regression guard for the JWT_SECRET → DATA_ENCRYPTION_KEY split.
//
// The old shared secret was both a signing key and the KDF input for
// every at-rest ciphertext (BYOK Anthropic keys, app secret values).
// Splitting it was a *rename* on the encryption side: DATA_ENCRYPTION_KEY
// must hold the same bytes JWT_SECRET held, and services/secrets.js must
// keep its KDF and envelope byte-identical, or every row already in the
// database becomes undecryptable garbage.
//
// So this file pins a ciphertext produced under the pre-split code and
// asserts it still decrypts through config.dataEncryptionKey, and that
// the envelope shape and derived key are unchanged. If someone "improves"
// deriveKey/ALGO/IV_LEN/VERSION, these fail loudly instead of at 3am.
//
// Run with: node --test tests/data-key-rename.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const secrets = require('../src/services/secrets');
const config = require('../src/config');
const { setPlatformKeys } = require('./platform-keys');

// The value the shared JWT_SECRET held on the server before the split.
const LEGACY_SHARED_SECRET = 'the-old-shared-jwt-secret-value';
const LEGACY_PLAINTEXT = 'sk-ant-legacy-byok-key-value';
// Captured from the pre-split encrypt() with the secret above. Frozen on
// purpose: regenerating it would defeat the test.
const LEGACY_CIPHERTEXT =
  'v1:1bHUfrdm7qguZMDp:E1hVYrRDrTO99Mu8u5leOA==:qKnCVegJaNoSNP71c/610NSwSXbhCqMS00ppRA==';

function loadWith(env) {
  const saved = {};
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
    ...env,
  };
  setPlatformKeys();
  for (const [k, v] of Object.entries(base)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // load() is chatty and, on a bad key pair, exits the process.
  const realLog = console.log;
  console.log = () => {};
  try {
    return config.load();
  } finally {
    console.log = realLog;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── the actual migration risk ──────────────────────────────────────────

test('a ciphertext written before the split decrypts through config.dataEncryptionKey', () => {
  const cfg = loadWith({
    DATA_ENCRYPTION_KEY: LEGACY_SHARED_SECRET,
    JWT_SECRET: undefined,
  });
  assert.equal(cfg.dataEncryptionKey, LEGACY_SHARED_SECRET);
  assert.equal(secrets.decrypt(LEGACY_CIPHERTEXT, cfg.dataEncryptionKey), LEGACY_PLAINTEXT);
});

test('the legacy JWT_SECRET-only .env still boots and still decrypts', () => {
  // Operators who deploy the new code with an old .env get the shim: the
  // data key falls back to JWT_SECRET's value, which is the same bytes.
  const cfg = loadWith({
    DATA_ENCRYPTION_KEY: undefined,
    JWT_SECRET: LEGACY_SHARED_SECRET,
  });
  assert.equal(cfg.dataEncryptionKey, LEGACY_SHARED_SECRET);
  assert.equal(secrets.decrypt(LEGACY_CIPHERTEXT, cfg.dataEncryptionKey), LEGACY_PLAINTEXT);
});

test('a different data key does NOT decrypt it (the fixture is real, not a no-op)', () => {
  // decrypt() is soft-fail by design — callers treat null as "no usable
  // key on file" — so the wrong key yields null, not an exception.
  assert.equal(secrets.decrypt(LEGACY_CIPHERTEXT, 'some-other-key'), null);
});

// ── envelope and KDF are frozen ────────────────────────────────────────

test('the KDF is still plain SHA-256 of the key string', () => {
  // Re-encrypting under a hand-derived key must produce something the
  // module can read back, which only holds if deriveKey is unchanged.
  const key = crypto.createHash('sha256').update(LEGACY_SHARED_SECRET).digest();
  const [, ivB64, tagB64, ctB64] = LEGACY_CIPHERTEXT.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const out = decipher.update(Buffer.from(ctB64, 'base64'), undefined, 'utf8') + decipher.final('utf8');
  assert.equal(out, LEGACY_PLAINTEXT);
});

test('the envelope is still v1:<iv>:<tag>:<ct> with a 12-byte IV', () => {
  const parts = secrets.encrypt('hello', LEGACY_SHARED_SECRET).split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1], 'base64').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64').length, 16);
});

test('round-tripping a fresh value under the renamed key still works', () => {
  const enc = secrets.encrypt('sk-ant-new-value', LEGACY_SHARED_SECRET);
  assert.notEqual(enc, LEGACY_CIPHERTEXT); // random IV per encrypt
  assert.equal(secrets.decrypt(enc, LEGACY_SHARED_SECRET), 'sk-ant-new-value');
});

test('decrypt returns null for a missing key or a foreign version prefix', () => {
  assert.equal(secrets.decrypt(LEGACY_CIPHERTEXT, ''), null);
  assert.equal(secrets.decrypt(LEGACY_CIPHERTEXT.replace(/^v1:/, 'v2:'), LEGACY_SHARED_SECRET), null);
  // encrypt(), by contrast, is loud — a missing key there would silently
  // write rows nobody can read back.
  assert.throws(() => secrets.encrypt('x', ''), /dataEncryptionKey required/);
});

// ── the data key is not a signing key ──────────────────────────────────

test('the data key is not exported as any token-signing key', () => {
  const cfg = loadWith({ DATA_ENCRYPTION_KEY: LEGACY_SHARED_SECRET, JWT_SECRET: undefined });
  assert.notEqual(cfg.workerJwtSecret, cfg.dataEncryptionKey);
  assert.notEqual(cfg.edgeJwtSecret, cfg.dataEncryptionKey);
  assert.ok(cfg.workerJwtSecret.length > 0);
  assert.ok(cfg.edgeJwtSecret.length > 0);
});
