// Leading/trailing whitespace is trimmed off a platform-variable or
// app-secret value at every WRITE boundary.
//
// Why this exists. A value pasted into the secrets panel with a stray space
// used to be stored verbatim, and nothing surfaced it: a private value shows
// only "set", a non-private one renders as plain text where a leading space
// is invisible, the .env line the deploy writes is single-quoted so the space
// round-trips perfectly, and the failure finally lands inside whatever third
// party the value was for — hours later, with no error of ours to go on.
// That happened for real: a GitHub OAuth client id stored with a leading
// space made the Connect-GitHub redirect serve GitHub's own 404 page,
// because URLSearchParams form-encodes the space into the `client_id`.
//
// The fix is normalization at write time only — no migration of existing
// rows, no change to how values are encrypted, decrypted or injected.
// tests/platform-env-store.test.js covers the platform-env DAO in depth;
// this file covers the OTHER store (app_secrets) and the property that is
// easiest to lose: every one of the four write routes normalizes BEFORE its
// own validation, and the `secret_change` proposal normalizes at CREATION,
// which is the only boundary that covers the child-app apply branch (it
// writes app_secrets with raw SQL and never reaches appSecrets.setValue).
//
// Route coverage is text-pinned, in the style of
// tests/platform-env-admin.test.js and tests/secret-declaration-route.test.js:
// the route modules pull in express and pg, so instantiating them here would
// cost more than it proves, while the ordering property is plainly visible
// in the source and cheap to break.
//
// Run with: node --test tests/secret-value-normalization.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSecrets = require('../src/services/app-secrets');
const platformEnv = require('../src/services/platform-env');
const pendingSecrets = require('../src/services/pending-secrets');
const { encrypt, decrypt } = require('../src/services/secrets');

const root = path.join(__dirname, '..');
const appsJs = fs.readFileSync(path.join(root, 'src/routes/apps.js'), 'utf8');
const issuesJs = fs.readFileSync(path.join(root, 'src/routes/issues.js'), 'utf8');

const SECRET = 'test-data-key-for-secret-normalization';

function mockPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 1 }], rowCount: 0 };
    },
  };
}
const find = (pool, re) => pool.calls.filter((c) => re.test(c.sql));

// Slice one function/handler out of a route file by brace matching, so an
// ordering assertion can't be satisfied by a match somewhere else entirely.
function block(src, startRe) {
  const at = src.search(startRe);
  assert.ok(at >= 0, `could not locate ${startRe}`);
  // Find where the BODY starts. Two shapes appear here: a plain
  // `function name(args) {`, whose body follows the balanced close of the
  // parameter list (so a default like `options = {}` isn't mistaken for the
  // body brace), and a `router.put('/p', mw, async (req, res) => {`, whose
  // body follows the arrow. Whichever lands first is the real one.
  let i = src.indexOf('(', at);
  let parens = 0;
  let sigClose = src.length;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '(') parens += 1;
    else if (src[j] === ')') {
      parens -= 1;
      if (parens === 0) { sigClose = j + 1; break; }
    }
  }
  const arrow = src.indexOf('=>', at);
  i = Math.min(sigClose, arrow >= 0 ? arrow : src.length);
  let depth = 0;
  i = src.indexOf('{', i);
  const open = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

// ── the app_secrets DAO ───────────────────────────────────────────────

test('app-secrets normalizeValue trims the ends and nothing else', () => {
  assert.equal(appSecrets.normalizeValue(' sk_live_abc '), 'sk_live_abc');
  assert.equal(appSecrets.normalizeValue('\n sk_live_abc \t'), 'sk_live_abc');
  assert.equal(appSecrets.normalizeValue('a b  c'), 'a b  c',
    'interior whitespace is preserved, never collapsed');
  assert.equal(appSecrets.normalizeValue('\nline one\nline two\n'), 'line one\nline two',
    'interior newlines survive; only the outer ones are cut');
  assert.equal(appSecrets.normalizeValue('   '), '',
    'a whitespace-only value collapses to empty and is then refused');
});

test('app-secrets normalizeValue passes non-strings through untouched', () => {
  // So setValue's own type guard keeps producing its own error instead of
  // throwing on null.trim().
  for (const v of [null, undefined, 42, {}]) {
    assert.equal(appSecrets.normalizeValue(v), v);
  }
});

test('the two DAOs agree, so which one a caller reaches cannot matter', () => {
  for (const v of [' a ', 'a', '\ta\n', 'a b', '\nx\ny\n', '   ']) {
    assert.equal(appSecrets.normalizeValue(v), platformEnv.normalizeValue(v), JSON.stringify(v));
  }
});

test('appSecrets.setValue normalizes before it encrypts', async () => {
  const pool = mockPool();
  await appSecrets.setValue(pool, 7, 'STRIPE_PUBLISHABLE', '  pk_live_xyz  ', {
    sensitive: false, userId: 3, dataKey: SECRET,
  });
  const [insert] = find(pool, /INSERT INTO app_secrets/);
  assert.ok(insert, 'the upsert ran');
  assert.equal(decrypt(insert.params[2], SECRET), 'pk_live_xyz',
    'the ciphertext must decrypt to the trimmed value, not the pasted one');
  assert.equal(insert.params[3], '_xyz',
    'the last-4 preview comes from the trimmed value, so the panel cannot '
    + 'disagree with what was stored');
  assert.ok(!insert.params.includes('  pk_live_xyz  '),
    'the padded plaintext is never a bound parameter');
});

test('appSecrets.setValue refuses a whitespace-only value', async () => {
  const pool = mockPool();
  await assert.rejects(
    () => appSecrets.setValue(pool, 7, 'SOME_KEY', '   ', { dataKey: SECRET }),
    /non-empty/
  );
  assert.equal(find(pool, /INSERT INTO app_secrets/).length, 0,
    'nothing is written — previously this stored a value that was never useful');
});

test('appSecrets.setValue trimming is idempotent, so re-saving is safe', async () => {
  const poolA = mockPool();
  const poolB = mockPool();
  await appSecrets.setValue(poolA, 7, 'K', ' v ', { dataKey: SECRET });
  await appSecrets.setValue(poolB, 7, 'K', 'v', { dataKey: SECRET });
  const a = find(poolA, /INSERT INTO app_secrets/)[0];
  const b = find(poolB, /INSERT INTO app_secrets/)[0];
  assert.equal(decrypt(a.params[2], SECRET), decrypt(b.params[2], SECRET));
  assert.equal(a.params[3], b.params[3]);
});

// ── the held value on a declaration proposal ──────────────────────────

test('a held pending value is normalized before it is encrypted', async () => {
  const pool = mockPool();
  await pendingSecrets.create(pool, {
    appId: 7, sessionId: 11, scope: 'app', key: 'SOME_KEY',
    declaration: { description: 'x', private: false },
    value: '  held-value  ', dataKey: SECRET,
  });
  const [insert] = find(pool, /INSERT INTO pending_secret_declarations/);
  assert.ok(insert, 'the pending row was written');
  assert.equal(decrypt(insert.params[5], SECRET), 'held-value',
    'the value waiting for the merge is already trimmed, so the panel row '
    + 'and the eventual write agree');
  assert.equal(insert.params[6], 'alue', 'the held last-4 matches the trimmed value');
});

test('a whitespace-only held value is not held at all', async () => {
  const pool = mockPool();
  await pendingSecrets.create(pool, {
    appId: 7, sessionId: 11, scope: 'app', key: 'SOME_KEY',
    declaration: { description: 'x' },
    value: '   ', dataKey: SECRET,
  });
  const [insert] = find(pool, /INSERT INTO pending_secret_declarations/);
  assert.equal(insert.params[5], null,
    'it collapses to empty, so the row is declaration-only rather than '
    + 'carrying a value that would be refused on apply');
});

// ── the vote path: normalization happens at CREATION ──────────────────

test('secret_change normalizes the value before validating, encrypting or previewing it', () => {
  const src = issuesJs;
  const norm = src.indexOf('platformEnv.normalizeValue(');
  const validate = src.indexOf('platformEnv.validateValue(value)');
  const enc = src.indexOf("const valueEnc = action === 'set' ? encrypt(value");
  const last4 = src.indexOf('? value.slice(-4)');

  assert.ok(norm > 0, 'the creation handler normalizes the incoming value');
  assert.ok(validate > norm,
    'normalize first: otherwise a padded value is length-checked and '
    + '.env-representability-checked in its padded form');
  assert.ok(enc > norm,
    'normalize before encrypt, or the ciphertext the proposal carries is the padded value');
  assert.ok(last4 > norm,
    "normalize before the last-4, or the proposal card's preview shows padding "
    + 'that the applied value will not have');
});

test('creation is the boundary that covers the child-app apply branch', () => {
  // The self-hosted branch of maybeApplySecretChangeProposal goes through
  // platformEnv.setValue (which normalizes again), but the child-app branch
  // writes app_secrets with RAW SQL and never touches appSecrets.setValue.
  // So if creation did not normalize, nothing would.
  const apply = block(issuesJs, /async function maybeApplySecretChangeProposal/);
  assert.match(apply, /INSERT INTO app_secrets/,
    'the child-app branch still writes raw SQL — pinned so a future refactor '
    + 'that routes it through the DAO makes someone re-read this test');
  assert.match(apply, /platformEnv\.setValue\(client, issue\.app_id, key, plaintext/,
    'the self-hosted branch goes through the DAO');
  assert.doesNotMatch(apply, /normalizeValue/,
    'deliberately NOT normalized at apply: the plaintext here comes from a '
    + 'payload whose last-4 was computed at creation, so trimming here would '
    + 'reintroduce the display/storage mismatch that creation-time trimming avoids');
});

test('a padded proposal value round-trips to a trimmed stored value', () => {
  // Mirrors the real pipeline: creation normalizes, encrypts and previews;
  // apply decrypts and re-encrypts with a fresh IV. Both branches of apply
  // write whatever `plaintext` holds, so proving it is trimmed proves the
  // raw-SQL branch stores a trimmed value too.
  const pasted = '  Ov23liAbCd  ';
  const value = platformEnv.normalizeValue(pasted);
  assert.equal(platformEnv.validateValue(value), null);

  const payload = {
    valueEnc: encrypt(value, SECRET),
    valueLast4: value.slice(-4),
  };
  const plaintext = decrypt(payload.valueEnc, SECRET);
  assert.equal(plaintext, 'Ov23liAbCd', 'what the apply path writes is trimmed');
  assert.equal(payload.valueLast4, plaintext.slice(-4),
    "the proposal card's preview and the applied value agree");
});

// ── the four write routes ─────────────────────────────────────────────

test('setPlatformVariable normalizes before its own validation', () => {
  const src = block(appsJs, /async function setPlatformVariable\(req, res, app\)/);
  assert.match(src, /platformEnv\.normalizeValue\(/);
  assert.ok(src.indexOf('platformEnv.normalizeValue(') < src.indexOf('platformEnv.validateValue(value)'),
    'normalize first, so a whitespace-only value is a 400 from the route '
    + 'rather than a throw from setValue caught into a 500');
  assert.ok(src.indexOf('platformEnv.normalizeValue(') < src.indexOf('platformEnv.setValue('));
});

test('PUT /secrets/:key normalizes before the emptiness check', () => {
  const src = block(appsJs, /router\.put\('\/api\/apps\/:slug\/secrets\/:key'/);
  assert.match(src, /appSecrets\.normalizeValue\(/);
  assert.ok(src.indexOf('appSecrets.normalizeValue(') < src.indexOf('if (!value.length)'),
    'otherwise a whitespace-only value passes this gate and throws inside '
    + 'appSecrets.setValue, which the catch turns into a 500');
});

test('the declare route normalizes before every value rule it enforces', () => {
  const src = block(appsJs, /router\.post\('\/api\/apps\/:slug\/secret-declaration-pr'/);
  const norm = src.indexOf('platformEnv.normalizeValue(');
  assert.ok(norm > 0);
  assert.ok(norm < src.indexOf('value.length > MAX_DECLARED_VALUE_LENGTH'),
    'the length cap sees the trimmed value');
  assert.ok(norm < src.indexOf('required && !value.length && !defaultValue'),
    'a value of only spaces must not satisfy "a required variable needs a value"');
  assert.ok(norm < src.indexOf('platformEnv.validateValue(value)'),
    '.env representability is checked on the value that will actually be stored');
});

test('every route normalizes the value, none is left out', () => {
  // The four write surfaces, per the spec's write-path table. A fifth one
  // appearing without a normalize call is the regression this guards.
  const surfaces = [
    ['setPlatformVariable', block(appsJs, /async function setPlatformVariable\(req, res, app\)/)],
    ['PUT /secrets/:key', block(appsJs, /router\.put\('\/api\/apps\/:slug\/secrets\/:key'/)],
    ['secret-declaration-pr', block(appsJs, /router\.post\('\/api\/apps\/:slug\/secret-declaration-pr'/)],
  ];
  for (const [name, src] of surfaces) {
    assert.match(src, /normalizeValue\(/, `${name}: normalizes the incoming value`);
  }
  assert.match(issuesJs, /platformEnv\.normalizeValue\(/, 'secret_change creation');
});

// ── scope: what this change must NOT have touched ─────────────────────

test('the encryption helper is untouched — it is on the self-edit risk list', () => {
  const secretsJs = fs.readFileSync(path.join(root, 'src/services/secrets.js'), 'utf8');
  assert.doesNotMatch(secretsJs, /trim\(\)/,
    'normalization is not an encryption concern, and secrets.js also encrypts '
    + 'BYOK Anthropic keys; SELF-HOSTING.md puts this file behind allow_risky');
  assert.match(secretsJs, /const VERSION = 'v1'/, 'the envelope version is unchanged');
  assert.match(secretsJs, /const IV_LEN = 12/, 'the IV length is unchanged');
});

test('validateValue stays pure, because the deploy read path calls it', () => {
  // scripts/dump-platform-env.js re-runs validateValue when resolving stored
  // values into .env. A validator that trimmed there would be a surprise —
  // and, worse, would quietly "fix" a legacy padded row at deploy time
  // instead of leaving existing values exactly as they are.
  assert.equal(platformEnv.validateValue(' padded '), null,
    'validateValue does not trim and does not reject padding on its own');
  const dump = fs.readFileSync(path.join(root, 'scripts/dump-platform-env.js'), 'utf8');
  assert.match(dump, /platformEnv\.validateValue\(values\[key\]\)/,
    'the deploy path still validates, unchanged');
  assert.doesNotMatch(dump, /normalizeValue/,
    'no migration of existing rows: the deploy emits stored values verbatim');
});

test('the DAOs stay segregated — no new require between them', () => {
  const appSecretsSrc = fs.readFileSync(path.join(root, 'src/services/app-secrets.js'), 'utf8');
  const platformEnvSrc = fs.readFileSync(path.join(root, 'src/services/platform-env.js'), 'utf8');
  assert.doesNotMatch(appSecretsSrc, /require\('\.\/platform-env'\)/,
    'the two-line rule is duplicated (like computeLast4) rather than shared, '
    + 'so the deploy paths cannot become entangled');
  assert.doesNotMatch(platformEnvSrc, /require\('\.\/app-secrets'\)/);
});
