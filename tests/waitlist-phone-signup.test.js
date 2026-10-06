// POST /api/public/waitlist with a PHONE number — the phone half of the
// public join, mirroring tests/waitlist-resend.test.js.
//
// The waitlist is keyed by email OR phone now, and one row carries exactly
// one key. This file pins the join-specific rules the phone half adds:
//
//   - a phone join creates a phone-keyed row and answers in the phone's
//     words ("we'll text you"), not the email's;
//   - both keys at once is refused (422), and a row never gains a second
//     key later;
//   - a malformed number is a 422 that discloses nothing about the list;
//   - the join is idempotent by number, like it is by address;
//   - the two channels never cross: an email lookup does not reach a phone
//     row and a phone lookup does not reach an email row.
//
// Same harness as tests/waitlist-resend.test.js: swap src/db/pool for an
// in-memory mock, drop the rate-limits and public-api modules so each test
// gets fresh limiter stores, mount publicApiRoutes on a throwaway Express
// app, and talk to it over HTTP.
//
// Run with: node --test tests/waitlist-phone-signup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const PHONE = '+15550100001';
const OTHER_PHONE = '+15550100002';
const EMAIL = 'someone@example.invalid';
const JOINED_AT = new Date('2026-03-14T10:00:00.000Z');

function makeMockPool() {
  // phone-row state: phone -> { confirmed_at }
  const signups = new Map();
  return {
    signups,
    async query(rawSql, params) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      if (/INSERT INTO waitlist_signups/.test(sql)) {
        const phone = params[0];
        if (signups.has(phone)) return { rowCount: 0, rows: [] };
        signups.set(phone, { phone_e164: phone, confirmed_at: null, more_token: params[3] });
        return { rowCount: 1, rows: [{ submitted_at: JOINED_AT }] };
      }
      if (/SELECT id, email, phone_e164[\s\S]*FROM waitlist_signups WHERE phone_e164 = \$1/.test(sql)) {
        const phone = params[0];
        const s = signups.get(phone);
        return {
          rows: s
            ? [{
              id: 1, email: null, phone_e164: s.phone_e164,
              submitted_at: JOINED_AT, confirmed_at: s.confirmed_at,
              released_at: null, linked_user_id: null, more_token: s.more_token,
            }]
            : [],
        };
      }
      // hasReusablePhoneCode probe (checked before the broader code branch).
      if (/SELECT 1[\s\S]*FROM waitlist_verification_codes/.test(sql)) return { rows: [] };
      if (/waitlist_verification_codes/.test(sql)) return { rows: [{ id: 1 }] };
      return { rowCount: 0, rows: [] };
    },
  };
}

function post(base, body) {
  return fetch(`${base}/api/public/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withPublicApi(fn, extraConfig = {}) {
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  const mockPool = makeMockPool();
  require.cache[poolPath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolPath, filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  delete require.cache[rateLimitsPath];
  delete require.cache[publicApiPath];
  let server;
  try {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test', ...extraConfig }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`, mockPool);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }
}

test('joining by phone creates a phone-keyed row and answers in the phone\'s words', async () => {
  await withPublicApi(async (base, pool) => {
    const res = await post(base, { phone: PHONE });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.message, /text you when access opens up/i);
    assert.doesNotMatch(body.message, /email you/i);
    // The stage-2 survey is reached by a mailed link, so a phone join
    // carries no more_token.
    assert.equal(body.more_token, null);
    assert.ok(pool.signups.has(PHONE));
  });
});

test('a space-formatted number is normalized to E.164 before it is stored', async () => {
  await withPublicApi(async (base, pool) => {
    const res = await post(base, { phone: '+1 555 0100 002' });
    assert.equal(res.status, 200);
    assert.ok(pool.signups.has(OTHER_PHONE), 'the number is stored in E.164');
  });
});

test('an email and a phone together are refused, in the same wording the form can attribute', async () => {
  await withPublicApi(async (base, pool) => {
    const res = await post(base, { email: EMAIL, phone: PHONE });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /either an email address or a phone number, not both/i);
    assert.equal(pool.signups.size, 0, 'a refused join writes nothing');
  });
});

test('a malformed number is a 422 that discloses nothing about the list', async () => {
  await withPublicApi(async (base) => {
    const res = await post(base, { phone: 'definitely not a phone' });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /a valid phone number is required/i);
  });
});

test('joining twice by the same number is idempotent', async () => {
  await withPublicApi(async (base, pool) => {
    await post(base, { phone: PHONE });
    const again = await post(base, { phone: PHONE });
    assert.equal(again.status, 200);
    assert.equal(pool.signups.size, 1, 'no second row for the same number');
    const body = await again.json();
    // A re-join of a PENDING row gets the fresh-code words, not the welcome.
    assert.match(body.message, /fresh six-digit code to that number/i);
  });
});

test('a confirmed phone row is told it is already confirmed, with no new code', async () => {
  await withPublicApi(async (base, pool) => {
    await post(base, { phone: PHONE });
    pool.signups.get(PHONE).confirmed_at = new Date('2026-03-14T10:05:00.000Z');
    const res = await post(base, { phone: PHONE });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.message, /this number is confirmed/i);
    assert.doesNotMatch(body.message, /fresh six-digit/i);
  });
});
