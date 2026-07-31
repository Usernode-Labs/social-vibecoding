'use strict';

// Shared env shim for tests that boot src/config.js or exercise
// src/services/platform-jwt.js.
//
// NOT a `*.test.js` file, so `node --test tests/*.test.js` doesn't try to
// run it as a suite.
//
// config.load() requires the four platform keys in production mode
// (src/config.js REQUIRED_PROD), and the boot check round-trips the RSA
// pair. Every test that calls config.load() therefore needs real key
// material, and generating a 2048-bit pair inline in a dozen suites
// would be both slow and noisy — hence one helper.
//
// The pair is generated per process rather than committed: a committed
// private key, however fake, is exactly the shape secret scanners flag,
// and generation costs one ~100ms hit per test file.

const crypto = require('crypto');

let cachedPair = null;

function keyPair() {
  if (!cachedPair) {
    cachedPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  return cachedPair;
}

// Populate process.env with usable platform keys. Existing values win, so
// a suite that wants to pin a specific secret (to forge or to assert a
// rejection) can set it before calling this.
function setPlatformKeys(overrides = {}) {
  const { publicKey, privateKey } = keyPair();
  const defaults = {
    DATA_ENCRYPTION_KEY: 'test-data-encryption-key-0123456789abcdef',
    IFRAME_JWT_PRIVATE_KEY: privateKey,
    IFRAME_JWT_PUBLIC_KEY: publicKey,
    WORKER_JWT_SECRET: 'test-worker-jwt-secret-0123456789abcdef0',
    EDGE_JWT_SECRET: 'test-edge-jwt-secret-0123456789abcdef012',
    // Keep boot tests deterministic when a developer's .env enables local
    // mode after this helper runs. dotenv will not overwrite this value.
    USERNODE_LOCAL_DEV: '0',
    CLI_CANONICAL_ORIGIN: 'https://social-vibecoding.usernodelabs.org',
  };
  const out = {};
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    if (!process.env[k]) process.env[k] = v;
    out[k] = process.env[k];
  }
  return out;
}

module.exports = { setPlatformKeys, keyPair };
