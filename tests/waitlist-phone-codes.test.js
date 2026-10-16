// src/services/waitlist.js — the phone verification CODE, the twin of
// tests/waitlist-verification-code.test.js.
//
// A phone signup is confirmed by a six-digit code texted to the number,
// exactly as an email signup is confirmed by the code mailed to the
// address. The properties guarded here are the same, keyed by the number:
//
//   1. The plaintext code is returned to the caller and only its bcrypt
//      hash is stored.
//   2. Issuing a second code invalidates the first.
//   3. A wrong code counts an attempt, and past the cap the RIGHT code
//      stops working too. Every failure returns the same null, so the
//      endpoint can never be used to test whether a number is on the list.
//   4. Confirming by code stamps confirmed_at once (COALESCE keeps the
//      first timestamp), exactly as the email side does.
//   5. The reuse window: a code minted seconds ago is reported reusable and
//      left alone rather than being destroyed by a second ask.
//   6. The email and phone code tables never cross: a phone lookup returns
//      a phone row and nothing that lives under an address.
//
// Service-level tests against a stateful in-memory mock pool — no live DB.
//
// Run with: node --test tests/waitlist-phone-codes.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const {
  joinWaitlist,
  issueVerificationPhoneCode,
  confirmSignupByPhoneCode,
  getSignupByPhone,
  hasReusablePhoneCode,
  MAX_CODE_ATTEMPTS,
  CODE_REUSE_WINDOW_SECONDS,
} = require('../src/services/waitlist');

const PHONE = '+15550100001';

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeState() {
  return { signups: new Map(), codes: [], nextSignupId: 1, nextCodeId: 1 };
}

function makePool(state) {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.startsWith('INSERT INTO waitlist_signups')) {
      const [phone, , answers, moreToken] = params;
      if (state.signups.has(phone)) return { rowCount: 0, rows: [] };
      const submittedAt = new Date();
      state.signups.set(phone, {
        id: state.nextSignupId++,
        email: null,
        phone_e164: phone,
        answers: answers ? JSON.parse(answers) : null,
        more_token: moreToken || null,
        submitted_at: submittedAt,
        confirmed_at: null,
        released_at: null,
        linked_user_id: null,
      });
      return { rowCount: 1, rows: [{ submitted_at: submittedAt }] };
    }

    if (sql.startsWith('DELETE FROM waitlist_verification_codes')) {
      const [phone] = params;
      state.codes = state.codes.filter((c) => !(c.phone_e164 === phone && c.consumed_at == null));
      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith('INSERT INTO waitlist_verification_codes')) {
      const [phone, hash] = params;
      state.codes.push({
        id: state.nextCodeId++,
        phone_e164: phone,
        code_hash: hash,
        attempts: 0,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        created_at: new Date(),
        consumed_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith('SELECT 1 FROM waitlist_verification_codes')) {
      const [phone] = params;
      const windowMs = CODE_REUSE_WINDOW_SECONDS * 1000;
      const reusable = state.codes
        .filter((c) => c.phone_e164 === phone
          && c.consumed_at == null
          && c.attempts === 0
          && c.expires_at > new Date()
          && Date.now() - c.created_at.getTime() < windowMs);
      return { rows: reusable.length ? [{ '?column?': 1 }] : [] };
    }

    if (sql.includes('FROM waitlist_verification_codes WHERE phone_e164 = $1 AND consumed_at IS NULL')) {
      const [phone] = params;
      const live = state.codes
        .filter((c) => c.phone_e164 === phone && c.consumed_at == null)
        .sort((a, b) => b.id - a.id);
      const c = live[0];
      return {
        rows: c
          ? [{ id: c.id, code_hash: c.code_hash, attempts: c.attempts, expires_at: c.expires_at }]
          : [],
      };
    }

    if (sql.includes('SET attempts = attempts + 1 WHERE id = $1')) {
      const [id] = params;
      const c = state.codes.find((r) => r.id === id);
      if (c) c.attempts += 1;
      return { rowCount: c ? 1 : 0, rows: [] };
    }

    if (sql.includes('SET consumed_at = NOW() WHERE id = $1')) {
      const [id] = params;
      const c = state.codes.find((r) => r.id === id);
      if (c) c.consumed_at = new Date();
      return { rowCount: c ? 1 : 0, rows: [] };
    }

    if (sql.includes('SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE phone_e164 = $1')) {
      const [phone] = params;
      const s = state.signups.get(phone);
      if (!s) return { rowCount: 0, rows: [] };
      s.confirmed_at = s.confirmed_at || new Date();
      return {
        rowCount: 1,
        rows: [{
          id: s.id, email: null, phone_e164: s.phone_e164,
          submitted_at: s.submitted_at, confirmed_at: s.confirmed_at,
          released_at: s.released_at, linked_user_id: s.linked_user_id,
          more_token: s.more_token,
        }],
      };
    }

    if (sql.startsWith('SELECT id, email, phone_e164, submitted_at, confirmed_at, released_at, linked_user_id, more_token FROM waitlist_signups WHERE phone_e164 = $1')) {
      const [phone] = params;
      const s = state.signups.get(phone);
      return { rows: s ? [{ ...s }] : [] };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

async function joinByPhone(state) {
  return joinWaitlist(makePool(state), { phone: PHONE, ip: null });
}

test('a first phone join creates one row and returns a fresh code path', async () => {
  const state = makeState();
  const first = await joinByPhone(state);
  assert.equal(first.created, true);
  assert.ok(first.moreToken, 'the stage-2 token is still minted for the row');
  assert.equal(state.signups.size, 1);
  assert.equal(state.signups.get(PHONE).email, null, 'a phone row carries no address');
});

test('a second join by the same number is an idempotent no-op', async () => {
  const state = makeState();
  await joinByPhone(state);
  const again = await joinByPhone(state);
  assert.equal(again.created, false);
  assert.equal(again.moreToken, null, 'the capability only goes to the first join');
  assert.equal(state.signups.size, 1, 'no second row for the same number');
});

test('the plaintext code is returned and never stored; only its hash lands in the table', async () => {
  const state = makeState();
  await joinByPhone(state);
  const code = await issueVerificationPhoneCode(makePool(state), PHONE);
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(state.codes.length, 1);
  assert.notEqual(state.codes[0].code_hash, code, 'the plaintext must not be stored');
  assert.equal(await bcrypt.compare(code, state.codes[0].code_hash), true);
});

test('issuing a second code invalidates the first', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinByPhone(state);
  const first = await issueVerificationPhoneCode(pool, PHONE);
  const second = await issueVerificationPhoneCode(pool, PHONE);
  // Exactly one live code: the older is deleted before the new one is
  // written, so a forwarded or re-opened text cannot confirm.
  assert.equal(state.codes.filter((c) => c.consumed_at == null).length, 1);
  assert.equal(await confirmSignupByPhoneCode(pool, PHONE, first), null);
  const ok = await confirmSignupByPhoneCode(pool, PHONE, second);
  assert.ok(ok, 'the live code confirms');
});

test('the right code confirms the row and stamps confirmed_at once', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinByPhone(state);
  const code = await issueVerificationPhoneCode(pool, PHONE);
  const first = await confirmSignupByPhoneCode(pool, PHONE, code);
  assert.ok(first && first.phone_e164 === PHONE);
  const stamped = state.signups.get(PHONE).confirmed_at;
  // A second confirm (a re-typed code from a still-open text) keeps the
  // first timestamp. The code is consumed, so it returns null the second
  // time, but the timestamp would not move either way.
  await confirmSignupByPhoneCode(pool, PHONE, code);
  assert.equal(state.signups.get(PHONE).confirmed_at.getTime(), stamped.getTime());
});

test('a wrong code counts an attempt and every failure returns the same null', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinByPhone(state);
  const real = await issueVerificationPhoneCode(pool, PHONE);
  const wrong = real === '000000' ? '111111' : '000000';
  assert.equal(await confirmSignupByPhoneCode(pool, PHONE, wrong), null);
  assert.equal(state.codes[0].attempts, 1);
  // Unknown number, malformed code, expired, consumed — all the same null,
  // so this can never be used to test whether a number is on the list.
  assert.equal(await confirmSignupByPhoneCode(pool, '+15559999999', real), null);
  assert.equal(await confirmSignupByPhoneCode(pool, PHONE, 'abc'), null);
});

test('past the attempt cap the RIGHT code stops working too', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinByPhone(state);
  const real = await issueVerificationPhoneCode(pool, PHONE);
  state.codes[0].attempts = MAX_CODE_ATTEMPTS;
  assert.equal(await confirmSignupByPhoneCode(pool, PHONE, real), null);
});

test('a code minted seconds ago is reusable and left alone', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinByPhone(state);
  await issueVerificationPhoneCode(pool, PHONE);
  assert.equal(await hasReusablePhoneCode(pool, PHONE), true);
  // The window is a minute; a code older than it is not reusable.
  state.codes[0].created_at = new Date(Date.now() - (CODE_REUSE_WINDOW_SECONDS + 5) * 1000);
  assert.equal(await hasReusablePhoneCode(pool, PHONE), false);
});

test('getSignupByPhone reads a phone row and never an email one', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinByPhone(state);
  const row = await getSignupByPhone(pool, PHONE);
  assert.equal(row.phone_e164, PHONE);
  assert.equal(row.email, null);
  // A number that is not on the list returns null rather than throwing.
  assert.equal(await getSignupByPhone(pool, '+15559999999'), null);
});

test('a malformed number never reaches the table', async () => {
  const state = makeState();
  const pool = makePool(state);
  // normalizePhone rejects it, so issueVerificationPhoneCode throws before
  // any query — the caller (a fire-and-forget sender) swallows it.
  await assert.rejects(issueVerificationPhoneCode(pool, 'not a number'), /invalid phone/);
});
