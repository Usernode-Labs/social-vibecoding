'use strict';

// #5118: the platform's side of the app user-data contract. Account deletion
// asks each app the person touched to erase their rows: who gets asked, how
// the request is signed, and what each answer does to the durable task.
// The SQL itself (which apps, the task's retries) runs against PostgreSQL in
// tests/account-deletion-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.IFRAME_JWT_PRIVATE_KEY = privateKey;
process.env.IFRAME_JWT_PUBLIC_KEY = publicKey;

const platformJwt = require('../src/services/platform-jwt');
const appUserData = require('../src/services/app-user-data');

const APP = { id: 42, slug: 'potluck', runtime_kind: 'docker', runtime_name: 'usernode-app-potluck', self_hosted: false };

function fakePool({ app = APP, userId = 7 } = {}) {
  return {
    async query(sql, params) {
      if (/FROM account_deletions/.test(sql)) return { rows: userId ? [{ user_id: userId }] : [] };
      if (/FROM apps WHERE id = \$1/.test(sql)) return { rows: app && Number(params[0]) === app.id ? [app] : [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
}

function recordingFetch(status) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (status === 'network') throw new Error('ECONNREFUSED secret detail');
    return new Response(status === 204 ? null : '{}', { status });
  };
  return { calls, impl };
}

const task = (target) => ({ id: 1, deletion_id: 'd'.repeat(32), kind: 'app_data', target, attempts: 1 });
const send = (target, fetchImpl, opts = {}) => appUserData.requestDeletion(
  opts.pool || fakePool(), { appRuntime: 'docker' }, task(target), { fetchImpl, env: opts.env || {} });

test('the request goes to the app\'s own production origin, signed for that app and purpose', async () => {
  const f = recordingFetch(200);
  assert.deepEqual(await send('42:ut1walletaddress', f.impl), { outcome: 'erased' });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'http://usernode-app-potluck:3000/usernode/user-deletion');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body, undefined, 'the person is named only by the signed token');
  assert.deepEqual(Object.keys(init.headers), ['x-usernode-platform-token']);
  // Its own header, never the sign-in header an older app reads as a person.
  assert.equal(init.headers['x-usernode-token'], undefined);
  const token = init.headers['x-usernode-platform-token'];
  const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'usernode', audience: 'usernode:app:42' });
  assert.equal(claims.pur, 'user-deletion');
  assert.equal(claims.id, 7);
  assert.equal(claims.usernode_pubkey, 'ut1walletaddress');
  assert.equal(claims.username, undefined, 'an anonymised account has no name to send');
  assert.ok(claims.jti && claims.exp - claims.iat <= 600);
  // Not a sign-in token: a verifier pinned to `pur: 'iframe'` refuses it.
  assert.throws(() => platformJwt.verifyAppIdentityToken(token, { appId: 42 }));
  // And not valid for another app.
  assert.throws(() => jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'usernode', audience: 'usernode:app:43' }));
});

test('a person with no wallet address is sent by id alone', async () => {
  const f = recordingFetch(204);
  await send('42', f.impl);
  assert.equal(f.calls[0].init.body, undefined);
  const claims = jwt.decode(f.calls[0].init.headers['x-usernode-platform-token']);
  assert.equal(claims.id, 7);
  assert.equal(claims.usernode_pubkey, null);
});

test('an app with no handler, or one refusing the token, settles for review rather than retrying', async () => {
  for (const [status, code] of [[401, 'app_unsupported'], [404, 'app_unsupported'], [405, 'app_unsupported'],
    [501, 'app_unsupported'], [403, 'app_refused'], [400, 'app_rejected'], [422, 'app_rejected']]) {
    const f = recordingFetch(status);
    await assert.rejects(send('42', f.impl), (err) => err instanceof appUserData.SettleForReview && err.reviewCode === code, String(status));
  }
});

test('an unreachable or failing app is retried, and no provider detail is kept', async () => {
  for (const status of [500, 502, 503, 408, 429, 'network']) {
    const f = recordingFetch(status);
    await assert.rejects(send('42', f.impl), (err) => !(err instanceof appUserData.SettleForReview)
      && /^app_un(available|reachable)$/.test(err.message), String(status));
  }
});

test('a deleted app (its database dropped with it) completes without a request', async () => {
  const f = recordingFetch(200);
  assert.deepEqual(await send('42', f.impl, { pool: fakePool({ app: null }) }), { outcome: 'gone' });
  assert.deepEqual(await send('42', f.impl, { pool: fakePool({ app: { ...APP, self_hosted: true } }) }), { outcome: 'gone' });
  assert.equal(f.calls.length, 0);
});

test('a staging copy of the platform never asks an app to erase anything', async () => {
  const f = recordingFetch(200);
  await assert.rejects(send('42', f.impl, { env: { USERNODE_ENV: 'staging' } }), { reviewCode: 'staging_copy' });
  assert.equal(f.calls.length, 0);
});

test('targets round-trip and reject anything but a positive app id', () => {
  assert.equal(appUserData.encodeTarget(5, null), '5');
  assert.equal(appUserData.encodeTarget(5, 'ut1abc'), '5:ut1abc');
  assert.deepEqual(appUserData.decodeTarget('5:ut1abc'), { appId: 5, usernodePubkey: 'ut1abc' });
  assert.deepEqual(appUserData.decodeTarget('5'), { appId: 5, usernodePubkey: null });
  for (const bad of ['', '0', '-1', 'x:ut1', 'erased:9']) assert.throws(() => appUserData.decodeTarget(bad), bad);
});

test('the signer refuses an unknown purpose or a missing person', () => {
  assert.throws(() => platformJwt.signAppUserDataToken({ appId: 1, userId: 1, purpose: 'iframe' }));
  assert.throws(() => platformJwt.signAppUserDataToken({ appId: 1, userId: 0, purpose: 'user-deletion' }));
  const exportToken = platformJwt.signAppUserDataToken({ appId: 1, userId: 3, purpose: platformJwt.PUR_USER_EXPORT });
  assert.equal(jwt.decode(exportToken).pur, 'user-export');
});

test('the cleanup sweep hands app_data tasks to the dispatcher with its pool', async () => {
  const cleanup = require('../src/services/account-deletion-cleanup');
  const original = appUserData.requestDeletion;
  const seen = [];
  appUserData.requestDeletion = async (pool, config, t) => { seen.push({ pool, config, t }); return { outcome: 'erased' }; };
  try {
    const pool = {};
    await cleanup.perform(task('42'), { marker: true }, pool);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pool, pool);
    assert.equal(seen[0].config.marker, true);
  } finally {
    appUserData.requestDeletion = original;
  }
});
