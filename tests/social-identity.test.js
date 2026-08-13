'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const identity = require('../src/services/social-identity');

const SCHEMA = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/social-identities.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('provider identities use immutable numeric subjects and strict handles', () => {
  assert.deepEqual(identity.normalizeIdentity({
    provider: 'github', subject: 123, handle: 'octo-user',
  }), { provider: 'github', subject: '123', handle: 'octo-user' });
  assert.deepEqual(identity.normalizeIdentity({
    provider: 'x', subject: '456', handle: 'octo_user',
  }), { provider: 'x', subject: '456', handle: 'octo_user' });

  for (const bad of [
    { provider: 'github', subject: '0', handle: 'valid' },
    { provider: 'github', subject: '123', handle: '-invalid' },
    { provider: 'x', subject: 'abc', handle: 'valid' },
    { provider: 'x', subject: '123', handle: 'too-long-for-an-x-username' },
    { provider: 'unknown', subject: '123', handle: 'valid' },
  ]) {
    assert.throws(() => identity.normalizeIdentity(bad), identity.SocialIdentityError);
  }
});

test('OAuth state is hashed at rest, PKCE-bound, user/provider-bound, and single-use', async () => {
  let pending = null;
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO social_identity_oauth_states/.test(sql)) {
        pending = {
          hash: params[0], userId: params[1], provider: params[2],
          verifier: params[3], expiresAt: params[4],
        };
        return { rows: [] };
      }
      if (/DELETE FROM social_identity_oauth_states[\s\S]*RETURNING/.test(sql)) {
        if (!pending || params[0] !== pending.hash || params[1] !== pending.userId
            || params[2] !== pending.provider) return { rows: [] };
        const row = { pkce_verifier: pending.verifier, expires_at: pending.expiresAt };
        pending = null;
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };

  const created = await identity.createOauthState(pool, { userId: 7, provider: 'github' });
  assert.match(created.state, identity.STATE_RE);
  assert.match(created.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(created.challenge, created.verifier);
  assert.equal(pending.hash, identity.stateHash(created.state));
  assert.notEqual(pending.hash, created.state, 'raw browser state is not stored');
  assert.equal(calls.some((call) => call.params.includes(created.state)), false);

  assert.equal(await identity.consumeOauthState(pool, {
    userId: 8, provider: 'github', state: created.state,
  }), null, 'another signed-in user cannot consume it');
  assert.equal(await identity.consumeOauthState(pool, {
    userId: 7, provider: 'x', state: created.state,
  }), null, 'another provider callback cannot consume it');
  const consumed = await identity.consumeOauthState(pool, {
    userId: 7, provider: 'github', state: created.state,
  });
  assert.equal(consumed.verifier, created.verifier);
  assert.equal(await identity.consumeOauthState(pool, {
    userId: 7, provider: 'github', state: created.state,
  }), null, 'replay loses the atomic DELETE race');
  assert.ok(identity.STATE_TTL_MS <= 10 * 60 * 1000);
});

function transactionPool(queryImpl) {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      return queryImpl(String(sql), params);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return { pool: { connect: async () => client }, calls };
}

test('saving a proof stores no token, dual-writes GitHub attribution, and serializes on the user', async () => {
  const tx = transactionPool(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 7 }] };
    if (/SELECT provider_subject/.test(sql)) return { rows: [] };
    if (/INSERT INTO user_social_identities/.test(sql)) {
      return { rows: [{
        provider: 'github', handle: 'octo-user',
        linked_at: new Date(0), last_verified_at: new Date(0),
      }] };
    }
    if (/UPDATE users/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query ${sql}`);
  });

  await identity.saveIdentity(tx.pool, 7, {
    provider: 'github', subject: '12345', handle: 'octo-user', token: 'never-store-me',
  });
  const lock = tx.calls.find((call) => /FOR UPDATE/.test(call.sql));
  assert.ok(lock, 'same-user provider links are serialized');
  const insert = tx.calls.find((call) => /INSERT INTO user_social_identities/.test(call.sql));
  assert.deepEqual(insert.params, [7, 'github', '12345', 'octo-user']);
  assert.equal(tx.calls.some((call) => call.params.includes('never-store-me')), false);
  const compatibility = tx.calls.find((call) => /github_login = \$2/.test(call.sql));
  assert.ok(compatibility);
  assert.match(compatibility.sql, /github_oauth_token_enc = NULL/);
});

test('a provider account is unique globally and account swaps require explicit disconnect', async () => {
  const duplicate = transactionPool(async (sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 7 }] };
    if (/SELECT provider_subject/.test(sql)) return { rows: [] };
    if (/INSERT INTO user_social_identities/.test(sql)) {
      const err = new Error('unique violation');
      err.code = '23505';
      throw err;
    }
    return { rows: [] };
  });
  await assert.rejects(
    identity.saveIdentity(duplicate.pool, 7, {
      provider: 'x', subject: '99', handle: 'owned_elsewhere',
    }),
    (err) => err instanceof identity.SocialIdentityError && err.code === 'identity_in_use'
  );

  const swap = transactionPool(async (sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 7 }] };
    if (/SELECT provider_subject/.test(sql)) return { rows: [{ provider_subject: '10' }] };
    return { rows: [] };
  });
  await assert.rejects(
    identity.saveIdentity(swap.pool, 7, {
      provider: 'x', subject: '11', handle: 'different',
    }),
    (err) => err.code === 'disconnect_before_relink'
  );
  assert.equal(swap.calls.some((call) => /INSERT INTO user_social_identities/.test(call.sql)), false);
});

test('disconnect serializes with callback saves and invalidates unfinished OAuth flows', async () => {
  const tx = transactionPool(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 7 }] };
    if (/DELETE FROM social_identity_oauth_states/.test(sql)) return { rows: [], rowCount: 1 };
    if (/DELETE FROM user_social_identities/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE users/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query ${sql}`);
  });

  assert.equal(await identity.clearIdentity(tx.pool, 7, 'github'), true);
  assert.ok(tx.calls.some((call) => /SELECT id FROM users[\s\S]*FOR UPDATE/.test(call.sql)));
  assert.ok(tx.calls.some((call) => /DELETE FROM social_identity_oauth_states/.test(call.sql)));
  assert.ok(tx.calls.some((call) => /github_oauth_token_enc = NULL/.test(call.sql)));
});

test('legacy GitHub attribution is honest: linked for attribution, not eligible until reconnect', async () => {
  const pool = {
    query: async (sql) => {
      if (/FROM user_social_identities/.test(sql)) return { rows: [] };
      return { rows: [{ github_login: 'legacy-user', github_linked_at: new Date(0) }] };
    },
  };
  const status = await identity.identityStatus(pool, 7);
  assert.equal(status.github.linked, true);
  assert.equal(status.github.handle, 'legacy-user');
  assert.equal(status.github.creditEligible, false);
  assert.equal(status.github.reconnectRequired, true);
  assert.equal(status.x.linked, false);
  assert.equal('subject' in status.github, false, 'private provider id is never serialized');
});

test('schema and route mounting enforce privacy, uniqueness, replay safety, and MCP independence', () => {
  assert.match(SCHEMA, /UNIQUE \(user_id, provider\)/);
  assert.match(SCHEMA, /UNIQUE \(provider, provider_subject\)/);
  assert.match(SCHEMA, /COMMENT ON TABLE user_social_identities IS 'staging:private'/);
  assert.match(SCHEMA, /COMMENT ON TABLE social_identity_oauth_states IS 'staging:private'/);
  assert.doesNotMatch(SCHEMA.slice(
    SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS user_social_identities'),
    SCHEMA.indexOf('-- Which external coding agent')
  ), /access_token|refresh_token/);

  const consumeAt = ROUTES.indexOf('consumeOauthState(pool');
  const exchangeAt = ROUTES.indexOf('adapter.exchangeCode(config');
  assert.ok(consumeAt > 0 && exchangeAt > consumeAt, 'state is consumed before provider exchange');
  assert.match(ROUTES, /browserCsrf\(config, req, res\)/);
  assert.match(ROUTES, /if \(IS_STAGING\) return res\.status\(404\)/);
  const authAt = SERVER.indexOf('app.use(authMiddleware(config));');
  const identityAt = SERVER.indexOf('app.use(socialIdentityRoutes(config));');
  const mcpAt = SERVER.indexOf('app.use(mcpBrowserRoutes(config));');
  assert.ok(authAt < identityAt && identityAt < mcpAt);
});
