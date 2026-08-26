// src/services/waitlist.js — the email verification CODE that rides beside
// the one-click confirm link. The onboarding doc's "Simpler waitlist flow
// proposal" asks for "Email + verification code"; what shipped was a link
// only, which is one click on desktop and awkward on a phone, where leaving
// for the mail app loses the WebView's place. Both work now and both stamp
// the same confirmed_at.
//
// Same shape and same guarantees as mobile_otp_codes, deliberately: bcrypt
// hashed, one live code per address, capped attempts, short expiry.
//
// Contracts guarded here:
//
//   1. The plaintext code is returned to the caller and NEVER stored — only
//      its bcrypt hash lands in the table.
//   2. Issuing a second code invalidates the first, so a forwarded or
//      re-opened older mail cannot confirm.
//   3. A wrong code increments attempts and, past the cap, the RIGHT code
//      stops working too. Every failure returns the same null — unknown
//      email, wrong code, expired, consumed, capped — so the endpoint can
//      never be used to test whether an address is on the list.
//   4. Confirming by code is idempotent with confirming by link: both stamp
//      confirmed_at and the FIRST timestamp wins.
//
// Service-level tests against a stateful in-memory mock pool — no live DB,
// same idiom as tests/onboarding-waitlist.test.js.
//
// Run with: node --test tests/waitlist-verification-code.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  joinWaitlist,
  issueVerificationCode,
  confirmSignupByCode,
  confirmSignupByMoreToken,
  MAX_CODE_ATTEMPTS,
} = require('../src/services/waitlist');

// ─── Stateful mock pool ───────────────────────────────────────────────
//
// Simulates the rows the code paths touch:
//   state.signups — Map(email -> { id, email, more_token, confirmed_at })
//   state.codes   — [{ id, email, code_hash, attempts, expires_at, consumed_at }]

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
      const [email, , answers, moreToken] = params;
      if (state.signups.has(email)) return { rowCount: 0, rows: [] };
      state.signups.set(email, {
        id: state.nextSignupId++,
        email,
        answers: answers ? JSON.parse(answers) : null,
        more_token: moreToken || null,
        confirmed_at: null,
        released_at: null,
        linked_user_id: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith('DELETE FROM waitlist_verification_codes')) {
      const [email] = params;
      state.codes = state.codes.filter((c) => !(c.email === email && c.consumed_at == null));
      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith('INSERT INTO waitlist_verification_codes')) {
      const [email, hash] = params;
      state.codes.push({
        id: state.nextCodeId++,
        email,
        code_hash: hash,
        attempts: 0,
        // The real column is NOW() + INTERVAL '15 minutes'.
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        consumed_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes('FROM waitlist_verification_codes WHERE email = $1 AND consumed_at IS NULL')) {
      const [email] = params;
      const live = state.codes
        .filter((c) => c.email === email && c.consumed_at == null)
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

    if (sql.includes('SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE email = $1')) {
      const [email] = params;
      const s = state.signups.get(email);
      if (!s) return { rowCount: 0, rows: [] };
      s.confirmed_at = s.confirmed_at || new Date();
      return {
        rowCount: 1,
        rows: [{
          id: s.id, email: s.email, confirmed_at: s.confirmed_at, more_token: s.more_token,
        }],
      };
    }

    if (sql.includes('WHERE more_token = $1')) {
      const [token] = params;
      const s = [...state.signups.values()].find((r) => r.more_token === token);
      return { rows: s ? [{ id: s.id, email: s.email, answers: s.answers }] : [] };
    }

    if (sql.includes('SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = $1')) {
      const [id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      if (!s) return { rowCount: 0, rows: [] };
      s.confirmed_at = s.confirmed_at || new Date();
      return { rowCount: 1, rows: [{ id: s.id, email: s.email, confirmed_at: s.confirmed_at }] };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

function fixture() {
  const state = makeState();
  return { state, pool: makePool(state) };
}

// ─── 1. The plaintext code never lands in the table ───────────────────

test('the plaintext code is returned but never stored', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(state.codes.length, 1);
  assert.notEqual(state.codes[0].code_hash, code);
  // A bcrypt hash, not the digits with extra characters around them.
  assert.match(state.codes[0].code_hash, /^\$2[aby]\$/);
});

test('issueVerificationCode normalizes the address it keys on', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  await issueVerificationCode(pool, '  A@Example.COM ');
  assert.equal(state.codes[0].email, 'a@example.com');
});

test('issueVerificationCode refuses a non-address rather than minting a code', async () => {
  const { pool, state } = fixture();
  await assert.rejects(() => issueVerificationCode(pool, 'not-an-email'));
  assert.equal(state.codes.length, 0);
});

// ─── 2. One live code per address ─────────────────────────────────────

test('issuing a second code invalidates the first', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const first = await issueVerificationCode(pool, 'a@example.com');
  const second = await issueVerificationCode(pool, 'a@example.com');
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', first), null);
  assert.ok(await confirmSignupByCode(pool, 'a@example.com', second));
});

// ─── 3. Failures are indistinguishable, and the cap is real ───────────

test('the right code confirms the signup and returns its stage-2 token', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  const row = await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(row);
  assert.ok(row.confirmed_at);
  assert.match(row.more_token, /^[a-f0-9]{48}$/);
});

test('a used code cannot be used twice', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  assert.ok(await confirmSignupByCode(pool, 'a@example.com', code));
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('too many wrong guesses kill the code even for the right answer', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
    assert.equal(await confirmSignupByCode(pool, 'a@example.com', '000000'), null);
  }
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('an expired code is refused', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  state.codes[0].expires_at = new Date(Date.now() - 1000);
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('an unknown email returns the same null a wrong code does', async () => {
  const { pool } = fixture();
  assert.equal(await confirmSignupByCode(pool, 'nobody@example.com', '123456'), null);
});

test('a malformed code never reaches the database', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  await issueVerificationCode(pool, 'a@example.com');

  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, 123456]) {
    assert.equal(await confirmSignupByCode(pool, 'a@example.com', bad), null);
  }
});

// ─── 4. Code and link are one confirmation, not two ───────────────────

test('the link and the code stamp the same row, and the first wins', async () => {
  const { pool, state } = fixture();
  const { moreToken } = await joinWaitlist(pool, { email: 'a@example.com' });

  const byLink = await confirmSignupByMoreToken(pool, moreToken);
  assert.ok(byLink.confirmed_at);
  const first = state.signups.get('a@example.com').confirmed_at;

  const code = await issueVerificationCode(pool, 'a@example.com');
  const byCode = await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(byCode);
  assert.equal(state.signups.get('a@example.com').confirmed_at, first);
});
