'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { bech32m } = require('bech32');
const { canonicalNativeSessionV2Network } = require('../src/config');
const {
  exchangeRequestSchema,
  sha256Hex,
  ticketRequestDigest,
  validateInstallationKeys,
  exchangeSemanticDigest,
  possessionTranscript,
  compactEncryptCredential,
  sealReplay,
  openReplay,
} = require('../src/services/topochain/native-session-crypto');
const {
  NativeSessionProtocol,
} = require('../src/services/topochain/native-session-protocol');
const { revokeNativeSessionCredentials } = require('../src/services/native-session-revocation');

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();
const opaque = (prefix, byte) => prefix + Buffer.alloc(32, byte).toString('base64url');
const CHAIN_ID = bech32m.encode('utc', bech32m.toWords(Buffer.alloc(32, 7)), 1023);
const NETWORK = { id: 'testnet', chainId: CHAIN_ID };
const DATA_KEY = 'native-session-test-data-key';

function makeKeys() {
  const possession = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const envelope = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  return {
    possessionPrivateKey: possession.privateKey,
    possessionPublicJwk: possession.publicKey.export({ format: 'jwk' }),
    envelopePrivateJwk: envelope.privateKey.export({ format: 'jwk' }),
    envelopePublicJwk: envelope.publicKey.export({ format: 'jwk' }),
  };
}

function unsignedExchangeRequest(keyPair) {
  return {
    protocol: 2,
    attemptId: opaque('nsa_', 1),
    desiredRuntime: 'running',
    ticket: opaque('nst_', 2),
    requestDigest: 'ab'.repeat(32),
    installation: {
      id: opaque('nsi_', 3),
      keyGeneration: 1,
      possessionPublicJwk: keyPair.possessionPublicJwk,
      envelopePublicJwk: keyPair.envelopePublicJwk,
    },
    proof: {
      algorithm: 'ES256',
      signature: Buffer.alloc(64).toString('base64url'),
    },
  };
}

function signExchange(request, keyPair, keys, challenge) {
  const ticketHash = sha256Hex(request.ticket);
  return crypto.sign(
    'sha256',
    possessionTranscript({
      request,
      keys,
      ticketHash,
      exchangeChallenge: challenge,
      network: NETWORK,
    }),
    { key: keyPair.possessionPrivateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64url');
}

test('configured protocol-2 network accepts only canonical Rust ChainId text', () => {
  assert.deepEqual(canonicalNativeSessionV2Network(CHAIN_ID), NETWORK);
  assert.equal(canonicalNativeSessionV2Network(CHAIN_ID.toUpperCase()), null);
  assert.equal(canonicalNativeSessionV2Network(bech32m.encode('bad', bech32m.toWords(Buffer.alloc(32, 7)), 1023)), null);
  assert.equal(canonicalNativeSessionV2Network(bech32m.encode('utc', bech32m.toWords(Buffer.alloc(31, 7)), 1023)), null);
});

test('exchange DTO is closed: callers submit public JWKs, never key ids or private fields', () => {
  const pair = makeKeys();
  const request = unsignedExchangeRequest(pair);
  assert.equal(exchangeRequestSchema.safeParse(request).success, true);
  assert.equal(exchangeRequestSchema.safeParse({
    ...request,
    installation: { ...request.installation, possessionKeyId: opaque('nskp_', 8) },
  }).success, false);
  assert.equal(exchangeRequestSchema.safeParse({
    ...request,
    attemptId: `${request.attemptId.slice(0, -1)}B`,
  }).success, false, 'non-canonical base64url pad bits are rejected');
  assert.equal(exchangeRequestSchema.safeParse({
    ...request,
    installation: {
      ...request.installation,
      possessionPublicJwk: { ...request.installation.possessionPublicJwk, d: opaque('', 9) },
    },
  }).success, false);
});

test('server validates P-256/RSA-3072 keys and derives purpose-specific RFC7638 ids', () => {
  const pair = makeKeys();
  const request = unsignedExchangeRequest(pair);
  const keys = validateInstallationKeys(request.installation);
  assert.match(keys.possessionKeyId, /^nskp_[A-Za-z0-9_-]{43}$/);
  assert.match(keys.envelopeKeyId, /^nske_[A-Za-z0-9_-]{43}$/);

  const rsa2048 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  assert.throws(() => validateInstallationKeys({
    ...request.installation,
    envelopePublicJwk: rsa2048.publicKey.export({ format: 'jwk' }),
  }), /invalid_envelope_public_key/);
});

test('PoP transcript has one pinned cross-language byte vector', () => {
  const request = {
    protocol: 2,
    attemptId: opaque('nsa_', 1),
    desiredRuntime: 'running',
    requestDigest: 'ab'.repeat(32),
    installation: { id: opaque('nsi_', 2), keyGeneration: 1 },
  };
  const transcript = possessionTranscript({
    request,
    keys: {
      possessionKeyThumbprint: Buffer.alloc(32, 3).toString('base64url'),
      envelopeKeyThumbprint: Buffer.alloc(32, 4).toString('base64url'),
    },
    ticketHash: 'cd'.repeat(32),
    exchangeChallenge: Buffer.alloc(32, 5).toString('base64url'),
    network: NETWORK,
  });
  assert.equal(sha256Hex(transcript), 'c5207658c18637aaacf09e0a096668c857a527d601125e31d60b98cb4068e3a9');
  assert.equal(transcript.subarray(0, 48).toString('hex'),
    '757365726e6f64652e6e61746976652d73657373696f6e2e65786368616e67652d706f702e76320070726f746f636f6c');
  assert.match(transcript.toString('utf8'), /ticketHash:64:cdcdcdcd/);
  assert.ok(transcript.toString('utf8').endsWith(`chainId:${Buffer.byteLength(CHAIN_ID)}:${CHAIN_ID}\n`));
});

test('randomized ES256 proof bytes do not enter semantic idempotency digest', () => {
  const pair = makeKeys();
  const request = unsignedExchangeRequest(pair);
  const keys = validateInstallationKeys(request.installation);
  const challenge = Buffer.alloc(32, 4).toString('base64url');
  request.proof.signature = signExchange(request, pair, keys, challenge);
  const first = exchangeSemanticDigest(request, keys);
  request.proof.signature = signExchange(request, pair, keys, challenge);
  const second = exchangeSemanticDigest(request, keys);
  assert.equal(first, second);
});

test('RSA-OAEP+A256GCM compact JWE decrypts only with the envelope private key', async () => {
  const pair = makeKeys();
  const request = unsignedExchangeRequest(pair);
  const keys = validateInstallationKeys(request.installation);
  const compactJwe = await compactEncryptCredential({ bearerToken: 'never-outer-json' }, keys);
  assert.equal(compactJwe.split('.').length, 5);
  const { compactDecrypt, importJWK } = await import('jose');
  const privateKey = await importJWK(pair.envelopePrivateJwk, 'RSA-OAEP');
  const decrypted = await compactDecrypt(compactJwe, privateKey);
  assert.deepEqual(JSON.parse(Buffer.from(decrypted.plaintext).toString('utf8')),
    { bearerToken: 'never-outer-json' });
  assert.deepEqual(decrypted.protectedHeader, {
    alg: 'RSA-OAEP',
    enc: 'A256GCM',
    kid: keys.envelopeKeyId,
    typ: 'application/usernode-native-session-credential+jwe',
  });
});

class TicketPool {
  constructor(now) {
    this.now = now;
    this.session = { token: 'cookie-A', user_id: 41, native_session_incarnation_id: null };
    this.attempts = new Map();
    this.tickets = new Map();
    this.lockTail = Promise.resolve();
  }

  async connect() {
    const pool = this;
    let releaseLock = null;
    return {
      async query(rawSql, params = []) {
        const sql = collapse(rawSql);
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (releaseLock) releaseLock();
          releaseLock = null;
          return { rows: [] };
        }
        if (sql.startsWith('SELECT token, user_id, native_session_incarnation_id FROM sessions')) {
          const previous = pool.lockTail;
          pool.lockTail = new Promise((resolve) => { releaseLock = resolve; });
          await previous;
          return params[0] === pool.session.token
            ? { rows: [{ ...pool.session }] }
            : { rows: [] };
        }
        if (sql.startsWith('INSERT INTO native_session_web_incarnations')) return { rows: [] };
        if (sql.startsWith('UPDATE sessions SET native_session_incarnation_id')) {
          pool.session.native_session_incarnation_id = params[0];
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO native_session_attempts')) {
          if (!pool.attempts.has(params[0])) {
            pool.attempts.set(params[0], {
              attempt_id: params[0], protocol: 2, user_id: params[1],
              web_session_incarnation_id: params[2], desired_runtime: 'running',
              network_id: params[3], chain_id: params[4], request_digest: params[5],
              state: 'ticketed',
            });
          }
          return { rows: [] };
        }
        if (sql.startsWith('SELECT attempt_id, protocol, user_id, web_session_incarnation_id')) {
          const row = pool.attempts.get(params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (sql.startsWith('SELECT ticket_hash, encrypted_response, response_digest')) {
          const row = pool.tickets.get(params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (sql.startsWith('INSERT INTO native_session_tickets')) {
          pool.tickets.set(params[0], {
            ticket_hash: params[1], encrypted_response: params[4],
            response_digest: params[5], state: 'issued', expires_at: params[7],
          });
          return { rows: [] };
        }
        throw new Error(`Unhandled TicketPool query: ${sql}`);
      },
      release() {},
    };
  }
}

test('concurrent exact ticket requests mint once and replay byte-identically', async () => {
  const now = new Date('2026-08-26T12:00:00.000Z');
  const pool = new TicketPool(now);
  const protocol = new NativeSessionProtocol({
    pool,
    config: { nativeSessionV2Network: NETWORK, dataEncryptionKey: DATA_KEY },
    now: () => now,
  });
  const body = { protocol: 2, attemptId: opaque('nsa_', 7), desiredRuntime: 'running' };
  const [first, second] = await Promise.all([
    protocol.createTicket({ sessionToken: 'cookie-A', body }),
    protocol.createTicket({ sessionToken: 'cookie-A', body }),
  ]);
  assert.equal(first, second);
  assert.equal(pool.tickets.size, 1);
  assert.equal(pool.attempts.size, 1);
  assert.equal(JSON.parse(first).data.ticket.startsWith('nst_'), true);
});

function replayPool({ row, credential, keyRow }) {
  const queries = [];
  return {
    queries,
    async connect() {
      return {
        async query(rawSql) {
          const sql = collapse(rawSql);
          queries.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.startsWith('SELECT a.attempt_id, a.protocol')) return { rows: [{ ...row }] };
          if (sql.startsWith('SELECT c.credential_reference')) return { rows: [{ ...credential }] };
          if (sql.startsWith('SELECT installation_id, key_generation, user_id')) return { rows: [{ ...keyRow }] };
          throw new Error(`Unhandled replay query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

test('committed exchange exact retry survives web-session deletion and accepts a fresh ES256 proof', async () => {
  const pair = makeKeys();
  const request = unsignedExchangeRequest(pair);
  const keys = validateInstallationKeys(request.installation);
  const challenge = Buffer.alloc(32, 6).toString('base64url');
  const ticketHash = sha256Hex(request.ticket);
  const exchangeDigest = exchangeSemanticDigest(request, keys);
  const rawJson = JSON.stringify({ success: true, data: { credentialReference: opaque('nsc_', 9) } });
  const sealed = sealReplay({
    kind: 'exchange', key: opaque('nsc_', 9), rawJson, dataEncryptionKey: DATA_KEY,
  });
  const row = {
    attempt_id: request.attemptId, protocol: 2, user_id: 41,
    web_session_incarnation_id: opaque('nsw_', 8), desired_runtime: 'running',
    network_id: NETWORK.id, chain_id: NETWORK.chainId,
    request_digest: request.requestDigest, attempt_state: 'exchanged',
    ticket_hash: ticketHash, exchange_challenge: challenge,
    ticket_state: 'exchanged', expires_at: new Date(0),
  };
  const credential = {
    credential_reference: opaque('nsc_', 9), credential_generation: 1,
    exchange_request_digest: exchangeDigest, state: 'valid',
    installation_id: request.installation.id, installation_key_generation: 1,
    expires_at: new Date('2099-01-01T00:00:00.000Z'),
    encrypted_response: sealed.encryptedResponse, response_digest: sealed.responseDigest,
  };
  const keyRow = {
    installation_id: request.installation.id, key_generation: 1, user_id: 41,
    possession_key_id: keys.possessionKeyId,
    possession_key_thumbprint: keys.possessionKeyThumbprint,
    possession_public_jwk: keys.possessionJwk,
    envelope_key_id: keys.envelopeKeyId,
    envelope_key_thumbprint: keys.envelopeKeyThumbprint,
    envelope_public_jwk: keys.envelopeJwk,
  };
  const pool = replayPool({ row, credential, keyRow });
  const protocol = new NativeSessionProtocol({
    pool, config: { nativeSessionV2Network: NETWORK, dataEncryptionKey: DATA_KEY },
  });

  request.proof.signature = signExchange(request, pair, keys, challenge);
  const firstProof = request.proof.signature;
  assert.equal(await protocol.exchange({ body: request }), rawJson);
  request.proof.signature = signExchange(request, pair, keys, challenge);
  assert.equal(await protocol.exchange({ body: request }), rawJson);
  assert.notEqual(firstProof, request.proof.signature);
  assert.equal(pool.queries.some((sql) => sql.includes('FROM sessions')), false);
});

test('encrypted replay is byte-exact and detects ciphertext/metadata swaps', () => {
  const rawJson = '{"success":true,"data":{"x":1}}';
  const sealed = sealReplay({ kind: 'ticket', key: 'attempt-A', rawJson, dataEncryptionKey: DATA_KEY });
  assert.equal(openReplay({
    kind: 'ticket', key: 'attempt-A',
    encryptedResponse: sealed.encryptedResponse,
    responseDigest: sealed.responseDigest,
    dataEncryptionKey: DATA_KEY,
  }), rawJson);
  assert.throws(() => openReplay({
    kind: 'ticket', key: 'attempt-B',
    encryptedResponse: sealed.encryptedResponse,
    responseDigest: sealed.responseDigest,
    dataEncryptionKey: DATA_KEY,
  }), /integrity/);
});

test('central web logout revokes attempts before credentials and deletes linked bearers', async () => {
  const calls = [];
  const client = {
    async query(rawSql) {
      const sql = collapse(rawSql);
      calls.push(sql);
      if (sql.startsWith('UPDATE native_session_attempts')) return { rows: [{ attempt_id: opaque('nsa_', 1) }] };
      if (sql.startsWith('UPDATE native_session_tickets')) return { rows: [] };
      if (sql.startsWith('UPDATE native_session_credentials')) {
        return { rows: [{ credential_reference: opaque('nsc_', 1), mobile_auth_token_id: 88 }] };
      }
      if (sql.startsWith('DELETE FROM mobile_auth_tokens')) return { rows: [] };
      throw new Error(`Unhandled revocation query: ${sql}`);
    },
  };
  await revokeNativeSessionCredentials(client, {
    reason: 'web_logout', userId: 41, webSessionIncarnationId: opaque('nsw_', 1),
  });
  assert.ok(calls[0].startsWith('UPDATE native_session_attempts'));
  assert.ok(calls[2].startsWith('UPDATE native_session_credentials'));
  assert.ok(calls[3].startsWith('DELETE FROM mobile_auth_tokens'));
});

async function withNativeRoute(config, fn) {
  const poolPath = require.resolve('../src/db/pool');
  const routePath = require.resolve('../src/routes/topochain/native-session');
  const original = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => ({ connect: async () => { throw new Error('DB must not be reached'); } }) },
    loaded: true, id: poolPath, filename: poolPath, paths: original ? original.paths : [],
  };
  delete require.cache[routePath];
  const { nativeSessionRoutes } = require('../src/routes/topochain/native-session');
  const app = express();
  app.use(express.json());
  app.use(nativeSessionRoutes(config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (original) require.cache[poolPath] = original;
    else delete require.cache[poolPath];
    delete require.cache[routePath];
  }
}

test('API stays dark without config and rejects non-closed DTOs before DB access', async () => {
  await withNativeRoute({ dataEncryptionKey: DATA_KEY, nativeSessionV2Network: null }, async (base) => {
    const res = await fetch(`${base}/api/v4/mobile/auth/native-establish-ticket`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Not found.' });
  });
  await withNativeRoute({ dataEncryptionKey: DATA_KEY, nativeSessionV2Network: NETWORK }, async (base) => {
    const res = await fetch(`${base}/api/v4/mobile/auth/native-establish-exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 2, extra: true }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'invalid_native_session_exchange_request');
  });
});

test('ticket digest binds server-derived subject, exact incarnation, and ChainId', () => {
  const base = {
    attemptId: opaque('nsa_', 1), userId: 41,
    webSessionIncarnationId: opaque('nsw_', 1), network: NETWORK,
  };
  const digest = ticketRequestDigest(base);
  assert.notEqual(ticketRequestDigest({ ...base, userId: 42 }), digest);
  assert.notEqual(ticketRequestDigest({ ...base, webSessionIncarnationId: opaque('nsw_', 2) }), digest);
  assert.notEqual(ticketRequestDigest({
    ...base, network: { ...NETWORK, chainId: bech32m.encode('utc', bech32m.toWords(Buffer.alloc(32, 8)), 1023) },
  }), digest);
});

test('schema cross-binds session, attempt, installation, token, and account subjects', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema, /FOREIGN KEY \(native_session_incarnation_id, user_id\)\s+REFERENCES native_session_web_incarnations\(id, user_id\)/);
  assert.match(schema, /FOREIGN KEY \(web_session_incarnation_id, user_id\)\s+REFERENCES native_session_web_incarnations\(id, user_id\)/);
  assert.match(schema, /FOREIGN KEY \(attempt_id, user_id, web_session_incarnation_id, network_id, chain_id\)/);
  assert.match(schema, /FOREIGN KEY \(installation_id, installation_key_generation, user_id\)/);
  assert.match(schema, /FOREIGN KEY \(mobile_auth_token_id, user_id\)[\s\S]*?ON DELETE SET NULL \(mobile_auth_token_id\)/);
  assert.match(schema, /FOREIGN KEY \(account_id, user_id\)\s+REFERENCES onchain_accounts\(id, user_id\)/);
});
