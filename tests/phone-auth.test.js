'use strict';

// Unit tests for services/firebase-phone-auth.js — the parts that need no
// database: the fail-closed offer gate, E.164 normalization, the Identity
// Toolkit error mapping (a 429 here is Firebase's, so it CAN carry a code),
// and the ID-token claims checks. The account transaction itself is pinned
// against real PostgreSQL in tests/phone-auth-postgres.test.js.
//
// Run with: node --test tests/phone-auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const phoneAuth = require('../src/services/firebase-phone-auth');

const FULL_CONFIG = {
  firebasePhoneAuthEnabled: true,
  firebaseWebApiKey: 'web-key',
  firebaseProjectId: 'proj',
  firebaseServiceAccountJsonB64: 'e30=',
};

function fetchStub(respond) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = respond(url, body);
    return {
      ok: result.ok !== false,
      status: result.status || 200,
      json: async () => result.data || {},
    };
  };
}

test('the offer gate is all-or-nothing across the four Firebase values', () => {
  assert.equal(phoneAuth.offered(FULL_CONFIG), true);
  assert.equal(phoneAuth.offered({ ...FULL_CONFIG, firebasePhoneAuthEnabled: false }), false,
    'the flag must be explicitly true');
  assert.equal(phoneAuth.offered({ ...FULL_CONFIG, firebaseWebApiKey: '' }), false,
    'no web API key, no offer — the endpoints must 404, not 502');
  assert.equal(phoneAuth.offered({ ...FULL_CONFIG, firebaseProjectId: '' }), false);
  assert.equal(phoneAuth.offered({ ...FULL_CONFIG, firebaseServiceAccountJsonB64: '' }), false);
  assert.equal(phoneAuth.offered(undefined), false);
  assert.equal(phoneAuth.offered({}), false);
});

test('request and verify refuse to run at all when not offered', async () => {
  await assert.rejects(
    () => phoneAuth.requestCode({ firebasePhoneAuthEnabled: false }, '+15551234567'),
    (err) => err.code === 'not_offered' && err.status === 404,
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode({ firebaseWebApiKey: '' }, 's', '123456'),
    (err) => err.code === 'not_offered' && err.status === 404,
  );
});

test('normalizePhone strips display punctuation and enforces E.164', () => {
  assert.equal(phoneAuth.normalizePhone('+15551234567'), '+15551234567');
  assert.equal(phoneAuth.normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assert.equal(phoneAuth.normalizePhone('+44 20 7946 0958'), '+442079460958');
  // No default country code is ever guessed: a number without `+` is
  // refused, not assumed American.
  assert.equal(phoneAuth.normalizePhone('15551234567'), null);
  assert.equal(phoneAuth.normalizePhone('5551234567'), null);
  assert.equal(phoneAuth.normalizePhone('+0115551234567'), null, 'trunk 0 is not E.164');
  assert.equal(phoneAuth.normalizePhone('+'), null);
  assert.equal(phoneAuth.normalizePhone('+155512345678901234'), null, 'over 15 digits');
  assert.equal(phoneAuth.normalizePhone(''), null);
  assert.equal(phoneAuth.normalizePhone(null), null);
  assert.equal(phoneAuth.normalizePhone(undefined), null);
  assert.equal(phoneAuth.normalizePhone(15551234567), null);
});

test('request asks Firebase to text the code and hands back its sessionInfo', async () => {
  let seen = null;
  const sent = await phoneAuth.requestCode(
    FULL_CONFIG,
    '+1 (555) 123-4567',
    'recaptcha-token',
    { fetch: fetchStub((url, body) => {
      seen = { url, body };
      return { data: { sessionInfo: 'session-info-1' } };
    }) }
  );
  assert.equal(sent.phoneNumber, '+15551234567');
  assert.equal(sent.sessionInfo, 'session-info-1');
  assert.match(seen.url, /accounts:sendVerificationCode\?key=web-key$/);
  assert.deepEqual(seen.body, { phoneNumber: '+15551234567', recaptchaToken: 'recaptcha-token' });
});

test('an invalid number is refused locally, before any text is sent', async () => {
  await assert.rejects(
    () => phoneAuth.requestCode(FULL_CONFIG, '5551234567', null, {
      fetch: () => { throw new Error('must not be called'); },
    }),
    (err) => err.code === 'invalid_phone' && err.status === 422,
  );
});

test('Identity Toolkit errors map onto this API’s codes', async () => {
  const refusing = (message) => ({
    fetch: fetchStub(() => ({ ok: false, status: 400, data: { error: { message } } })),
  });
  // The code (or its session) is wrong or stale.
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '000000', refusing('INVALID_CODE')),
    (err) => err.code === 'invalid_or_expired_code' && err.status === 422,
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '000000', refusing('SESSION_EXPIRED')),
    (err) => err.code === 'invalid_or_expired_code',
  );
  // Firebase's own attempt ceiling: 429, and it CAN carry a code — the
  // code-free rule is for the platform's own throttles.
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '000000', refusing('TOO_MANY_ATTEMPTS_TRY_LATER')),
    (err) => err.code === 'too_many_attempts' && err.status === 429,
  );
  await assert.rejects(
    () => phoneAuth.requestCode(FULL_CONFIG, '+15551234567', null, refusing('INVALID_PHONE_NUMBER')),
    (err) => err.code === 'invalid_phone',
  );
  // Anything unmapped is 502, with no hint at which knob is missing. (A
  // refused reCAPTCHA is mapped: the caller fixes it with a fresh token,
  // tests/phone-auth-fixes.test.js.)
  await assert.rejects(
    () => phoneAuth.requestCode(FULL_CONFIG, '+15551234567', null, refusing('OPERATION_NOT_ALLOWED: whatever')),
    (err) => err.code === 'firebase_unreachable' && err.status === 502,
  );
});

test('an unreachable Firebase answers 502, not a crash', async () => {
  await assert.rejects(
    () => phoneAuth.requestCode(FULL_CONFIG, '+15551234567', null, {
      fetch: async () => { throw new Error('ECONNREFUSED'); },
    }),
    (err) => err.code === 'firebase_unreachable' && err.status === 502,
  );
});

test('a sessionInfo or idToken Firebase never sent is 502, never a half-answer', async () => {
  await assert.rejects(
    () => phoneAuth.requestCode(FULL_CONFIG, '+15551234567', null, {
      fetch: fetchStub(() => ({ data: {} })),
    }),
    (err) => err.code === 'firebase_unreachable',
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '123456', {
      fetch: fetchStub(() => ({ data: { idToken: '' } })),
    }),
    (err) => err.code === 'firebase_unreachable',
  );
});

test('a malformed sessionInfo or code is refused without a round trip', async () => {
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, '', '123456', {
      fetch: () => { throw new Error('must not be called'); },
    }),
    (err) => err.code === 'invalid_or_expired_code',
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's'.repeat(4097), '123456', {
      fetch: () => { throw new Error('must not be called'); },
    }),
    (err) => err.code === 'invalid_or_expired_code',
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '1'.repeat(17), {
      fetch: () => { throw new Error('must not be called'); },
    }),
    (err) => err.code === 'invalid_or_expired_code',
  );
});

// ── The ID token ────────────────────────────────────────────────────────

function fakePoolSpendingOnce(spent) {
  return { query: async () => ({ rows: spent ? [{ token_hash: 'x' }] : [] }) };
}

const GOOD_PAYLOAD = {
  uid: 'firebase-uid-1',
  sub: 'firebase-uid-1',
  phone_number: '+15551234567',
  firebase: { sign_in_provider: 'phone' },
  exp: Math.floor(Date.now() / 1000) + 3600,
};

test('a phone-issued ID token verifies to its uid and normalized number', async () => {
  const claims = await phoneAuth.verifyIdToken(
    fakePoolSpendingOnce(true),
    FULL_CONFIG,
    'id-token',
    { auth: { verifyIdToken: async () => ({ ...GOOD_PAYLOAD }) } }
  );
  assert.deepEqual(claims, { uid: 'firebase-uid-1', phoneNumber: '+15551234567' });
});

test('a token that is not from phone sign-in never mints an account', async () => {
  const verifier = { verifyIdToken: async () => ({
    ...GOOD_PAYLOAD,
    firebase: { sign_in_provider: 'password' },
  }) };
  await assert.rejects(
    () => phoneAuth.verifyIdToken(fakePoolSpendingOnce(true), FULL_CONFIG, 'id-token', { auth: verifier }),
    (err) => err.code === 'bad_token' && err.status === 502,
  );
});

test('a token without a usable phone_number claim is refused', async () => {
  const verifier = { verifyIdToken: async () => ({ ...GOOD_PAYLOAD, phone_number: '5551234567' }) };
  await assert.rejects(
    () => phoneAuth.verifyIdToken(fakePoolSpendingOnce(true), FULL_CONFIG, 'id-token', { auth: verifier }),
    (err) => err.code === 'bad_token',
  );
});

test('a token whose signature does not verify is refused', async () => {
  const verifier = { verifyIdToken: async () => { throw new Error('invalid signature'); } };
  await assert.rejects(
    () => phoneAuth.verifyIdToken(fakePoolSpendingOnce(true), FULL_CONFIG, 'forged', { auth: verifier }),
    (err) => err.code === 'bad_token',
  );
});

test('an oversized or empty token is refused before verification', async () => {
  const auth = { verifyIdToken: async () => { throw new Error('must not be called'); } };
  await assert.rejects(
    () => phoneAuth.verifyIdToken(fakePoolSpendingOnce(true), FULL_CONFIG, 'x'.repeat(8193), { auth }),
    (err) => err.code === 'bad_token',
  );
  await assert.rejects(
    () => phoneAuth.verifyIdToken(fakePoolSpendingOnce(true), FULL_CONFIG, '', { auth }),
    (err) => err.code === 'bad_token',
  );
  await assert.rejects(
    () => phoneAuth.verifyIdToken(fakePoolSpendingOnce(true), FULL_CONFIG, null, { auth }),
    (err) => err.code === 'bad_token',
  );
});

test('an ID token is spent once: the replay is refused, not signed in again', async () => {
  // First use claims the token (the insert wins); the replay loses the
  // ON CONFLICT and is refused — the rule native_sign_in_tokens pins.
  const first = await phoneAuth.verifyIdToken(
    fakePoolSpendingOnce(true), FULL_CONFIG, 'id-token',
    { auth: { verifyIdToken: async () => ({ ...GOOD_PAYLOAD }) } }
  );
  assert.equal(first.uid, 'firebase-uid-1');
  await assert.rejects(
    () => phoneAuth.verifyIdToken(
      fakePoolSpendingOnce(false), FULL_CONFIG, 'id-token',
      { auth: { verifyIdToken: async () => ({ ...GOOD_PAYLOAD }) } }
    ),
    (err) => err.code === 'bad_token',
  );
});

// ── Admin → SMS delivery's test send ────────────────────────────────────

test('sendTestCode makes the same send and answers "sent" without the sessionInfo', async () => {
  let seen = null;
  const outcome = await phoneAuth.sendTestCode(FULL_CONFIG, '+1 (555) 123-4567', 'tok', {
    fetch: fetchStub((url, body) => { seen = { url, body }; return { data: { sessionInfo: 'secret-session' } }; }),
  });
  assert.match(seen.url, /accounts:sendVerificationCode\?key=web-key/);
  assert.deepEqual(seen.body, { phoneNumber: '+15551234567', recaptchaToken: 'tok' });
  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.phoneNumber, '+15551234567');
  assert.equal(outcome.providerCode, null);
  assert.ok(!JSON.stringify(outcome).includes('secret-session'));
});

test('sendTestCode reports Firebase\'s own code on a refusal, without its detail', async () => {
  const outcome = await phoneAuth.sendTestCode(FULL_CONFIG, '+15551234567', null, {
    fetch: fetchStub(() => ({ ok: false, status: 400, data: { error: { message: 'INVALID_PHONE_NUMBER : TOO_SHORT' } } })),
  });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.providerCode, 'INVALID_PHONE_NUMBER');
  assert.equal(outcome.httpStatus, 400);
});

test('sendTestCode does not echo a message that is not a code', async () => {
  const outcome = await phoneAuth.sendTestCode(FULL_CONFIG, '+15551234567', null, {
    fetch: fetchStub(() => ({ ok: false, status: 500, data: { error: { message: 'something <b>odd</b>' } } })),
  });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.providerCode, null);
});

test('sendTestCode answers "unreachable" when no answer comes back', async () => {
  const outcome = await phoneAuth.sendTestCode(FULL_CONFIG, '+15551234567', null, {
    fetch: async () => { throw new Error('ETIMEDOUT'); },
  });
  assert.equal(outcome.status, 'unreachable');
});

test('sendTestCode sends nothing when phone sign-in is not offered, or the number is malformed', async () => {
  const never = { fetch: () => { throw new Error('must not be called'); } };
  const outcome = await phoneAuth.sendTestCode({ ...FULL_CONFIG, firebaseProjectId: '' }, '+15551234567', null, never);
  assert.equal(outcome.status, 'not_offered');
  await assert.rejects(
    () => phoneAuth.sendTestCode(FULL_CONFIG, '5551234567', null, never),
    (e) => e.code === 'invalid_phone' && e.status === 400);
});
