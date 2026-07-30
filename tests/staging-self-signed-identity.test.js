// Staging self-signing for app-identity tokens.
//
// THE BUG THIS FIXES. The platform runs inside its own staging clone, and
// that clone is injected no platform keys — deliberately, since a preview
// built from unreviewed branch code must never hold production's signing
// key. But the clone is also a PARENT SHELL: it renders app views, and each
// one fetches /api/iframe-token for the embedded child. With no
// IFRAME_JWT_PRIVATE_KEY, signAppIdentityToken() throws, the endpoint
// answers its structured 503, and every framed route logs a console error —
// which failed the console-error baseline check on seven proposal checks at
// once (`/?shot=secrets#app/<self>/dev` and friends).
//
// The retired pre-cutover bootstrap shim used to paper over this by minting
// a bare-HS256 token. The fix here does NOT reintroduce a second token
// shape: a staging clone generates its own ephemeral RSA pair at boot and
// then runs the byte-identical sign/verify path as production.
//
// Both halves are pinned here, because the pair only makes sense together:
//
//   1. STAGING SELF-SIGNS — and the result is a real RS256 app-identity
//      token that the clone's own verifier accepts, with every production
//      claim check still in force (algorithm, issuer, per-app audience,
//      `pur`). Nothing is weakened to make this work.
//   2. PRODUCTION IS UNTOUCHED — the generator refuses outside staging, and
//      a deployment with no signing key still answers the structured 503
//      rather than self-signing its way out of a misconfiguration.
//
// Run with: node --test tests/staging-self-signed-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const platformJwt = require('../src/services/platform-jwt');

const IFRAME_ENV = [
  'USERNODE_ENV', 'IFRAME_JWT_PRIVATE_KEY', 'IFRAME_JWT_PUBLIC_KEY',
];

// Run `fn` under an env patch, restoring every key afterwards. `undefined`
// means "delete", which is the state that matters here — a staging clone has
// no key material at all.
function withEnv(patch, fn) {
  const saved = {};
  for (const k of IFRAME_ENV) saved[k] = process.env[k];
  const apply = (o) => {
    for (const k of IFRAME_ENV) {
      if (o[k] === undefined) delete process.env[k];
      else process.env[k] = o[k];
    }
  };
  apply({ ...saved, ...patch });
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

// Exactly a staging clone at boot: staging, and no key material of any kind.
const BARE_STAGING = {
  USERNODE_ENV: 'staging',
  IFRAME_JWT_PRIVATE_KEY: undefined,
  IFRAME_JWT_PUBLIC_KEY: undefined,
};

// ── 1. Staging self-signs ───────────────────────────────────────────────

test('a bare staging clone generates a usable RSA pair', () => {
  withEnv(BARE_STAGING, () => {
    const result = platformJwt.generateStagingIframeKeyPair();
    assert.equal(result.generated, true);
    assert.equal(result.bits, 2048, 'must clear assertIframeKeyPair\'s 2048 minimum');

    // Both halves, together — the clone is its own verifier, so a pair that
    // is only half-populated would fail closed on every app view.
    assert.match(process.env.IFRAME_JWT_PRIVATE_KEY, /^-----BEGIN PRIVATE KEY-----/);
    assert.match(process.env.IFRAME_JWT_PUBLIC_KEY, /^-----BEGIN PUBLIC KEY-----/);

    // The boot check that guards production runs clean on the generated
    // pair too — same probe round-trip, no special case.
    assert.deepEqual(platformJwt.assertIframeKeyPair(), { bits: 2048 });
  });
});

test('the self-signed pair mints a real RS256 app-identity token', () => {
  withEnv(BARE_STAGING, () => {
    platformJwt.generateStagingIframeKeyPair();
    const token = platformJwt.signAppIdentityToken({
      appId: 42,
      user: { id: 3, username: 'evan', usernode_pubkey: 'ut1abc', locale: 'id' },
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'RS256', 'the production algorithm, not a downgrade');

    const claims = platformJwt.verifyAppIdentityToken(token, { appId: 42 });
    assert.equal(claims.id, 3);
    assert.equal(claims.username, 'evan');
    assert.equal(claims.usernode_pubkey, 'ut1abc');
    assert.equal(claims.locale, 'id');
    assert.equal(claims.iss, 'usernode', 'issuer still pinned');
    assert.equal(claims.aud, 'usernode:app:42', 'still app-scoped');
    assert.equal(claims.pur, 'iframe', 'purpose claim still emitted');
  });
});

// The whole safety argument for self-signing is that NOTHING about the
// verify path relaxes. Re-assert the rejection matrix against a self-signed
// pair, so a future "just make staging easier" change cannot quietly widen
// it.
test('a self-signed clone still refuses every malformed token', () => {
  withEnv(BARE_STAGING, () => {
    platformJwt.generateStagingIframeKeyPair();
    const token = platformJwt.signAppIdentityToken({ appId: 42, user: { id: 3 } });

    assert.throws(() => platformJwt.verifyAppIdentityToken(token, { appId: 43 }),
      'a token minted for app 42 must not authenticate app 43');

    // HS256 forged with the (public) PEM as the HMAC key — the algorithm
    // confusion every container could otherwise attempt, since every
    // container knows the public half.
    const forged = jwt.sign(
      { id: 3, pur: 'iframe' },
      process.env.IFRAME_JWT_PUBLIC_KEY,
      { algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:app:42', expiresIn: '15m' }
    );
    assert.throws(() => platformJwt.verifyAppIdentityToken(forged, { appId: 42 }),
      'RS256 stays pinned in a self-signed clone');

    // A token from a DIFFERENT ephemeral pair — i.e. another preview, or
    // this one before a restart. Confinement is the point: a self-signed
    // token authenticates against exactly one clone.
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const foreign = jwt.sign(
      { id: 3, pur: 'iframe' },
      other.privateKey,
      { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:42', expiresIn: '15m' }
    );
    assert.throws(() => platformJwt.verifyAppIdentityToken(foreign, { appId: 42 }),
      'another preview\'s ephemeral key must not verify here');
  });
});

// Self-signing puts a REAL private key into a preview's process for the
// first time, so the key-separation invariant has to hold here too: the
// container-env builder must still emit only the public half. Sibling of
// tests/key-separation-env.test.js, asserted against a self-signed pair
// specifically because that suite runs with injected keys.
test('a self-signed clone still puts only the PUBLIC half in a container env', () => {
  withEnv(BARE_STAGING, () => {
    platformJwt.generateStagingIframeKeyPair();
    const priv = process.env.IFRAME_JWT_PRIVATE_KEY;
    const { appIdentityEnv } = require('../src/services/app-identity-env');
    // No `config` argument, so it falls back to process.env — the path a
    // staging clone actually takes.
    const env = appIdentityEnv({ id: 42 });

    for (const [name, value] of Object.entries(env)) {
      assert.ok(!/PRIVATE/.test(value),
        `${name} must not carry private key material`);
      assert.notEqual(value, priv, `${name} must not be the private half verbatim`);
    }
    assert.match(env.USERNODE_JWT_PUBLIC_KEY, /BEGIN PUBLIC KEY/);
    assert.equal(env.IFRAME_JWT_PUBLIC_KEY, env.USERNODE_JWT_PUBLIC_KEY);
    assert.equal(env.USERNODE_APP_ID, '42');
  });
});

test('an injected pair is never clobbered', () => {
  const { publicKey, privateKey } = require('./platform-keys').keyPair();
  withEnv({ ...BARE_STAGING, IFRAME_JWT_PRIVATE_KEY: privateKey, IFRAME_JWT_PUBLIC_KEY: publicKey }, () => {
    const result = platformJwt.generateStagingIframeKeyPair();
    assert.equal(result.generated, false, 'an operator-supplied key wins');
    assert.equal(process.env.IFRAME_JWT_PRIVATE_KEY, privateKey);
    assert.equal(process.env.IFRAME_JWT_PUBLIC_KEY, publicKey);
  });
});

// Half-configured is still "configured": generating the missing half would
// produce a MISMATCHED pair, which mints tokens nothing can verify — the
// exact silent failure assertIframeKeyPair exists to catch.
test('a half-configured pair is left alone rather than completed', () => {
  const { publicKey } = require('./platform-keys').keyPair();
  withEnv({ ...BARE_STAGING, IFRAME_JWT_PUBLIC_KEY: publicKey }, () => {
    const result = platformJwt.generateStagingIframeKeyPair();
    assert.equal(result.generated, false);
    assert.equal(process.env.IFRAME_JWT_PRIVATE_KEY, undefined,
      'must not invent a private half that does not match the public one');
  });
});

// ── 2. Production is untouched ──────────────────────────────────────────

test('the generator refuses outside staging', () => {
  for (const env of ['production', undefined, 'development']) {
    withEnv({ ...BARE_STAGING, USERNODE_ENV: env }, () => {
      assert.throws(
        () => platformJwt.generateStagingIframeKeyPair(),
        /refusing to self-sign outside staging/,
        `USERNODE_ENV=${env} must never self-sign`
      );
      assert.equal(process.env.IFRAME_JWT_PRIVATE_KEY, undefined,
        'and must leave the env untouched');
    });
  }
});

// The structured 503 is still the right answer for a real deployment that
// cannot sign — self-signing must not become a way to paper over an
// operator's missing key. config.load() only calls the generator on the
// staging branch, so production keeps failing loudly.
test('production with no signing key still cannot sign', () => {
  withEnv({ ...BARE_STAGING, USERNODE_ENV: 'production' }, () => {
    assert.throws(
      () => platformJwt.signAppIdentityToken({ appId: 1, user: { id: 1 } }),
      /IFRAME_JWT_PRIVATE_KEY not set/,
      'this throw is what /api/iframe-token turns into its 503'
    );
  });
});

// The two locks, asserted as source properties: config.js must gate the
// call on staging, and must place it BEFORE the config object literal that
// derives iframeJwtPublicKey from process.env (otherwise the generated key
// would never reach the container-env builders).
test('config.js gates the call on staging and generates before reading env', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/config.js'), 'utf8');

  // Anchor on the assignment, not the bare function name — the comment
  // above the call site names the function too.
  const callIdx = src.indexOf('= platformJwt.generateStagingIframeKeyPair()');
  assert.ok(callIdx > 0, 'config.load() must call the generator');

  const gateIdx = src.lastIndexOf('if (staging) {', callIdx);
  assert.ok(gateIdx > 0 && gateIdx < callIdx,
    'the call must sit inside an `if (staging)` branch');

  const derivedIdx = src.indexOf('iframeJwtPublicKey: (process.env.IFRAME_JWT_PUBLIC_KEY');
  assert.ok(derivedIdx > callIdx,
    'the generator must run BEFORE config derives iframeJwtPublicKey, or the '
    + 'self-signed public key never reaches appIdentityEnv');
});
