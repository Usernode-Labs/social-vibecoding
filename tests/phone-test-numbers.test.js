'use strict';

// Phone sign-in TEST NUMBERS (services/firebase-phone-auth.js, PHONE_TEST_CODE
// in config.js): the fictional +1 … 555 0100–0199 numbers sign in with one
// code on a stack that is not production, with no text and no Firebase. This
// file pins the parts that need no database: the production refusal, which
// numbers count, that neither leg ever reaches Identity Toolkit for them,
// that the code is checked, and that the ID token cannot be forged. The
// account and the invite are pinned against the full schema in
// tests/phone-test-numbers-postgres.test.js. SHOTS_PHONE_TEST_CODE, the
// same numbers on a before & after shots copy of Homeroom (which runs the
// production image as USERNODE_ENV=staging), is pinned here too.
//
// Run with: node --test tests/phone-test-numbers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const phoneAuth = require('../src/services/firebase-phone-auth');
const config = require('../src/config');

const { phoneTestCodeFrom, shotsPhoneTestCodeFrom } = config;

const TEST_ONLY = { phoneTestCode: '123456' };
const FIREBASE = {
  firebasePhoneAuthEnabled: true,
  firebaseWebApiKey: 'web-key',
  firebaseProjectId: 'proj',
  firebaseServiceAccountJsonB64: 'e30=',
};
const BOTH = { ...FIREBASE, ...TEST_ONLY };

const noFetch = async () => { throw new Error('Identity Toolkit must not be called for a test number'); };

// verifyIdToken's spent-once insert, without a database: the first sight of
// a hash claims it, a second is the replay.
function spendPool() {
  const seen = new Set();
  return {
    async query(sql, params) {
      assert.match(sql, /INSERT INTO phone_sign_in_tokens/);
      if (seen.has(params[0])) return { rows: [] };
      seen.add(params[0]);
      return { rows: [{ token_hash: params[0] }] };
    },
  };
}

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) {
    before[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

test('PHONE_TEST_CODE is six digits, and refused in production', () => {
  assert.deepEqual(phoneTestCodeFrom({}), { code: '', refused: null });
  assert.deepEqual(phoneTestCodeFrom({ PHONE_TEST_CODE: ' 123456 ' }), { code: '123456', refused: null });
  assert.deepEqual(phoneTestCodeFrom({ PHONE_TEST_CODE: '12345' }), { code: '', refused: 'not six digits' });
  assert.deepEqual(phoneTestCodeFrom({ PHONE_TEST_CODE: 'abcdef' }), { code: '', refused: 'not six digits' });
  assert.deepEqual(phoneTestCodeFrom({ PHONE_TEST_CODE: '123456', NODE_ENV: 'production' }),
    { code: '', refused: 'production' });
  assert.deepEqual(phoneTestCodeFrom({ PHONE_TEST_CODE: '123456', USERNODE_ENV: 'production' }),
    { code: '', refused: 'production' });
});

test('test numbers stay off in production even when a config object carries the code', () => {
  withEnv({ NODE_ENV: 'production', USERNODE_ENV: undefined }, () => {
    assert.equal(phoneAuth.testNumbersOn(TEST_ONLY), false);
    assert.equal(phoneAuth.offered(TEST_ONLY), false);
  });
  withEnv({ NODE_ENV: undefined, USERNODE_ENV: 'production' }, () => {
    assert.equal(phoneAuth.testNumbersOn(TEST_ONLY), false);
  });
  withEnv({ NODE_ENV: 'development', USERNODE_ENV: undefined }, () => {
    assert.equal(phoneAuth.testNumbersOn(TEST_ONLY), true);
  });
});

// A before & after shots copy of Homeroom runs the platform image
// (NODE_ENV=production) as USERNODE_ENV=staging, and the deployed platform
// hands it a random code per run (services/shots-environment.js).
const SHOTS_COPY = { NODE_ENV: 'production', USERNODE_ENV: 'staging', SHOTS_PHONE_TEST_CODE: '482913' };
const SHOTS_CODE = { phoneTestCode: '482913' };

test('SHOTS_PHONE_TEST_CODE is honoured only where USERNODE_ENV is staging, never in production', () => {
  assert.deepEqual(shotsPhoneTestCodeFrom({}), { code: '', refused: null });
  assert.deepEqual(shotsPhoneTestCodeFrom({ ...SHOTS_COPY, SHOTS_PHONE_TEST_CODE: ' 482913 ' }),
    { code: '482913', refused: null }, 'NODE_ENV=production does not refuse it on a shots copy');
  assert.deepEqual(shotsPhoneTestCodeFrom({ ...SHOTS_COPY, USERNODE_ENV: 'production' }),
    { code: '', refused: 'production' });
  assert.deepEqual(shotsPhoneTestCodeFrom({ SHOTS_PHONE_TEST_CODE: '482913', USERNODE_ENV: 'production' }),
    { code: '', refused: 'production' });
  for (const env of [undefined, '', 'Staging', 'development', 'test']) {
    assert.deepEqual(shotsPhoneTestCodeFrom({ SHOTS_PHONE_TEST_CODE: '482913', USERNODE_ENV: env }),
      { code: '', refused: 'not a shots copy' }, String(env));
  }
  assert.deepEqual(shotsPhoneTestCodeFrom({ ...SHOTS_COPY, SHOTS_PHONE_TEST_CODE: '4829' }),
    { code: '', refused: 'not six digits' });
  // PHONE_TEST_CODE keeps its own meaning: the image's NODE_ENV still
  // refuses it on a staging server, and it never reads the shots name.
  assert.deepEqual(phoneTestCodeFrom({ ...SHOTS_COPY, PHONE_TEST_CODE: '123456' }),
    { code: '', refused: 'production' });
  assert.deepEqual(phoneTestCodeFrom(SHOTS_COPY), { code: '', refused: null });
});

test('the re-check agrees: a shots copy takes only its own code; an ordinary preview and production refuse', () => {
  withEnv(SHOTS_COPY, () => {
    assert.equal(phoneAuth.testNumbersAllowed(SHOTS_CODE), true);
    assert.equal(phoneAuth.testNumbersOn(SHOTS_CODE), true);
    assert.equal(phoneAuth.offered(SHOTS_CODE), true);
    assert.equal(phoneAuth.testNumbersOn(TEST_ONLY), false, 'a config object carrying another code is not this copy\'s');
  });
  // An ordinary staging preview runs the same image as USERNODE_ENV=staging,
  // and is never given the code.
  withEnv({ ...SHOTS_COPY, SHOTS_PHONE_TEST_CODE: undefined }, () => {
    assert.equal(phoneAuth.testNumbersOn(SHOTS_CODE), false);
    assert.equal(phoneAuth.offered(SHOTS_CODE), false);
  });
  // Production refuses it even when somebody hands it the variable.
  withEnv({ ...SHOTS_COPY, USERNODE_ENV: 'production' }, () => {
    assert.equal(phoneAuth.testNumbersOn(SHOTS_CODE), false);
    assert.equal(phoneAuth.offered(SHOTS_CODE), false);
  });
  withEnv({ ...SHOTS_COPY, NODE_ENV: undefined, USERNODE_ENV: 'production' }, () => {
    assert.equal(phoneAuth.testNumbersOn(SHOTS_CODE), false);
  });
  // NODE_ENV=production with no USERNODE_ENV is not a shots copy either.
  withEnv({ ...SHOTS_COPY, USERNODE_ENV: undefined }, () => {
    assert.equal(phoneAuth.testNumbersOn(SHOTS_CODE), false);
  });
});

// config.load() as each runtime sees it, the boot lines captured.
function loadAs(env) {
  const required = {
    DATABASE_URL: 'postgres://localhost/test', SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass', PHONE_TEST_CODE: undefined,
  };
  const lines = [];
  return withEnv({ ...required, ...env }, () => {
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    try {
      return { loaded: config.load(), boot: lines.join('\n') };
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  });
}

test('a shots copy\'s own config offers phone sign-in and signs a test number in with the run\'s code', async () => {
  const { loaded, boot } = loadAs(SHOTS_COPY);
  assert.equal(loaded.phoneTestCode, '482913');
  assert.match(boot, /SHOTS_PHONE_TEST_CODE=\(set\)/);
  assert.doesNotMatch(boot, /482913/, 'the boot line never prints the code');

  const before = Object.fromEntries(Object.keys(SHOTS_COPY).map((key) => [key, process.env[key]]));
  Object.assign(process.env, SHOTS_COPY);
  try {
    assert.equal(phoneAuth.offered(loaded), true, 'the offer gate');
    const sent = await phoneAuth.requestCode(loaded, '+1 415 555 0142', null, { fetch: noFetch });
    await assert.rejects(
      () => phoneAuth.exchangeCode(loaded, sent.sessionInfo, '123456', { fetch: noFetch }),
      (err) => err.code === 'invalid_or_expired_code',
    );
    const { idToken } = await phoneAuth.exchangeCode(loaded, sent.sessionInfo, '482913', { fetch: noFetch });
    const claims = await phoneAuth.verifyIdToken(spendPool(), loaded, idToken, { auth: { verifyIdToken: noFetch } });
    assert.deepEqual(claims, { uid: 'test-phone:+14155550142', phoneNumber: '+14155550142', test: true },
      'the verify path');
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an ordinary staging preview\'s config, the same image without the code, offers no test numbers', () => {
  const { loaded, boot } = loadAs({ ...SHOTS_COPY, SHOTS_PHONE_TEST_CODE: undefined });
  assert.equal(loaded.phoneTestCode, '');
  assert.doesNotMatch(boot, /SHOTS_PHONE_TEST_CODE/);
  withEnv({ ...SHOTS_COPY, SHOTS_PHONE_TEST_CODE: undefined }, () => {
    assert.equal(phoneAuth.offered(loaded), false);
  });
});

test('the code alone offers phone sign-in; Firebase alone still does too', () => {
  assert.equal(phoneAuth.offered(TEST_ONLY), true);
  assert.equal(phoneAuth.firebaseOffered(TEST_ONLY), false);
  assert.equal(phoneAuth.offered(FIREBASE), true);
  assert.equal(phoneAuth.testNumbersOn(FIREBASE), false);
  assert.equal(phoneAuth.offered({ phoneTestCode: '12345' }), false, 'a malformed code offers nothing');
  assert.equal(phoneAuth.offered({}), false);
});

test('only +1, any area code, 555 0100–0199 is a test number', () => {
  for (const n of ['+14155550100', '+14155550199', '+12125550142']) {
    assert.equal(phoneAuth.isTestNumber(n), true, n);
  }
  for (const n of ['+14155550200', '+14155550099', '+15551234567', '+11235550100', '+447700900123', '', null]) {
    assert.equal(phoneAuth.isTestNumber(n), false, String(n));
  }
  assert.equal(phoneAuth.usesTestNumber(TEST_ONLY, '+1 (415) 555-0100'), true, 'display punctuation is fine');
  assert.equal(phoneAuth.usesTestNumber(FIREBASE, '+14155550100'), false, 'not without the code');
});

test('a test number gets a code without a text, and only the test code signs it in', async () => {
  const sent = await phoneAuth.requestCode(BOTH, '+1 415 555 0100', null, { fetch: noFetch });
  assert.equal(sent.phoneNumber, '+14155550100');
  assert.match(sent.sessionInfo, /^hr-test-session\./);

  await assert.rejects(
    () => phoneAuth.exchangeCode(BOTH, sent.sessionInfo, '654321', { fetch: noFetch }),
    (err) => err.code === 'invalid_or_expired_code',
  );
  const { idToken } = await phoneAuth.exchangeCode(BOTH, sent.sessionInfo, ' 123456 ', { fetch: noFetch });
  assert.match(idToken, /^hr-test-token\./);

  const pool = spendPool();
  const claims = await phoneAuth.verifyIdToken(pool, BOTH, idToken, { auth: { verifyIdToken: noFetch } });
  assert.deepEqual(claims, { uid: 'test-phone:+14155550100', phoneNumber: '+14155550100', test: true });
  await assert.rejects(
    () => phoneAuth.verifyIdToken(pool, BOTH, idToken),
    (err) => err.code === 'bad_token',
    'a test token is spent once, like any other',
  );
});

test('a sessionInfo rewritten to name a real number is refused', async () => {
  const tag = Buffer.from('+447700900123').toString('base64url');
  await assert.rejects(
    () => phoneAuth.exchangeCode(BOTH, `hr-test-session.${tag}.x`, '123456', { fetch: noFetch }),
    (err) => err.code === 'invalid_or_expired_code',
  );
});

test('a test token a client makes up is refused, so the idToken path cannot skip the code', async () => {
  const body = Buffer.from(JSON.stringify({ p: '+14155550100', n: 'x', e: Date.now() + 60000 })).toString('base64url');
  for (const forged of [`hr-test-token.${body}.nope`, `hr-test-token.${body}`, 'hr-test-token.']) {
    await assert.rejects(
      () => phoneAuth.verifyIdToken(spendPool(), BOTH, forged),
      (err) => err.code === 'bad_token',
      forged,
    );
  }
});

test('with the code switched off, nothing minted under it signs in', async () => {
  const sent = await phoneAuth.requestCode(BOTH, '+14155550101', null, { fetch: noFetch });
  const { idToken } = await phoneAuth.exchangeCode(BOTH, sent.sessionInfo, '123456');
  await assert.rejects(
    () => phoneAuth.exchangeCode(FIREBASE, sent.sessionInfo, '123456', { fetch: noFetch }),
    (err) => err.code === 'invalid_or_expired_code',
  );
  await assert.rejects(
    () => phoneAuth.verifyIdToken(spendPool(), FIREBASE, idToken, { auth: { verifyIdToken: noFetch } }),
    (err) => err.code === 'bad_token',
  );
});

test('test numbers only: any other number is refused in words, and nothing calls Firebase', async () => {
  await assert.rejects(
    () => phoneAuth.requestCode(TEST_ONLY, '+447700900123', null, { fetch: noFetch }),
    (err) => err.code === 'test_numbers_only' && err.status === 422 && /555 0100 to 0199/.test(err.message),
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(TEST_ONLY, 'a-firebase-session', '123456', { fetch: noFetch }),
    (err) => err.code === 'invalid_or_expired_code',
  );
  await assert.rejects(
    () => phoneAuth.verifyIdToken(spendPool(), TEST_ONLY, 'a-firebase-id-token'),
    (err) => err.code === 'bad_token',
  );
  assert.equal(await phoneAuth.recaptchaSiteKey(TEST_ONLY, { fetch: noFetch }), '',
    'no text, no reCAPTCHA: the sheet sends its request without a token');
  const outcome = await phoneAuth.sendTestCode(TEST_ONLY, '+447700900123', null, { fetch: noFetch });
  assert.equal(outcome.status, 'not_offered', 'the admin test is a real text, so it needs Firebase');
});

test('with Firebase set up too, a real number still texts through it', async () => {
  let called = null;
  const sent = await phoneAuth.requestCode(BOTH, '+447700900123', 'tok', {
    fetch: async (url, opts) => {
      called = { url, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ sessionInfo: 'firebase-session' }) };
    },
  });
  assert.equal(sent.sessionInfo, 'firebase-session');
  assert.match(called.url, /accounts:sendVerificationCode/);
  assert.equal(called.body.phoneNumber, '+447700900123');
});

test('without PHONE_TEST_CODE (production), a test number is still never texted', async () => {
  const sent = await phoneAuth.requestCode(FIREBASE, '+1 212 555 0142', 'tok', { fetch: noFetch });
  assert.match(sent.sessionInfo, /^hr-test-session\./);
  await assert.rejects(
    () => phoneAuth.exchangeCode(FIREBASE, sent.sessionInfo, '123456', { fetch: noFetch }),
    (err) => err.code === 'invalid_or_expired_code',
    'no fixed code, and no one-time code minted (no pool to spend one from)',
  );
});

test('a one-time code is spent through the pool, and its token carries who minted it', async () => {
  const bcrypt = require('bcrypt');
  const hash = bcrypt.hashSync('654321', 4);
  const tried = [];
  const pool = {
    async query(sql, params) {
      tried.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/SET attempts = attempts \+ 1/.test(sql)) return { rows: [{ id: '7', code_hash: hash, created_by: 3 }] };
      if (/SET used_at = NOW\(\)/.test(sql)) return { rows: [{ id: 7 }] };
      if (/INSERT INTO phone_sign_in_tokens/.test(sql)) return { rows: [{ token_hash: params[0] }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const sent = await phoneAuth.requestCode(FIREBASE, '+12125550142', null, { fetch: noFetch });
  withEnv({ NODE_ENV: 'production' }, () => assert.equal(phoneAuth.testNumbersOn(BOTH), false));
  const { idToken } = await phoneAuth.exchangeCode(FIREBASE, sent.sessionInfo, '654321', { pool, fetch: noFetch });
  const claims = await phoneAuth.verifyIdToken(pool, FIREBASE, idToken, { auth: { verifyIdToken: noFetch } });
  assert.deepEqual(claims, {
    uid: 'test-phone:+12125550142', phoneNumber: '+12125550142', test: true, testMintId: 7, testCreatedBy: 3,
  });
  assert.deepEqual(tried, ['UPDATE test_phone_sign_ins SET', 'UPDATE test_phone_sign_ins SET', 'INSERT INTO phone_sign_in_tokens']);
});
