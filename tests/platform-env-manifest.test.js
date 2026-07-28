// Tests for the dapp.json `platform_env` block and its deploy-time
// reconcile — readPlatformEnv / reconcilePlatformEnv in
// src/services/app-manifest.js. Mirrors tests/app-manifest-admins.test.js.
//
// The semantics worth pinning here:
//
//  - A key on the unwritable list is NOT rejected, unlike a reserved key
//    in the `secrets` block. It parses, and carries unwritable:true, so
//    the admin console can render "DATABASE_URL — set by the deploy" as
//    documentation instead of the variable simply not existing.
//  - `platform_env` and `secrets` are disjoint. A key in both is dropped
//    from `secrets`, so there is exactly one owner of any given name and
//    no chance of a platform variable leaking into a child dapp's
//    container env through mergeForDeploy.
//  - reconcilePlatformEnv deletes DECLARATIONS that leave the manifest
//    but never VALUES. A rollback past the commit that declared a
//    variable must not destroy its configuration.
//
// Run with: node --test tests/platform-env-manifest.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-platform-env-'));
  try {
    if (content != null) {
      fs.writeFileSync(path.join(dir, 'dapp.json'),
        typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(appManifest.read(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (entries) => appManifest.readPlatformEnv({ platform_env: entries });

// ── Parsing matrix ────────────────────────────────────────────────────

test('absent, empty and malformed blocks all resolve to []', () => {
  for (const parsed of [{}, { platform_env: null }, { platform_env: [] },
    { platform_env: 'MAX_USER_SESSIONS' }, { platform_env: {} }, null, undefined]) {
    assert.deepEqual(appManifest.readPlatformEnv(parsed), [],
      'a missing or unusable block is emptiness, never a throw');
  }
});

test('a valid entry keeps its declared fields', () => {
  const [entry] = read([{
    key: 'MAX_USER_SESSIONS',
    description: 'Per-user session cap.',
    required: true,
    private: false,
    group: 'Scaling',
    default: '3',
  }]);
  assert.equal(entry.key, 'MAX_USER_SESSIONS');
  assert.equal(entry.description, 'Per-user session cap.');
  assert.equal(entry.required, true);
  assert.equal(entry.private, false);
  assert.equal(entry.group, 'Scaling');
  assert.equal(entry.default, '3');
  assert.equal(entry.unwritable, false);
});

test('group defaults to General and required/private default to false', () => {
  const [entry] = read([{ key: 'SOME_TUNABLE' }]);
  assert.equal(entry.group, 'General');
  assert.equal(entry.required, false);
  assert.equal(entry.private, false);
});

test('`sensitive` is accepted as an alias for `private`', () => {
  const [entry] = read([{ key: 'SOME_TOKEN', sensitive: true }]);
  assert.equal(entry.private, true);
});

test('keys that fail KEY_RE are dropped, not coerced', () => {
  const entries = read([
    { key: 'lowercase' },
    { key: '9_LEADING_DIGIT' },
    { key: 'HAS-DASH' },
    { key: '' },
    { key: null },
    {},
    'MAX_USER_SESSIONS',
    { key: 'GOOD_KEY' },
  ]);
  assert.deepEqual(entries.map((e) => e.key), ['GOOD_KEY']);
});

test('duplicate keys keep the first declaration and drop the rest', () => {
  const entries = read([
    { key: 'DUPE', description: 'first' },
    { key: 'DUPE', description: 'second' },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].description, 'first');
});

test('the entry count is capped', () => {
  const many = Array.from({ length: appManifest.MAX_PLATFORM_ENV + 25 },
    (_, i) => ({ key: `TUNABLE_${i}` }));
  assert.equal(read(many).length, appManifest.MAX_PLATFORM_ENV);
});

// ── The unwritable derivation ─────────────────────────────────────────

test('unwritable keys parse, carrying unwritable:true rather than being dropped', () => {
  for (const key of ['JWT_SECRET', 'DATABASE_URL', 'USERNODE_DOMAIN', 'GIT_SHA']) {
    const [entry] = read([{ key, description: 'documented only' }]);
    assert.ok(entry, `${key} must survive parsing so it can be documented in the console`);
    assert.equal(entry.unwritable, true, `${key} must be marked unwritable`);
  }
});

test('reserved keys and reserved prefixes are unwritable too', () => {
  const [reserved] = read([{ key: [...appManifest.RESERVED_KEYS][0] }]);
  assert.equal(reserved.unwritable, true);
  const [prefixed] = read([{ key: 'USERNODE_STORAGE_BUCKET' }]);
  assert.equal(prefixed.unwritable, true,
    'a reserved PREFIX must be unwritable — the platform injects these itself');
});

test('an ordinary tunable is writable', () => {
  const [entry] = read([{ key: 'LOG_LEVEL' }]);
  assert.equal(entry.unwritable, false);
});

// ── Disjointness from `secrets` ───────────────────────────────────────

test('a key declared in both blocks is dropped from secrets', () => {
  withManifest({
    secrets: [{ key: 'SHARED_KEY', required: true }, { key: 'ONLY_SECRET' }],
    platform_env: [{ key: 'SHARED_KEY' }],
  }, (m) => {
    assert.deepEqual(m.secrets.map((s) => s.key), ['ONLY_SECRET'],
      'platform_env wins the name; the secrets entry is dropped so a platform '
      + 'variable can never reach a child container through mergeForDeploy');
    assert.deepEqual(m.platform_env.map((e) => e.key), ['SHARED_KEY']);
  });
});

test('read() always returns a platform_env array, including on failure', () => {
  withManifest(null, (m) => assert.deepEqual(m.platform_env, []));
  withManifest('{ not json', (m) => assert.deepEqual(m.platform_env, []));
  withManifest({ secrets: [] }, (m) => assert.deepEqual(m.platform_env, []));
});

test("the platform's own manifest declares the deploy's tunables", () => {
  const root = path.join(__dirname, '..');
  const m = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
  const entries = appManifest.readPlatformEnv(m);
  const keys = new Set(entries.map((e) => e.key));

  // Every `${{ vars.X || '...' }}` line in the deploy is a tunable an
  // operator is expected to change without a code change — which is
  // exactly the set this feature moves into the console. A new one added
  // to deploy.yml without a declaration here would be invisible in the
  // admin UI, so pin the correspondence.
  const deploy = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  const tunables = [...deploy.matchAll(/^\s+([A-Z][A-Z0-9_]*)=\$\{\{ vars\.\1 \|\|/gm)]
    .map((mm) => mm[1]);
  assert.ok(tunables.length >= 15, 'sanity: the tunable scrape found the deploy lines');
  for (const key of tunables) {
    assert.ok(keys.has(key), `${key} is a deploy tunable but is not declared in platform_env`);
  }

  // And the documented-only ones are marked unwritable, not offered for
  // editing.
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const key of ['USERNODE_DOMAIN', 'GIT_SHA', 'DATABASE_URL']) {
    assert.equal(byKey.get(key)?.unwritable, true,
      `${key} must be documented as deploy-managed, never editable`);
  }
});

// ── reconcilePlatformEnv ──────────────────────────────────────────────

function mockPool(existingKeys = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT key FROM platform_env_declarations/.test(sql)) {
        return { rows: existingKeys.map((key) => ({ key })) };
      }
      if (/DELETE FROM platform_env_declarations/.test(sql)) {
        const keep = new Set(params[1]);
        return { rows: existingKeys.filter((k) => !keep.has(k)).map((key) => ({ key })) };
      }
      return { rows: [] };
    },
  };
}

const find = (pool, re) => pool.calls.filter((c) => re.test(c.sql));

test('reconcile upserts each declared entry', async () => {
  const pool = mockPool([]);
  const result = await appManifest.reconcilePlatformEnv(pool, 7, read([
    { key: 'ALPHA', description: 'a', group: 'Scaling' },
    { key: 'BETA', required: true },
  ]));
  const upserts = find(pool, /INSERT INTO platform_env_declarations/);
  assert.equal(upserts.length, 2);
  assert.equal(result.declared, 2);
  assert.deepEqual(result.added.sort(), ['ALPHA', 'BETA']);
  for (const call of upserts) {
    assert.match(call.sql, /ON CONFLICT \(app_id, key\) DO UPDATE/,
      'a re-deploy must refresh the description in place, not fail');
  }
});

test('reconcile removes declarations that left the manifest', async () => {
  const pool = mockPool(['STAYING', 'LEAVING']);
  const result = await appManifest.reconcilePlatformEnv(pool, 7, read([{ key: 'STAYING' }]));
  assert.deepEqual(result.removed, ['LEAVING']);
  const [del] = find(pool, /DELETE FROM platform_env_declarations/);
  assert.ok(del, 'the sweep runs');
  assert.deepEqual(del.params[1], ['STAYING']);
});

test('reconcile NEVER deletes a stored value', async () => {
  const pool = mockPool(['GONE']);
  await appManifest.reconcilePlatformEnv(pool, 7, []);
  assert.equal(find(pool, /DELETE FROM platform_env_values/).length, 0,
    'a rollback past the declaring commit must keep the configuration — '
    + 'the value resurfaces as an orphan row, it does not vanish');
  assert.equal(find(pool, /UPDATE platform_env_values/).length, 0);
});

test('reconcile with an empty manifest still sweeps stale declarations', async () => {
  const pool = mockPool(['OLD_ONE']);
  const result = await appManifest.reconcilePlatformEnv(pool, 7, []);
  assert.deepEqual(result.removed, ['OLD_ONE']);
  assert.equal(result.declared, 0);
});
