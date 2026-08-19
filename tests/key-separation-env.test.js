// The containment invariant behind the four-way key separation (#836 +
// the phase-2 RSA cutover): a child container — an app container, a
// staging clone, a CC worker, or the in-loop browser's throwaway app —
// must never receive a platform signing/encryption key, BY NAME OR BY
// VALUE.
//
// Why this needs its own suite. Before the split there was one shared
// JWT_SECRET, it was handed to every app container, and DATA_ENCRYPTION_KEY
// held the same bytes — so any app could mint any user's identity for any
// other app, and the AES key protecting every BYOK key and app secret at
// rest was sitting in ~40 containers. The cutover fixed that by giving
// each authority its own key and handing children only the RSA PUBLIC
// half. Nothing structural stops a future `env: { ... }` line from undoing
// it, and the failure is silent: the container works fine, it just also
// holds the crown jewels.
//
// Coverage is three-layered on purpose, because no single layer is enough:
//
//   1. Behavioral, real values. The shared appIdentityEnv() helper, the
//      in-loop-browser env, app-secrets' platform-defaults bridge, and
//      app-respawn's full production env contract are invoked for real
//      with every forbidden key set to a recognizable sentinel, and the
//      resulting env is searched for those sentinels. This catches a leak
//      that arrives through a spread (...merge.env, ...llmEnv) where no
//      forbidden name is written literally anywhere.
//
//   2. Structural, on the env literals. worker.js hands its container env
//      to the docker CLI as argv, not as an object a test can capture
//      without driving a real turn, so its secretEnv/safeEnv literals are
//      parsed out of the source and their keys checked.
//
//   3. Name grep across every file that builds container env, with
//      comments stripped. `DATA_ENCRYPTION_KEY: config.dataEncryptionKey`
//      added to any builder fails here even if that builder has no
//      behavioral test.
//
// The forbidden list is DERIVED from config.js's REQUIRED_PROD rather than
// hand-written, so a sixth platform key added later is covered the day it
// lands instead of quietly falling outside the suite.
//
// Run with: node --test tests/key-separation-env.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ── The forbidden set, derived from config.js ───────────────────────────

// Every platform key the process must hold. Parsed from source because
// requiring config.js runs load() semantics we don't want here.
function requiredProdKeys() {
  const src = read('src/config.js');
  const m = src.match(/const REQUIRED_PROD = \[([\s\S]*?)\];/);
  assert.ok(m, 'config.js must still declare REQUIRED_PROD');
  return [...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]);
}

// The one platform key a child legitimately receives: the RSA public half
// it verifies user tokens with. Everything else in REQUIRED_PROD is a
// signing or encryption key and must stay host-side.
const CHILD_SAFE = new Set(['IFRAME_JWT_PUBLIC_KEY']);

const REQUIRED_PROD = requiredProdKeys();
const FORBIDDEN = REQUIRED_PROD.filter((k) => !CHILD_SAFE.has(k));

test('the forbidden set is the four host-only platform keys', () => {
  // Pins the derivation: if REQUIRED_PROD grows and the new key is
  // genuinely child-safe, add it to CHILD_SAFE deliberately — don't let
  // it slip in because nobody re-read this list.
  assert.deepEqual(FORBIDDEN.slice().sort(), [
    'DATA_ENCRYPTION_KEY',
    'EDGE_JWT_SECRET',
    'IFRAME_JWT_PRIVATE_KEY',
    'WORKER_JWT_SECRET',
  ]);
});

// Recognizable sentinels — long enough that a substring hit cannot be a
// coincidence, and distinct per key so a failure names the leak.
const SENTINELS = {};
for (const k of FORBIDDEN) SENTINELS[k] = `SENTINEL-${k}-must-never-reach-a-container`;

// Assert an env object (name → value) is clean both ways.
function assertNoLeak(where, env) {
  const flat = JSON.stringify(env);
  for (const k of FORBIDDEN) {
    assert.ok(!Object.prototype.hasOwnProperty.call(env, k),
      `${where} sets ${k} by name`);
    assert.ok(!flat.includes(SENTINELS[k]),
      `${where} leaks the ${k} VALUE under some other name`);
  }
}

// ── 1. Behavioral: the shared identity-env helper ───────────────────────

const { appIdentityEnv } = require('../src/services/app-identity-env');
const platformJwt = require('../src/services/platform-jwt');
const { keyPair } = require('./platform-keys');

// A config object with EVERY platform key populated, forbidden ones
// carrying their sentinel. This is what the real builders are handed.
function poisonedConfig() {
  return {
    dataEncryptionKey: SENTINELS.DATA_ENCRYPTION_KEY,
    iframeJwtPrivateKey: SENTINELS.IFRAME_JWT_PRIVATE_KEY,
    workerJwtSecret: SENTINELS.WORKER_JWT_SECRET,
    edgeJwtSecret: SENTINELS.EDGE_JWT_SECRET,
    iframeJwtPublicKey: '-----BEGIN PUBLIC KEY-----\\nFIXTUREPUBLIC\\n-----END PUBLIC KEY-----\\n',
  };
}

test('appIdentityEnv emits only the public key (twice), the shim and the app id', () => {
  const env = appIdentityEnv({ id: 7 }, poisonedConfig());
  assert.deepEqual(Object.keys(env).sort(),
    ['IFRAME_JWT_PUBLIC_KEY', 'JWT_SECRET', 'USERNODE_APP_ID', 'USERNODE_JWT_PUBLIC_KEY']);
  assertNoLeak('appIdentityEnv', env);
});

// The self-app's staging clone runs platform code, which reads the
// public key under the platform's OWN env-var name (see
// services/platform-jwt.js's iframePublicKey()) rather than the child
// name every other container reads. Without this copy the self-staging
// container's auth middleware throws on every request — see
// middleware/auth.js's tryMintSessionFromIframeJwt.
test('appIdentityEnv IFRAME_JWT_PUBLIC_KEY carries the same public PEM', () => {
  const env = appIdentityEnv({ id: 7 }, poisonedConfig());
  assert.equal(env.IFRAME_JWT_PUBLIC_KEY, env.USERNODE_JWT_PUBLIC_KEY);
  assert.match(env.IFRAME_JWT_PUBLIC_KEY, /BEGIN PUBLIC KEY/);
  assert.ok(!/PRIVATE/.test(env.IFRAME_JWT_PUBLIC_KEY));
});

// The key-confusion failure that would be worst of all: shipping the
// PRIVATE half under the deprecated JWT_SECRET name. Every container would
// then be able to mint identities for every app.
test('appIdentityEnv JWT_SECRET carries the PUBLIC half, never the private one', () => {
  const env = appIdentityEnv({ id: 7 }, poisonedConfig());
  assert.equal(env.JWT_SECRET, env.USERNODE_JWT_PUBLIC_KEY,
    'the deprecated alias must be the same public PEM');
  assert.match(env.JWT_SECRET, /BEGIN PUBLIC KEY/);
  assert.ok(!/PRIVATE/.test(env.JWT_SECRET));
});

test('appIdentityEnv does not fall back to a process-env private key', () => {
  // A container-side misread of IFRAME_JWT_PRIVATE_KEY would be invisible
  // in production (RS256 verifies against the private PEM too).
  const saved = process.env.IFRAME_JWT_PUBLIC_KEY;
  const savedPriv = process.env.IFRAME_JWT_PRIVATE_KEY;
  process.env.IFRAME_JWT_PRIVATE_KEY = SENTINELS.IFRAME_JWT_PRIVATE_KEY;
  delete process.env.IFRAME_JWT_PUBLIC_KEY;
  try {
    // No config at all: the helper falls back to process.env — and must
    // reach for the PUBLIC name only, yielding empty rather than the
    // private key that is sitting right there.
    const env = appIdentityEnv({ id: 7 });
    assertNoLeak('appIdentityEnv (env fallback)', env);
    assert.equal(env.USERNODE_JWT_PUBLIC_KEY, '');
  } finally {
    if (saved === undefined) delete process.env.IFRAME_JWT_PUBLIC_KEY;
    else process.env.IFRAME_JWT_PUBLIC_KEY = saved;
    if (savedPriv === undefined) delete process.env.IFRAME_JWT_PRIVATE_KEY;
    else process.env.IFRAME_JWT_PRIVATE_KEY = savedPriv;
  }
});

// The regression this whole fix guards against: a token minted host-side
// must verify inside a container whose env is EXACTLY appIdentityEnv's
// output — nothing more. Before the fix, IFRAME_JWT_PUBLIC_KEY was simply
// absent from that env, so platform-jwt.js's iframePublicKey() threw and
// the self-app's staging clone rejected every user token (middleware/
// auth.js's tryMintSessionFromIframeJwt).
test("a token minted host-side verifies using only appIdentityEnv's own output", () => {
  const { publicKey, privateKey } = keyPair();
  const env = appIdentityEnv({ id: 42 }, { iframeJwtPublicKey: publicKey });

  const savedPub = process.env.IFRAME_JWT_PUBLIC_KEY;
  const savedPriv = process.env.IFRAME_JWT_PRIVATE_KEY;
  try {
    // Mint host-side, where the private key legitimately lives.
    process.env.IFRAME_JWT_PRIVATE_KEY = privateKey;
    const token = platformJwt.signAppIdentityToken({
      appId: 42,
      user: { id: 1, username: 'alice', usernode_pubkey: null, locale: 'en' },
    });

    // Verify as the container would: IFRAME_JWT_PRIVATE_KEY is never set
    // there, and IFRAME_JWT_PUBLIC_KEY is exactly appIdentityEnv's output.
    delete process.env.IFRAME_JWT_PRIVATE_KEY;
    process.env.IFRAME_JWT_PUBLIC_KEY = env.IFRAME_JWT_PUBLIC_KEY;

    const claims = platformJwt.verifyAppIdentityToken(token, { appId: 42 });
    assert.equal(claims.id, 1);
    assert.equal(claims.username, 'alice');
    assert.equal(claims.pur, 'iframe');
  } finally {
    if (savedPub === undefined) delete process.env.IFRAME_JWT_PUBLIC_KEY;
    else process.env.IFRAME_JWT_PUBLIC_KEY = savedPub;
    if (savedPriv === undefined) delete process.env.IFRAME_JWT_PRIVATE_KEY;
    else process.env.IFRAME_JWT_PRIVATE_KEY = savedPriv;
  }
});

// ── 1a-bis. No legacy token authority survives anywhere ─────────────────
//
// platform-jwt.js briefly carried ONE temporary legacy verify+mint path,
// for the window in which a preview container was built by the pre-cutover
// platform and so held the old shared secret but no key material. It was a
// real weakening — bare HS256, no iss/aud/pur — so its REMOVAL belongs in
// this suite rather than only in the staging-auth tests.
//
// The invariant now is stronger than "unreachable": there is no legacy
// signer or verifier in the module at all, and the alias every container
// still receives carries the RSA PUBLIC PEM — which cannot sign. Pin both,
// so re-introducing a shared-secret authority has to be a deliberate,
// visible act rather than a quiet re-export.
test('platform-jwt exposes no legacy shared-secret authority', () => {
  assert.ok(REQUIRED_PROD.includes('IFRAME_JWT_PUBLIC_KEY'),
    'production must not be able to boot without the iframe public key');

  for (const name of [
    'legacyBootstrapActive',
    'verifyLegacyBootstrapToken',
    'signLegacyBootstrapToken',
  ]) {
    assert.equal(platformJwt[name], undefined,
      `platform-jwt must not export ${name}`);
  }

  // Nothing in the module signs or verifies with process.env.JWT_SECRET —
  // the one env var a child container shares with the platform by name.
  const src = fs.readFileSync(
    require.resolve('../src/services/platform-jwt.js'), 'utf8'
  );
  assert.ok(!/process\.env\.JWT_SECRET/.test(src),
    'platform-jwt.js must not read JWT_SECRET at all');
});

// The alias is still injected for pre-cutover app scaffolds, and it must
// hold the PUBLIC PEM — a value that can verify a signature and never
// produce one. That asymmetry is what makes keeping the alias safe.
test('the JWT_SECRET alias carries the public PEM, never a signing key', () => {
  const { publicKey } = keyPair();
  const containerEnv = appIdentityEnv({ id: 42 }, { iframeJwtPublicKey: publicKey });
  assert.ok(containerEnv.IFRAME_JWT_PUBLIC_KEY, 'appIdentityEnv must set the public key');
  assert.ok(containerEnv.USERNODE_APP_ID, 'appIdentityEnv must set the app id');
  assert.equal(containerEnv.JWT_SECRET, containerEnv.USERNODE_JWT_PUBLIC_KEY,
    'the alias must be the public PEM verbatim');
  assert.match(containerEnv.JWT_SECRET, /BEGIN PUBLIC KEY/,
    'and must be a PUBLIC key, so a container cannot mint an identity');
});

// ── 1b. Behavioral: the in-loop browser's app env ───────────────────────

const inLoopBrowser = require('../src/services/in-loop-browser');

test('the in-loop-browser env is clean for every turn mode', () => {
  for (const mode of ['build', 'scout', 'sync', 'unknown-future-mode']) {
    assertNoLeak(`browserEnvForMode(${mode})`, inLoopBrowser.browserEnvForMode(mode));
  }
});

// ── 1c. Behavioral: the platform-defaults bridge ────────────────────────

const appSecrets = require('../src/services/app-secrets');

test('platformDefaultsFromEnv is an allowlist, not a process-env passthrough', () => {
  // This is the one function whose job is to copy values OUT of the
  // platform's process env and INTO a child container's env, so it is the
  // most direct leak vector in the codebase.
  const env = { ...SENTINELS, NODE_RPC_URL: 'https://rpc.example.test' };
  const out = appSecrets.platformDefaultsFromEnv(env);
  assertNoLeak('platformDefaultsFromEnv', out);
  assert.equal(out.NODE_RPC_URL, 'https://rpc.example.test',
    'the allowlisted default still comes through');
});

// A manifest must not be able to declare one of these names either: the
// value would come from the app's own secret store, but the container
// would then hold a variable the platform's own code reads by that name.
test('reserved keys cover the deprecated JWT_SECRET shim and the app-id pair', () => {
  const { RESERVED_KEYS } = require('../src/services/app-manifest');
  for (const k of ['JWT_SECRET', 'USERNODE_JWT_PUBLIC_KEY', 'USERNODE_APP_ID', 'IFRAME_JWT_PUBLIC_KEY']) {
    assert.ok(RESERVED_KEYS.has(k), `${k} must be reserved against manifest shadowing`);
  }
});

// ── 2. Behavioral: the full production env contract ─────────────────────
//
// app-respawn's runExistingImage is the canonical assembly of a production
// app container's env (app-creator and staging.js build the same contract
// around a docker build), and it is also the tool the deploy runbook uses
// to recreate every running container after this cutover. Driving it for
// real exercises all four spreads — appIdentityEnv, llmEnv, storageEnv and
// the merged manifest secrets — against a poisoned config.

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

test('the production app-container env contract leaks nothing', async () => {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
    dbManager: require.resolve('../src/services/db-manager'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    appStorageEnv: require.resolve('../src/services/app-storage-env'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/app-respawn'),
  };
  const saved = {};
  for (const [k, id] of Object.entries(ids)) saved[k] = require.cache[id];

  let captured = null;
  try {
    stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
    stub(ids.docker, {
      stopAndRemove: async () => {},
      runContainer: async (_name, opts) => { captured = opts.env; return 'cid-1'; },
      waitForHealthy: async () => {},
    });
    stub(ids.dbManager, {
      appDbName: (slug) => `usernode_app_${slug}`,
      connectionUrl: (db, pw) => `postgres://usernode_app:${pw}@postgres:5432/${db}`,
    });
    stub(ids.appSecrets, {
      // Hand back the sentinels as if they were legitimately stored, so
      // any builder that forwarded raw stored values wholesale (rather
      // than merge.env) would be caught.
      getRawValues: async () => ({ ...SENTINELS }),
      mergeForDeploy: () => ({ env: { APP_OWN_SECRET: 'fine' }, missingRequired: [] }),
      platformDefaultsFromEnv: () => ({}),
    });
    stub(ids.appLlmEnv, {
      productionLlmEnv: async () => ({
        USERNODE_LLM_PROXY_URL: 'http://usernode:3000/api/internal/anthropic',
        USERNODE_LLM_PROXY_TOKEN: 'llm-token',
      }),
    });
    stub(ids.appStorageEnv, {
      productionStorageEnv: async () => ({
        USERNODE_STORAGE_URL: 'http://usernode:3000/api/internal/storage',
        USERNODE_STORAGE_TOKEN: 'storage-token',
      }),
    });
    stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
    delete require.cache[ids.subject];

    const { runExistingImage } = require('../src/services/app-respawn');
    const runtimeName = await runExistingImage(poisonedConfig(), {
      id: 7, slug: 'demo-app', db_password: 'pw', manifest_snapshot: { secrets: [] },
    });

    // Runtime callers need the deterministic Docker name: it works for
    // Docker lifecycle commands and is resolvable by peer containers,
    // unlike `docker run`'s opaque full ID.
    assert.equal(runtimeName, 'usernode-app-demo-app');
    assert.ok(captured, 'runContainer must have been reached');
    assertNoLeak('runExistingImage env', captured);
    // Sanity: the env really was assembled (an empty object would pass
    // every leak assertion vacuously).
    assert.equal(captured.USERNODE_APP_ID, '7');
    assert.equal(captured.PORT, '3000');
    assert.equal(captured.USERNODE_ENV, 'production');
    assert.match(captured.DATABASE_URL, /^postgres:\/\//);
    assert.equal(captured.USERNODE_LLM_PROXY_TOKEN, 'llm-token');
    assert.equal(captured.USERNODE_STORAGE_TOKEN, 'storage-token');
    assert.equal(captured.APP_OWN_SECRET, 'fine');
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (saved[k]) require.cache[id] = saved[k];
      else delete require.cache[id];
    }
  }
});

// ── 3. Structural: worker.js's container env literals ───────────────────

// Extract a `const <name> = { ... };` object literal's TOP-LEVEL keys and
// spreads. Brace-counting rather than a parser dependency, matching the
// stdlib-only convention of the deploy pins.
function objectLiterals(src, name) {
  const out = [];
  const re = new RegExp(`const ${name} = \\{`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const body = src.slice(start, i - 1);
    // Top-level entries only: blank out nested braces first.
    let flat = body;
    let guard = 0;
    while (/\{[^{}]*\}/.test(flat) && guard++ < 50) flat = flat.replace(/\{[^{}]*\}/g, '_');
    out.push({
      keys: [...flat.matchAll(/^\s*([A-Za-z_][\w]*)\s*:/gm)].map((x) => x[1]),
      spreads: [...flat.matchAll(/\.\.\.([^,\n]+)/g)].map((x) => x[1].trim()),
      body,
    });
  }
  return out;
}

test('worker.js container env literals name no platform key', () => {
  const src = read('src/services/worker.js');
  // Commit 1: there must be NO `secretEnv` object literal at all — every
  // credential/capability is assembled by buildTurnSecretEnv (covered
  // behaviorally in the next test) and injected only on the per-turn exec.
  const secrets = objectLiterals(src, 'secretEnv');
  assert.equal(secrets.length, 0,
    'all secrets must go through buildTurnSecretEnv, not a bootstrap literal');
  // Both safeEnv literals (bootstrap + per-turn) must name no platform key.
  const safe = objectLiterals(src, 'safeEnv');
  assert.ok(safe.length >= 2, 'expected bootstrap and per-turn safeEnv literals');
  for (const lit of safe) {
    for (const k of FORBIDDEN) {
      assert.ok(!lit.keys.includes(k), `worker.js safeEnv sets ${k}`);
    }
  }
});

test('the per-turn worker env forwards only the minted TOKEN, never the signing key', () => {
  // The distinction that makes the worker authority safe: the container
  // gets a short-lived JWT minted from WORKER_JWT_SECRET, not the secret.
  // buildTurnSecretEnv is pure, so this is a real behavioral check across
  // every mode and both the BYOK and platform-key branches.
  const worker = require('../src/services/worker');
  for (const mode of ['build', 'scout', 'sync']) {
    for (const anthropicApiKey of [null, 'sk-ant-byok-fixture']) {
      const env = worker.buildTurnSecretEnv({
        mode,
        workerSessionJwt: 'minted.worker.jwt',
        issuesReadJwt: 'minted.issues.jwt',
        anthropicProxyJwt: 'minted.anthropic-proxy.jwt',
        anthropicApiKey,
        prodDebugJwt: 'minted.proddebug.jwt',
      });
      assertNoLeak(`buildTurnSecretEnv(${mode}, byok=${!!anthropicApiKey})`, env);
      for (const v of Object.values(env)) {
        assert.ok(!Object.values(SENTINELS).includes(v));
      }
    }
  }
  // Sanity: the token really is what travels, so the check above is not
  // passing on an empty env.
  const build = require('../src/services/worker').buildTurnSecretEnv({
    mode: 'build', workerSessionJwt: 'minted.worker.jwt', issuesReadJwt: 'minted.issues.jwt',
    anthropicProxyJwt: 'minted.anthropic-proxy.jwt', anthropicApiKey: null, prodDebugJwt: null,
  });
  assert.equal(build.WORKER_JWT, 'minted.worker.jwt');
  assert.ok(!('WORKER_JWT_SECRET' in build));
});

// The docker CLI child inherits the whole platform process env (so bare
// `-e KEY` can pick secrets up out of argv's reach). That is only safe
// because a value crosses into the container ONLY when a bare `-e KEY`
// arg names it — which means the `-e` arg lists are the real boundary.
test('worker.js bare -e args come only from the secretEnv literals', () => {
  const src = read('src/services/worker.js');
  assert.match(src, /Object\.keys\(secretEnv\)\.flatMap\(\(k\) => \['-e', k\]\)/,
    'bare -e args are derived from secretEnv, so the key check above is the boundary');
  // Any hand-written bare `-e 'NAME'` outside that derivation is checked
  // directly. (PAT/BRANCH on the push proxy are the legitimate ones.)
  for (const [, name] of src.matchAll(/'-e',\s*'([A-Z][A-Z0-9_]*)'/g)) {
    assert.ok(!FORBIDDEN.includes(name), `worker.js forwards ${name} into a container`);
  }
});

// ── 4. Name grep across every container-env builder ────────────────────

// Strip comments so a doc block that *names* a forbidden key (this is the
// normal way to explain why it's absent — see app-identity-env.js) doesn't
// read as a leak.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Every module that assembles env for something outside the platform
// process. app-identity-env.js is included because it is the one place
// that legitimately reads a platform key name for this purpose.
const BUILDERS = [
  'src/services/app-identity-env.js',
  // #851: the platform-owned half of the staging container env moved here,
  // so it is a container-env builder and gets the same scrutiny.
  'src/services/staging-env.js',
  'src/services/app-creator.js',
  'src/services/staging.js',
  'src/services/app-respawn.js',
  'src/routes/sessions.js',
  'src/services/worker.js',
  'src/services/in-loop-browser.js',
];

test('no container-env builder mentions a host-only platform key in code', () => {
  for (const rel of BUILDERS) {
    const code = stripComments(read(rel));
    for (const k of FORBIDDEN) {
      assert.ok(!code.includes(k),
        `${rel} references ${k} outside a comment — a container env builder `
        + `must never name a host-only key (config.dataEncryptionKey for `
        + `decrypting stored secrets is fine; the ENV NAME is not)`);
    }
  }
});

test('all five app-container env builders go through the shared helper', () => {
  // Drift between the five builders is the historical failure mode this
  // helper exists to prevent; if one stops using it, the leak checks
  // above stop covering that builder's identity env.
  //
  // #851 moved ONE of the six spreads behind a second helper: staging.js's
  // preview path now spreads staging-env.platformStagingEnv, which spreads
  // appIdentityEnv itself (so the same env can be fingerprinted into a
  // container label). staging.js therefore has one direct spread left — the
  // production rebuild — and the preview half is covered via staging-env.js.
  const expected = {
    'src/services/app-creator.js': 1,
    'src/services/staging.js': 1,
    'src/services/staging-env.js': 1,
    'src/services/app-respawn.js': 1,
    'src/routes/sessions.js': 1,
  };
  for (const [rel, count] of Object.entries(expected)) {
    const code = stripComments(read(rel));
    const uses = (code.match(/\.\.\.appIdentityEnv\(/g) || []).length;
    assert.equal(uses, count, `${rel} must spread appIdentityEnv ${count}×`);
    assert.match(code, /require\((?:'|")[^'"]*app-identity-env(?:'|")\)/,
      `${rel} must require the shared helper`);
  }

  // The indirection must actually BE the staging path — if staging.js stopped
  // calling platformStagingEnv, its preview containers would silently lose
  // both the identity trio and the fingerprint label.
  const stagingCode = stripComments(read('src/services/staging.js'));
  assert.match(stagingCode, /platformStagingEnv\(/,
    'staging.js must build its preview env through staging-env.platformStagingEnv');
});

// ── 5. Container LABELS are as constrained as container env ─────────────
//
// #851 gave runContainer a `labels` option. Labels are readable by anything
// that can run `docker inspect`, so they are exactly as exposed as env — more
// so, since they survive on a stopped container. The fingerprint label is a
// one-way digest by construction; this pins that it stays one.

test('the staging container label carries a digest, never a platform value', () => {
  const stagingEnv = require('../src/services/staging-env');
  const config = poisonedConfig();
  const env = stagingEnv.platformStagingEnv({ id: 7 }, config);
  const label = stagingEnv.envFingerprint(env);

  assert.match(label, /^[0-9a-f]{16}$/, 'the label value is a truncated hex digest');
  // Nothing forbidden is even in the input...
  assertNoLeak('platformStagingEnv', env);
  // ...and no input value (forbidden or not) survives into the label.
  for (const value of Object.values(env)) {
    if (!value || String(value).length < 8) continue;
    const v = String(value);
    for (let i = 0; i + 8 <= v.length; i++) {
      assert.ok(!label.includes(v.slice(i, i + 8)),
        'a container label must not contain any fragment of an injected value');
    }
  }
  for (const k of FORBIDDEN) {
    assert.ok(!label.includes(SENTINELS[k]), `the label leaks ${k}`);
  }
});

test('staging.js labels its preview containers with the fingerprint only', () => {
  const code = stripComments(read('src/services/staging.js'));
  // The `labels:` object handed to runContainer must reference the digest
  // helper, not interpolate env values.
  const labelBlock = code.match(/labels:\s*\{[^}]*\}/);
  assert.ok(labelBlock, 'staging.js must pass a labels object to runContainer');
  assert.match(labelBlock[0], /envFingerprint\(/,
    'the label value must be the digest, not a raw value');
  for (const k of FORBIDDEN) {
    assert.ok(!labelBlock[0].includes(k), `the label block references ${k}`);
  }
});
