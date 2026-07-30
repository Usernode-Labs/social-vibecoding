// Staging self-signing for app-identity tokens.
//
// THE BUG THIS FIXES. The platform runs inside its own staging clone, and the
// clone is also a PARENT SHELL: it renders app views, and each one fetches
// /api/iframe-token for the embedded child. A clone is injected no PRIVATE
// key, so signAppIdentityToken() threw and the endpoint answered its
// structured 503 — a console error on load, which tripped the console-error
// baseline on seven proposal checks at once. The retired pre-cutover
// bootstrap shim had been covering this by minting a bare-HS256 token;
// deleting it exposed the gap rather than causing it.
//
// THE BUG IN THE FIRST ATTEMPT AT THIS FIX, which this suite exists to keep
// fixed. That attempt generated a pair only when NEITHER env half was set —
// but a staging clone DOES receive IFRAME_JWT_PUBLIC_KEY:
// services/app-identity-env.js injects it into every container, the clone
// included, precisely so the clone can verify the production parent's token.
// So the guard always short-circuited, nothing was generated, and the 503
// survived a fix that passed a local test which had booted with neither
// variable set. `STAGING_CONTAINER` below is the real shape.
//
// TWO ISSUERS, and conflating them is what makes this subtle. A clone must
// simultaneously:
//   1. VERIFY the production parent's token (arrives as `?token=` on the
//      preview's iframe src; it is what mints the preview's own session, and
//      therefore what gets the checks runner in at all). Signed with
//      production's private key → only verifies against the INJECTED public
//      key, which must never be overwritten.
//   2. SIGN its own tokens for the app views it renders, with a pair it
//      generates for itself.
// Both are checked with identical pins (RS256, issuer, per-app audience,
// `pur`) — a two-key keyring, not a relaxed check.
//
// Run with: node --test tests/staging-self-signed-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const platformJwt = require('../src/services/platform-jwt');

// Stands in for production's pair — the parent shell's signing key.
const PROD = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const IFRAME_ENV = [
  'USERNODE_ENV', 'IFRAME_JWT_PRIVATE_KEY', 'IFRAME_JWT_PUBLIC_KEY',
];

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
  platformJwt._resetStagingSigningPair();
  try {
    return fn();
  } finally {
    apply(saved);
    platformJwt._resetStagingSigningPair();
  }
}

// EXACTLY what a staging container's env looks like: appIdentityEnv() gives
// it the production PUBLIC key (so it can verify parent tokens) and no
// private key. Getting this shape wrong is what made the first fix a no-op.
const STAGING_CONTAINER = {
  USERNODE_ENV: 'staging',
  IFRAME_JWT_PUBLIC_KEY: PROD.publicKey,
  IFRAME_JWT_PRIVATE_KEY: undefined,
};

// A parent-shell token, signed with production's private key.
function parentToken(appId = 1, user = { id: 3, username: 'evan' }) {
  return jwt.sign(
    { ...user, pur: 'iframe' },
    PROD.privateKey,
    { algorithm: 'RS256', issuer: 'usernode', audience: `usernode:app:${appId}`, expiresIn: '15m' }
  );
}

// ── The regression: a real staging container DOES self-sign ─────────────

// The exact assertion the first attempt would have failed. Kept first and
// named plainly, because "an injected public key must not block generation"
// is the single fact that fix got wrong.
test('a staging container with the public key injected still generates a signing pair', () => {
  withEnv(STAGING_CONTAINER, () => {
    assert.ok(process.env.IFRAME_JWT_PUBLIC_KEY,
      'precondition: appIdentityEnv injects the public half into every container');
    assert.equal(process.env.IFRAME_JWT_PRIVATE_KEY, undefined,
      'precondition: no private half is ever injected into a clone');

    const result = platformJwt.generateStagingIframeKeyPair();
    assert.equal(result.generated, true,
      'an injected PUBLIC key must not suppress generation — this is the bug');
    assert.equal(result.bits, 2048);
  });
});

test('before generation the signer throws — the throw that became the 503', () => {
  withEnv(STAGING_CONTAINER, () => {
    assert.throws(
      () => platformJwt.signAppIdentityToken({ appId: 1, user: { id: 1 } }),
      /IFRAME_JWT_PRIVATE_KEY not set/
    );
  });
});

test('after generation the clone mints a real RS256 token it can verify', () => {
  withEnv(STAGING_CONTAINER, () => {
    platformJwt.generateStagingIframeKeyPair();
    const token = platformJwt.signAppIdentityToken({
      appId: 1,
      user: { id: 3, username: 'evan', usernode_pubkey: 'ut1abc', locale: 'id' },
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'RS256', 'the production algorithm, not a downgrade');

    const claims = platformJwt.verifyAppIdentityToken(token, { appId: 1 });
    assert.equal(claims.id, 3);
    assert.equal(claims.username, 'evan');
    assert.equal(claims.usernode_pubkey, 'ut1abc');
    assert.equal(claims.locale, 'id');
    assert.equal(claims.iss, 'usernode');
    assert.equal(claims.aud, 'usernode:app:1');
    assert.equal(claims.pur, 'iframe');
  });
});

// ── The other issuer: the parent handoff must keep working ──────────────

// If self-signing overwrote IFRAME_JWT_PUBLIC_KEY, the production parent's
// token would stop verifying, the preview could not mint a session, and the
// checks runner would hit a login screen — failing every check harder than
// the 503 did.
test('the production parent\'s token still verifies after the clone self-signs', () => {
  withEnv(STAGING_CONTAINER, () => {
    platformJwt.generateStagingIframeKeyPair();
    const claims = platformJwt.verifyAppIdentityToken(parentToken(), { appId: 1 });
    assert.equal(claims.username, 'evan',
      'the injected public key must remain trusted — this is the session handoff');
  });
});

test('the injected public key is left byte-identical', () => {
  withEnv(STAGING_CONTAINER, () => {
    platformJwt.generateStagingIframeKeyPair();
    assert.equal(process.env.IFRAME_JWT_PUBLIC_KEY, PROD.publicKey);
  });
});

test('a clone trusts exactly two keys; production trusts exactly one', () => {
  withEnv(STAGING_CONTAINER, () => {
    assert.equal(platformJwt.iframeVerifyKeys().length, 1, 'before generation: just the injected one');
    platformJwt.generateStagingIframeKeyPair();
    assert.equal(platformJwt.iframeVerifyKeys().length, 2, 'after: parent + self');
  });
  withEnv({
    USERNODE_ENV: 'production',
    IFRAME_JWT_PUBLIC_KEY: PROD.publicKey,
    IFRAME_JWT_PRIVATE_KEY: PROD.privateKey,
  }, () => {
    assert.equal(platformJwt.iframeVerifyKeys().length, 1,
      'production must never grow a second trusted key');
  });
});

// The ephemeral private key must stay OUT of process.env: config.load() runs
// assertIframeKeyPair() whenever both env halves are present, and an
// ephemeral private key beside production's injected public key would fail
// that probe and hard-exit — the preview would not boot at all.
test('the ephemeral private key is never written into process.env', () => {
  withEnv(STAGING_CONTAINER, () => {
    platformJwt.generateStagingIframeKeyPair();
    assert.equal(process.env.IFRAME_JWT_PRIVATE_KEY, undefined,
      'writing it here would make config.load() probe a mismatched pair and exit 1');
    // But signing still works, i.e. the signer reads the module-state pair.
    assert.ok(platformJwt.signAppIdentityToken({ appId: 1, user: { id: 1 } }));
  });
});

// ── Nothing about the verify path relaxes ───────────────────────────────

test('a self-signed clone still refuses every malformed token', () => {
  withEnv(STAGING_CONTAINER, () => {
    platformJwt.generateStagingIframeKeyPair();
    const own = platformJwt.signAppIdentityToken({ appId: 1, user: { id: 3 } });

    assert.throws(() => platformJwt.verifyAppIdentityToken(own, { appId: 2 }),
      'a token minted for app 1 must not authenticate app 2');
    assert.throws(() => platformJwt.verifyAppIdentityToken(parentToken(1), { appId: 2 }),
      'nor may the parent\'s, through the second key');

    // HS256 forged with a public PEM as the HMAC key — every container knows
    // the public half, so this is the confusion attack that matters. Try it
    // against BOTH trusted keys.
    for (const [label, key] of [['injected', PROD.publicKey], ['self-signed', platformJwt.iframeVerifyKeys()[1]]]) {
      const forged = jwt.sign({ id: 3, pur: 'iframe' }, key, {
        algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:app:1', expiresIn: '15m',
      });
      assert.throws(() => platformJwt.verifyAppIdentityToken(forged, { appId: 1 }),
        `RS256 must stay pinned against the ${label} key`);
    }

    // A THIRD party's RS256 key — another preview, or this one before a
    // restart. Confinement is the point.
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const foreign = jwt.sign({ id: 3, pur: 'iframe' }, other.privateKey, {
      algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:1', expiresIn: '15m',
    });
    assert.throws(() => platformJwt.verifyAppIdentityToken(foreign, { appId: 1 }),
      'an untrusted key must not verify even with every claim correct');

    // Wrong purpose, through the keyring.
    const wrongPur = jwt.sign({ id: 3, pur: 'worker' }, PROD.privateKey, {
      algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:1', expiresIn: '15m',
    });
    assert.throws(() => platformJwt.verifyAppIdentityToken(wrongPur, { appId: 1 }),
      /invalid purpose/);
  });
});

// ── Generation is guarded and idempotent ───────────────────────────────

test('an injected private key is never clobbered', () => {
  withEnv({ ...STAGING_CONTAINER, IFRAME_JWT_PRIVATE_KEY: PROD.privateKey }, () => {
    const result = platformJwt.generateStagingIframeKeyPair();
    assert.equal(result.generated, false, 'an operator-supplied signing key wins');
    assert.equal(process.env.IFRAME_JWT_PRIVATE_KEY, PROD.privateKey);
    assert.equal(platformJwt.iframeVerifyKeys().length, 1, 'and no second key is added');
  });
});

// A second call must not rotate the key out from under tokens already minted
// in this process.
test('generation is idempotent within a process', () => {
  withEnv(STAGING_CONTAINER, () => {
    platformJwt.generateStagingIframeKeyPair();
    const token = platformJwt.signAppIdentityToken({ appId: 1, user: { id: 3 } });
    const again = platformJwt.generateStagingIframeKeyPair();
    assert.equal(again.generated, false);
    assert.equal(again.alreadyGenerated, true);
    assert.ok(platformJwt.verifyAppIdentityToken(token, { appId: 1 }),
      'a token minted before the second call must still verify');
  });
});

test('the generator refuses outside staging', () => {
  for (const env of ['production', undefined, 'development']) {
    withEnv({ ...STAGING_CONTAINER, USERNODE_ENV: env }, () => {
      assert.throws(
        () => platformJwt.generateStagingIframeKeyPair(),
        /refusing to self-sign outside staging/,
        `USERNODE_ENV=${env} must never self-sign`
      );
      assert.equal(platformJwt.iframeVerifyKeys().length, 1, 'and adds no key');
    });
  }
});

// The structured 503 is still the right answer for a real deployment that
// cannot sign — self-signing must not paper over a missing operator key.
test('production with no signing key still cannot sign', () => {
  withEnv({ ...STAGING_CONTAINER, USERNODE_ENV: 'production' }, () => {
    assert.throws(
      () => platformJwt.signAppIdentityToken({ appId: 1, user: { id: 1 } }),
      /IFRAME_JWT_PRIVATE_KEY not set/,
      'this throw is what /api/iframe-token turns into its 503'
    );
  });
});

// The two locks, asserted as source properties: config.js must gate the call
// on staging, and must not have regressed to an "either half" guard.
test('config.js gates the call on staging', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/config.js'), 'utf8');
  const callIdx = src.indexOf('= platformJwt.generateStagingIframeKeyPair()');
  assert.ok(callIdx > 0, 'config.load() must call the generator');
  const gateIdx = src.lastIndexOf('if (staging) {', callIdx);
  assert.ok(gateIdx > 0 && gateIdx < callIdx,
    'the call must sit inside an `if (staging)` branch');
});

test('the generator does not gate on the public half', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/services/platform-jwt.js'), 'utf8');
  const start = src.indexOf('function generateStagingIframeKeyPair');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(!/IFRAME_JWT_PUBLIC_KEY/.test(body),
    'gating on the injected public key is what made the first fix a no-op');
});
