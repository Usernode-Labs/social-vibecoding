// Tests for src/services/pending-secrets.js — the DAO holding a value
// while its declaration PR is up for vote.
//
// Four properties carry the weight of this feature, and each has a test
// below that fails loudly if it regresses:
//
//  1. A PRIVATE HELD VALUE KEEPS NO LAST-4. Same rule the other two
//     stores follow: 4 characters of a token is 4 characters of a token.
//  2. A PRIVATE VALUE NEVER REACHES STAGING. rawValuesForSession omits
//     it, so an unreviewed PR's container can't be handed a credential —
//     the same reasoning as mergeForDeploy's private-in-staging branch.
//  3. APPLY CLAIMS ROWS EXACTLY ONCE. The claim is a status flip in the
//     UPDATE itself, so a merge retry (recoverStuckMerges) can't write
//     the value twice or resurrect a discarded one.
//  4. A DEAD PROPOSAL'S VALUE STOPS BEING OFFERED. listLive drops rows
//     whose session left ('promoted','merging') and flips them to
//     discarded, so a withdrawn proposal can't leave a live value behind
//     even if archiveSession's own cleanup was missed.
//
// Run with: node --test tests/pending-secrets.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pendingSecrets = require('../src/services/pending-secrets');
const { encrypt, decrypt } = require('../src/services/secrets');

const SECRET = 'test-jwt-secret-for-pending-secrets';

// Minimal pool double: matches on the shape of each statement this DAO
// issues, records every call, and returns whatever the test staged.
function mockPool({ liveRows = [], sessionRows = [], claimRows = [], valueRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO pending_secret_declarations/.test(sql)) {
        return { rows: [{ id: 42 }], rowCount: 1 };
      }
      if (/JOIN chat_sessions cs ON cs\.id = p\.session_id/.test(sql)) {
        return { rows: liveRows };
      }
      if (/SET status = 'applied'/.test(sql)) {
        return { rows: claimRows, rowCount: claimRows.length };
      }
      if (/SET status = 'discarded'/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      // keysForSession asks for the has_held_value projection;
      // rawValuesForSession filters on `AND value_enc IS NOT NULL` and
      // selects the ciphertext itself. Match the projection first — both
      // statements mention value_enc and session_id.
      if (/AS has_held_value/.test(sql) && /WHERE session_id/.test(sql)) {
        return { rows: sessionRows };
      }
      if (/AND value_enc IS NOT NULL/.test(sql) && /WHERE session_id/.test(sql)) {
        return { rows: valueRows };
      }
      if (/SET value_enc = NULL/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('create stores a last-4 for a non-private value and none for a private one', async () => {
  const pool = mockPool();
  await pendingSecrets.create(pool, {
    appId: 1, sessionId: 7, scope: 'platform', key: 'PUBLIC_THING',
    declaration: { description: 'x', private: false }, value: 'hello-1234',
    userId: 5, jwtSecret: SECRET,
  });
  const publicInsert = pool.calls.at(-1);
  assert.equal(publicInsert.params[6], '1234', 'a non-private held value previews its last 4');

  await pendingSecrets.create(pool, {
    appId: 1, sessionId: 7, scope: 'platform', key: 'PRIVATE_THING',
    declaration: { description: 'x', private: true }, value: 'sk-live-abcd',
    userId: 5, jwtSecret: SECRET,
  });
  const privateInsert = pool.calls.at(-1);
  assert.equal(privateInsert.params[6], null, 'a private held value keeps NO last-4');
});

test('create encrypts the held value — no plaintext reaches the INSERT', async () => {
  const pool = mockPool();
  await pendingSecrets.create(pool, {
    appId: 1, sessionId: 7, scope: 'app', key: 'TOKEN',
    declaration: { private: true }, value: 'super-secret-value',
    jwtSecret: SECRET,
  });
  const params = pool.calls.at(-1).params;
  const serialized = JSON.stringify(params);
  assert.ok(!serialized.includes('super-secret-value'), 'the plaintext must never be a query param');
  assert.equal(decrypt(params[5], SECRET), 'super-secret-value', 'and must round-trip through the ciphertext');
});

test("create with valueApplied holds no ciphertext (the admin's value is already in the real store)", async () => {
  const pool = mockPool();
  await pendingSecrets.create(pool, {
    appId: 1, sessionId: 7, scope: 'platform', key: 'ADMIN_SET',
    declaration: { private: false }, value: 'already-stored',
    jwtSecret: SECRET, valueApplied: true,
  });
  const params = pool.calls.at(-1).params;
  assert.equal(params[5], null, 'no second encrypted copy of a value that is already live');
  assert.ok(params[7] instanceof Date, 'value_applied_at is stamped instead');
});

test('normalizeDeclaration trims, bounds and defaults every field', () => {
  const decl = pendingSecrets.normalizeDeclaration({
    description: `  ${'d'.repeat(500)}  `,
    required: 1,
    private: 0,
    default: '  fallback  ',
    staging_default: '   ',
    group: '  Scaling  ',
  });
  assert.equal(decl.description.length, 400, 'description is capped at the manifest reader bound');
  assert.equal(decl.required, true);
  assert.equal(decl.private, false);
  assert.equal(decl.default, 'fallback', 'values are trimmed');
  assert.equal(decl.staging_default, null, 'a whitespace-only field is absent, not empty-string');
  assert.equal(decl.group, 'Scaling');
  assert.equal(pendingSecrets.normalizeDeclaration({}).group, 'General', 'group defaults to General');
});

test('rawValuesForSession omits private values (they never reach staging)', async () => {
  const pool = mockPool({
    valueRows: [
      { key: 'PUBLIC_URL', declaration: { private: false }, value_enc: encrypt('https://ok', SECRET) },
      { key: 'PRIVATE_KEY', declaration: { private: true }, value_enc: encrypt('sk-live', SECRET) },
    ],
  });

  const forStaging = await pendingSecrets.rawValuesForSession(pool, 7, SECRET);
  assert.deepEqual(forStaging, { PUBLIC_URL: 'https://ok' },
    'only the non-private value is offered to a staging build');

  const all = await pendingSecrets.rawValuesForSession(pool, 7, SECRET, { includePrivate: true });
  assert.deepEqual(Object.keys(all).sort(), ['PRIVATE_KEY', 'PUBLIC_URL'],
    'the explicit opt-in still exists for a caller that has a reason');
});

test('rawValuesForSession skips a row it cannot decrypt rather than throwing', async () => {
  const pool = mockPool({
    valueRows: [
      { key: 'BROKEN', declaration: {}, value_enc: 'v1:not:valid:ciphertext' },
      { key: 'FINE', declaration: {}, value_enc: encrypt('yes', SECRET) },
    ],
  });
  const out = await pendingSecrets.rawValuesForSession(pool, 7, SECRET);
  assert.deepEqual(out, { FINE: 'yes' });
});

test('listLive drops rows whose proposal is no longer in flight, and discards them', async () => {
  const pool = mockPool({
    liveRows: [
      {
        id: 1, key: 'LIVE_ONE', scope: 'platform', declaration: { private: false, group: 'Staging demo' },
        has_held_value: true, value_last4: '1234', value_applied_at: null,
        created_at: new Date(), session_id: 7, session_status: 'promoted',
        pr_number: 11, pr_url: 'https://github.test/pr/11', created_by_username: 'alice',
      },
      {
        id: 2, key: 'DEAD_ONE', scope: 'platform', declaration: {},
        has_held_value: true, value_last4: null, value_applied_at: null,
        created_at: new Date(), session_id: 8, session_status: 'archived',
        pr_number: 12, pr_url: null, created_by_username: 'bob',
      },
    ],
  });

  const live = await pendingSecrets.listLive(pool, 1);
  assert.deepEqual(live.map((r) => r.key), ['LIVE_ONE'], 'an archived proposal contributes no row');
  assert.equal(live[0].prNumber, 11);
  assert.equal(live[0].valueLast4, '1234');

  const discard = pool.calls.find((c) => /SET status = 'discarded'/.test(c.sql));
  assert.ok(discard, 'the dead row is flipped to discarded on read — no sweeper required');
  assert.deepEqual(discard.params[0], [2]);
});

test('listLive never previews a private held value', async () => {
  const pool = mockPool({
    liveRows: [{
      id: 3, key: 'PRIV', scope: 'platform', declaration: { private: true },
      // Even if a last-4 somehow existed on the row, the view refuses it.
      has_held_value: true, value_last4: 'leak', value_applied_at: null,
      created_at: new Date(), session_id: 7, session_status: 'promoted',
      pr_number: 4, pr_url: null, created_by_username: null,
    }],
  });
  const [row] = await pendingSecrets.listLive(pool, 1);
  assert.equal(row.valueLast4, null);
  assert.equal(row.private, true);
  assert.equal(row.hasValue, true, 'presence is still reported — just not the preview');
});

test('applyForSession claims rows once and writes through the scope DAO', async (t) => {
  const appSecrets = require('../src/services/app-secrets');
  const platformEnv = require('../src/services/platform-env');
  const platformWrites = [];
  const appWrites = [];
  t.mock.method(platformEnv, 'setValue', async (pool, appId, key, value, opts) => {
    platformWrites.push({ appId, key, value, opts });
    return { key, private: !!opts.privateHint };
  });
  t.mock.method(appSecrets, 'setValue', async (pool, appId, key, value, opts) => {
    appWrites.push({ appId, key, value, opts });
  });

  const pool = mockPool({
    claimRows: [
      {
        id: 1, app_id: 9, scope: 'platform', key: 'PLAT_KEY',
        declaration: { private: false }, value_enc: encrypt('plat-value', SECRET),
        value_applied_at: null, created_by: 5,
      },
      {
        id: 2, app_id: 9, scope: 'app', key: 'APP_KEY',
        declaration: { private: true }, value_enc: encrypt('app-value', SECRET),
        value_applied_at: null, created_by: 6,
      },
    ],
  });

  const { applied } = await pendingSecrets.applyForSession({ jwtSecret: SECRET }, pool, 7);
  assert.deepEqual(applied.map((a) => a.key).sort(), ['APP_KEY', 'PLAT_KEY']);
  assert.ok(applied.every((a) => a.hadValue));

  assert.equal(platformWrites.length, 1);
  assert.equal(platformWrites[0].value, 'plat-value');
  assert.equal(platformWrites[0].opts.privateHint, false,
    'the declaration decides privacy, and it travels with the proposal');

  assert.equal(appWrites.length, 1);
  assert.equal(appWrites[0].opts.sensitive, true, 'a private app secret is stored as sensitive');

  // The claim IS the status flip, so a second run finds nothing.
  const claim = pool.calls.find((c) => /SET status = 'applied'/.test(c.sql));
  assert.match(claim.sql, /WHERE session_id = \$1 AND status = 'pending'/);
  assert.match(claim.sql, /RETURNING/);
});

test('applyForSession on an already-applied session is a no-op', async () => {
  const pool = mockPool({ claimRows: [] });
  const result = await pendingSecrets.applyForSession({ jwtSecret: SECRET }, pool, 7);
  assert.deepEqual(result, { applied: [] });
  assert.ok(!pool.calls.some((c) => /SET value_enc = NULL/.test(c.sql)),
    'nothing is written when no row was claimed');
});

test('applyForSession skips (but still claims) a row whose value cannot be decrypted', async (t) => {
  const platformEnv = require('../src/services/platform-env');
  let wrote = 0;
  t.mock.method(platformEnv, 'setValue', async () => { wrote++; });

  const pool = mockPool({
    claimRows: [{
      id: 1, app_id: 9, scope: 'platform', key: 'BROKEN',
      declaration: {}, value_enc: 'v1:garbage', value_applied_at: null, created_by: null,
    }],
  });
  const { applied } = await pendingSecrets.applyForSession({ jwtSecret: SECRET }, pool, 7);
  assert.equal(wrote, 0, 'no write attempted with a null plaintext');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].hadValue, false, 'and the caller is told no value landed');
});

test('discardForSession clears the ciphertext as well as the status', async () => {
  const pool = mockPool();
  await pendingSecrets.discardForSession(pool, 7);
  const call = pool.calls.at(-1);
  assert.match(call.sql, /SET status = 'discarded', value_enc = NULL/,
    'a rejected proposal must not leave a decryptable value behind');
  assert.match(call.sql, /status = 'pending'/, 'and only a pending row transitions');
});

test('keysForSession reports whether each proposed key carries a value', async () => {
  const pool = mockPool({
    sessionRows: [
      { key: 'WITH_VALUE', scope: 'platform', declaration: {}, has_held_value: true, value_applied_at: null },
      { key: 'ADMIN_APPLIED', scope: 'platform', declaration: {}, has_held_value: false, value_applied_at: new Date() },
      { key: 'DECL_ONLY', scope: 'platform', declaration: {}, has_held_value: false, value_applied_at: null },
    ],
  });
  const keys = await pendingSecrets.keysForSession(pool, 7);
  assert.deepEqual(
    keys.map((k) => [k.key, k.hasValue]),
    [['WITH_VALUE', true], ['ADMIN_APPLIED', true], ['DECL_ONLY', false]],
    'an admin-applied value counts as carried — it is already in the store'
  );
});
