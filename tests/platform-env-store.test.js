// Tests for src/services/platform-env.js — the DAO behind the admin
// console's Platform variables section and the deploy-time resolver.
//
// Three properties carry the security weight of this feature, and each
// has a test below that fails loudly if it regresses:
//
//  1. UNWRITABLE KEYS ARE UNWRITABLE. Not "hidden in the UI" — refused
//     at the DAO, so a hand-rolled PUT for JWT_SECRET cannot land a row,
//     and a row that somehow exists is never resolved into .env.
//  2. A PRIVATE VALUE NEVER COMES BACK OUT. listView returns null for
//     it, and no last-4 is stored, so there is nothing to leak even by
//     accident.
//  3. AN ADMIN CANNOT DOWNGRADE PRIVACY. `private` comes from the
//     declaration, never from the request body.
//
// Plus the .env representability rule: a value containing a single
// quote cannot be written into the single-quoted .env line the deploy
// produces, so it is rejected at save time rather than silently dropped
// by a deploy hours later.
//
// Run with: node --test tests/platform-env-store.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const platformEnv = require('../src/services/platform-env');
const { encrypt } = require('../src/services/secrets');

const SECRET = 'test-jwt-secret-for-platform-env';

function mockPool({ declarations = [], values = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FULL OUTER JOIN platform_env_values/.test(sql)) {
        return { rows: joined(declarations, values) };
      }
      if (/SELECT private FROM platform_env_declarations/.test(sql)) {
        const d = declarations.find((x) => x.key === params[1]);
        return { rows: d ? [{ private: !!d.private }] : [] };
      }
      if (/SELECT key, value_enc FROM platform_env_values/.test(sql)) {
        return { rows: values.map((v) => ({ key: v.key, value_enc: v.value_enc })) };
      }
      if (/FROM platform_env_declarations d/.test(sql)) {
        const set = new Set(values.map((v) => v.key));
        return {
          rows: declarations
            .filter((d) => d.required && !d.unwritable && !set.has(d.key))
            .map((d) => ({ key: d.key, description: d.description || '' })),
        };
      }
      if (/DELETE FROM platform_env_values/.test(sql)) {
        return { rowCount: values.some((v) => v.key === params[1]) ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Reproduce the FULL OUTER JOIN shape the real query returns.
function joined(declarations, values) {
  const keys = [...new Set([...declarations.map((d) => d.key), ...values.map((v) => v.key)])].sort();
  return keys.map((key) => {
    const d = declarations.find((x) => x.key === key) || null;
    const v = values.find((x) => x.key === key) || null;
    return {
      key,
      declared: !!d,
      has_value: !!v,
      description: d?.description || '',
      required: !!d?.required,
      private: d ? !!d.private : !!v?.private,
      grouping: d?.grouping || 'Undeclared',
      default_value: d?.default_value ?? null,
      unwritable: !!d?.unwritable,
      value_enc: v?.value_enc || null,
      value_last4: v?.value_last4 || null,
      updated_at: v?.updated_at || null,
      updated_by_username: v?.updated_by_username || null,
    };
  });
}

const stored = (key, plaintext, extra = {}) => ({
  key, value_enc: encrypt(plaintext, SECRET), ...extra,
});
const find = (pool, re) => pool.calls.filter((c) => re.test(c.sql));

// ── isWritableKey ─────────────────────────────────────────────────────

test('ordinary tunables are writable', () => {
  for (const key of ['LOG_LEVEL', 'MAX_USER_SESSIONS', 'SOME_NEW_FLAG']) {
    assert.equal(platformEnv.isWritableKey(key), true, key);
  }
});

test('credential and deploy-owned keys are refused', () => {
  for (const key of [
    'JWT_SECRET', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'USERNODE_DB_PASSWORD',
    'GITHUB_PRIVATE_KEY', 'GITHUB_BOT_TOKEN', 'ANTHROPIC_API_KEY',
    'USERNODE_APP_SECRET_KEY', 'ZEROSSL_API_KEY', 'ACME_DNS_API_TOKEN',
    'DATABASE_URL', 'PORT', 'GIT_SHA', 'USERNODE_ENV', 'USERNODE_DOMAIN',
  ]) {
    assert.equal(platformEnv.isWritableKey(key), false, `${key} must never be settable from the console`);
  }
});

test('reserved prefixes and malformed keys are refused', () => {
  for (const key of ['USERNODE_LLM_PROXY_URL', 'USERNODE_STORAGE_BUCKET',
    'lowercase', '9LEADING', 'HAS-DASH', '', null, undefined, 42]) {
    assert.equal(platformEnv.isWritableKey(key), false, String(key));
  }
});

// ── validateValue ─────────────────────────────────────────────────────

test('a single quote is rejected — it cannot survive the .env line', () => {
  const err = platformEnv.validateValue("it's fine");
  assert.ok(err, 'must be rejected');
  assert.match(err, /single quote/, 'and the error must say why');
});

test('a carriage return is rejected; an ordinary newline is not', () => {
  assert.ok(platformEnv.validateValue('a\r\nb'));
  assert.equal(platformEnv.validateValue('line one\nline two'), null,
    'multi-line values work — GITHUB_PRIVATE_KEY is one');
});

test('empty, non-string and over-long values are rejected', () => {
  assert.ok(platformEnv.validateValue(''));
  assert.ok(platformEnv.validateValue(null));
  assert.ok(platformEnv.validateValue(7));
  assert.ok(platformEnv.validateValue('x'.repeat(platformEnv.MAX_VALUE_LEN + 1)));
  assert.equal(platformEnv.validateValue('x'.repeat(platformEnv.MAX_VALUE_LEN)), null);
});

test('ordinary values with spaces, quotes and $ signs pass', () => {
  for (const v of ['75', 'a value with spaces', 'say "hi"', 'costs $5', 'a\\b']) {
    assert.equal(platformEnv.validateValue(v), null, v);
  }
});

// ── computeLast4 ──────────────────────────────────────────────────────

test('no last-4 is kept for a private value', () => {
  assert.equal(platformEnv.computeLast4('supersecret', true), null,
    'four characters of a token is four characters of a token');
  assert.equal(platformEnv.computeLast4('supersecret', false), 'cret');
});

// ── listView ──────────────────────────────────────────────────────────

test('listView classifies every row into one of the four states', async () => {
  const pool = mockPool({
    declarations: [
      { key: 'SET_ONE', grouping: 'Scaling' },
      { key: 'UNSET_ONE', required: true, grouping: 'Scaling' },
      { key: 'MANAGED_ONE', unwritable: true, grouping: 'Managed by the deploy' },
    ],
    values: [stored('SET_ONE', '75', { value_last4: '  75' }), stored('ORPHAN_ONE', 'leftover')],
  });
  const rows = await platformEnv.listView(pool, 1, SECRET);
  const state = Object.fromEntries(rows.map((r) => [r.key, r.state]));
  assert.deepEqual(state, {
    SET_ONE: 'set',
    UNSET_ONE: 'unset',
    MANAGED_ONE: 'managed',
    ORPHAN_ONE: 'orphan',
  });
});

test('listView returns the plaintext of a non-private value', async () => {
  const pool = mockPool({
    declarations: [{ key: 'MAX_USER_SESSIONS', private: false }],
    values: [stored('MAX_USER_SESSIONS', '9')],
  });
  const [row] = await platformEnv.listView(pool, 1, SECRET);
  assert.equal(row.value, '9',
    'answering "what is it actually set to in prod?" is the point of non-private');
});

test('listView never returns the plaintext of a private value', async () => {
  const pool = mockPool({
    declarations: [{ key: 'SOME_TOKEN', private: true }],
    values: [stored('SOME_TOKEN', 'sk-live-do-not-leak')],
  });
  const [row] = await platformEnv.listView(pool, 1, SECRET);
  assert.equal(row.value, null);
  assert.equal(row.private, true);
  assert.ok(!JSON.stringify(row).includes('do-not-leak'),
    'no field of the serialized row may carry the plaintext');
});

test('listView degrades rather than throwing when a value will not decrypt', async () => {
  const pool = mockPool({
    declarations: [{ key: 'BROKEN_ONE' }],
    values: [{ key: 'BROKEN_ONE', value_enc: 'v1:not:valid:ciphertext' }],
  });
  const [row] = await platformEnv.listView(pool, 1, SECRET);
  assert.equal(row.value, null);
  assert.equal(row.hasValue, true, 'the row is still "set" — just unreadable');
});

test('an undeclared value is reported as an orphan, not hidden', async () => {
  const pool = mockPool({ values: [stored('REMOVED_LAST_WEEK', 'still here')] });
  const [row] = await platformEnv.listView(pool, 1, SECRET);
  assert.equal(row.state, 'orphan');
  assert.equal(row.declared, false);
});

// ── getRawValues (the deploy path) ────────────────────────────────────

test('getRawValues decrypts writable values', async () => {
  const pool = mockPool({ values: [stored('LOG_LEVEL', 'DEBUG'), stored('DB_POOL_MAX', '80')] });
  assert.deepEqual(await platformEnv.getRawValues(pool, 1, SECRET),
    { LOG_LEVEL: 'DEBUG', DB_POOL_MAX: '80' });
});

test('getRawValues refuses an unwritable key even if a row exists', async () => {
  const pool = mockPool({ values: [stored('JWT_SECRET', 'planted-by-hand'), stored('LOG_LEVEL', 'WARN')] });
  const out = await platformEnv.getRawValues(pool, 1, SECRET);
  assert.deepEqual(out, { LOG_LEVEL: 'WARN' },
    'a row planted by a direct DB write must never override the GitHub-sourced .env line');
});

test('getRawValues skips a value it cannot decrypt instead of emitting garbage', async () => {
  const pool = mockPool({ values: [{ key: 'LOG_LEVEL', value_enc: 'nonsense' }] });
  assert.deepEqual(await platformEnv.getRawValues(pool, 1, SECRET), {});
});

// ── missingRequired (the merge gate's input) ──────────────────────────

test('missingRequired lists required declarations with no value', async () => {
  const pool = mockPool({
    declarations: [
      { key: 'NEEDED', required: true, description: 'why it matters' },
      { key: 'ALSO_NEEDED', required: true },
      { key: 'OPTIONAL_ONE' },
      { key: 'DEPLOY_OWNED', required: true, unwritable: true },
    ],
    values: [stored('ALSO_NEEDED', 'x')],
  });
  const missing = await platformEnv.missingRequired(pool, 1);
  assert.deepEqual(missing.map((m) => m.key), ['NEEDED'],
    'a required-but-deploy-owned key is not something an admin could set, so it never blocks');
  assert.equal(missing[0].description, 'why it matters');
});

// ── setValue / deleteValue ────────────────────────────────────────────

test('setValue throws for an unwritable key', async () => {
  const pool = mockPool();
  await assert.rejects(
    () => platformEnv.setValue(pool, 1, 'JWT_SECRET', 'nope', { dataKey: SECRET }),
    /not writable/
  );
  assert.equal(find(pool, /INSERT INTO platform_env_values/).length, 0);
});

test('setValue enforces the same value rules as validateValue', async () => {
  const pool = mockPool();
  await assert.rejects(() => platformEnv.setValue(pool, 1, 'LOG_LEVEL', '', { dataKey: SECRET }));
  await assert.rejects(() => platformEnv.setValue(pool, 1, 'LOG_LEVEL', "it's", { dataKey: SECRET }),
    /single quote/);
});

test('setValue stores ciphertext, never plaintext', async () => {
  const pool = mockPool({ declarations: [{ key: 'LOG_LEVEL', private: false }] });
  await platformEnv.setValue(pool, 1, 'LOG_LEVEL', 'DEBUG', { userId: 3, dataKey: SECRET });
  const [insert] = find(pool, /INSERT INTO platform_env_values/);
  assert.ok(insert, 'the upsert ran');
  assert.ok(!insert.params.includes('DEBUG'), 'the plaintext must not be a bound parameter');
  assert.match(insert.params[2], /^v1:/, 'the stored blob is the versioned AES envelope');
  assert.equal(insert.params[3], 'EBUG', 'a non-private value keeps a last-4 preview');
  assert.equal(insert.params[5], 3, 'the setter is recorded');
});

test('privacy comes from the declaration, not the caller', async () => {
  const pool = mockPool({ declarations: [{ key: 'SOME_TOKEN', private: true }] });
  const result = await platformEnv.setValue(pool, 1, 'SOME_TOKEN', 'sk-live-xyz', { dataKey: SECRET });
  assert.equal(result.private, true);
  const [insert] = find(pool, /INSERT INTO platform_env_values/);
  assert.equal(insert.params[3], null, 'a private value stores no last-4');
  assert.equal(insert.params[4], true);
});

test('an undeclared key defaults to private', async () => {
  const pool = mockPool();
  const result = await platformEnv.setValue(pool, 1, 'BRAND_NEW_KEY', 'value', { dataKey: SECRET });
  assert.equal(result.private, true,
    'setting a value before the declaring proposal merges is legitimate; '
    + 'the safe default for an unknown variable is "do not display it"');
});

test('deleteValue reports whether anything was removed', async () => {
  const pool = mockPool({ values: [stored('LOG_LEVEL', 'DEBUG')] });
  assert.equal(await platformEnv.deleteValue(pool, 1, 'LOG_LEVEL'), true);
  assert.equal(await platformEnv.deleteValue(pool, 1, 'NEVER_SET'), false);
  assert.equal(find(pool, /DELETE FROM platform_env_declarations/).length, 0,
    'clearing a value must leave the declaration in place');
});
