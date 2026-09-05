// Tests for the auth rate-limit split.
//
// The auth surface used to sit behind ONE bucket — `authLimiter`, 10
// requests / 15 min / IP — shared by twelve endpoints across password
// login, email-code signup, password recovery and wallet auth, counting
// successes as well as failures. Two consequences this file pins:
//
//   - An honest journey from one address could exhaust it. A three-step
//     OTP signup with a resend and a mistyped code spends seven of the
//     ten, and a run of wrong passwords could throttle the password reset
//     that fixes them. Both are now separate buckets.
//   - Nothing bounded guessing against ONE account. The per-identifier
//     bucket is the new half, and its keying is what these tests check:
//     per target rather than per source, case-normalized, successes
//     refunded, and identical for an identifier that names no account.
//
// Harness style follows tests/rate-limits.test.js: the limiters are
// mounted on stand-in routes rather than the real handlers, because what
// is under test is the ARRANGEMENT of limiters, not the auth logic behind
// them (tests/login-email-identifier.test.js and tests/password-reset.test.js
// exercise the real routes with these same limiters mounted, and they no
// longer need the pass-through stub they used to install). Limiter stores
// are module-level singletons and every test here shares 127.0.0.1, so the
// module is dropped from require.cache per test to get fresh buckets.
//
// Run with: node --test tests/auth-rate-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const RATE_LIMITS_PATH = require.resolve('../src/middleware/rate-limits');

// Fresh limiter stores, a throwaway app, real HTTP. `?fail=1` makes a
// stand-in route answer 401 so skipSuccessfulRequests can be exercised;
// the refund lands on response-finish, which stubbed req/res never emit.
async function withAuthLimiters(fn) {
  delete require.cache[RATE_LIMITS_PATH];
  let server;
  try {
    const L = require('../src/middleware/rate-limits');
    const app = express();
    app.use(express.json());
    const stand = (req, res) =>
      (req.query.fail === '1' ? res.status(401).json({ error: 'nope' }) : res.json({ ok: true }));

    // The same stacks, in the same order, as src/routes/auth.js mounts.
    app.post('/login', L.loginBurstLimiter, L.loginSustainedLimiter, L.loginIdentityLimiter, stand);
    app.post('/identity-only', L.loginIdentityLimiter, stand);
    app.post('/otp/request', L.otpRequestLimiter, L.otpRequestEmailLimiter, stand);
    app.post('/otp/verify', L.otpVerifyLimiter, stand);
    app.post('/otp/set-password', L.otpVerifyLimiter, stand);
    app.post('/reset/request', L.passwordResetRequestLimiter, L.passwordResetRequestEmailLimiter, stand);
    app.post('/reset/confirm', L.passwordResetConfirmLimiter, stand);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server) server.close();
    delete require.cache[RATE_LIMITS_PATH];
  }
}

function post(base, path, body = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a full OTP signup journey from one address never hits a 429', async () => {
  await withAuthLimiters(async (base) => {
    const email = 'newcomer@example.invalid';
    // Request a code, wait, resend because it did not arrive.
    for (const attempt of [1, 2]) {
      const res = await post(base, '/otp/request', { email });
      assert.notEqual(res.status, 429, `code request #${attempt} was throttled`);
    }
    // Mistype the code three times, then get it right.
    for (const attempt of [1, 2, 3]) {
      const res = await post(base, '/otp/verify?fail=1', { email, code: '000000' });
      assert.notEqual(res.status, 429, `code attempt #${attempt} was throttled`);
    }
    assert.notEqual((await post(base, '/otp/verify', { email, code: '123456' })).status, 429);
    // Choose a password, which is what actually creates the session.
    assert.notEqual((await post(base, '/otp/set-password', {})).status, 429);
  });
});

test('wrong passwords never throttle the password reset that fixes them', async () => {
  await withAuthLimiters(async (base) => {
    // Enough failures to trip the login burst bucket several times over —
    // the old shared bucket would have been spent well before the reset.
    for (let i = 0; i < 12; i += 1) {
      await post(base, '/login?fail=1', { username: 'forgetful', password: 'nope' });
    }
    assert.equal(
      (await post(base, '/reset/request', { email: 'forgetful@example.invalid' })).status,
      200,
      'the reset request drew on the login bucket',
    );
    assert.equal(
      (await post(base, '/reset/confirm', { token: 'x', newPassword: 'correcthorse' })).status,
      200,
      'the reset redemption drew on the login bucket',
    );
  });
});

test('successful sign-ins are refunded, so a shared address is not capped', async () => {
  await withAuthLimiters(async (base) => {
    // Thirty successful sign-ins is three times the whole old bucket and
    // stands in for an office behind one NAT.
    for (let i = 0; i < 30; i += 1) {
      const res = await post(base, '/login', { username: `person${i}`, password: 'right' });
      assert.notEqual(res.status, 429, `sign-in #${i + 1} was throttled`);
    }
  });
});

test('the burst bucket answers in about a minute, not fifteen', async () => {
  await withAuthLimiters(async (base) => {
    let throttled = null;
    for (let i = 0; i < 8; i += 1) {
      const res = await post(base, '/login?fail=1', { username: 'mistyper', password: 'nope' });
      if (res.status === 429) { throttled = await res.json(); break; }
    }
    assert.ok(throttled, 'six rapid failures should trip the burst bucket');
    assert.ok(
      throttled.retryAfterSeconds > 0 && throttled.retryAfterSeconds <= 60,
      `expected a wait of at most a minute, got ${throttled.retryAfterSeconds}s`,
    );
    assert.match(throttled.error, /under a minute/);
  });
});

test('the identifier bucket bounds one target without touching another', async () => {
  await withAuthLimiters(async (base) => {
    for (let i = 0; i < 10; i += 1) {
      const res = await post(base, '/identity-only?fail=1', { username: 'alice' });
      assert.notEqual(res.status, 429, `alice failure #${i + 1} was throttled early`);
    }
    assert.equal(
      (await post(base, '/identity-only?fail=1', { username: 'alice' })).status,
      429,
      'the 11th failure against one account must be throttled',
    );
    assert.notEqual(
      (await post(base, '/identity-only?fail=1', { username: 'bob' })).status,
      429,
      'a second account from the same address must have its own budget',
    );
  });
});

test('the identifier bucket is case-normalized, so casing is not a bypass', async () => {
  await withAuthLimiters(async (base) => {
    for (let i = 0; i < 10; i += 1) {
      await post(base, '/identity-only?fail=1', { username: i % 2 ? 'Alice' : ' alice ' });
    }
    assert.equal(
      (await post(base, '/identity-only?fail=1', { username: 'ALICE' })).status,
      429,
      'casing and surrounding space split one account into several buckets',
    );
  });
});

test('an identifier naming no account is bucketed identically, so the 429 is no oracle', async () => {
  await withAuthLimiters(async (base) => {
    const trip = async (username) => {
      for (let i = 0; i < 10; i += 1) await post(base, '/identity-only?fail=1', { username });
      const res = await post(base, '/identity-only?fail=1', { username });
      assert.equal(res.status, 429);
      const body = await res.json();
      return { error: body.error, keys: Object.keys(body).sort().join(',') };
    };
    const known = await trip('alice');
    const unknown = await trip('no-such-account-anywhere');
    assert.equal(unknown.error, known.error, 'the refusal text differs by whether the account exists');
    assert.equal(unknown.keys, known.keys, 'the refusal body shape differs by whether the account exists');
  });
});

test('successful sign-ins never fill the identifier bucket', async () => {
  await withAuthLimiters(async (base) => {
    for (let i = 0; i < 25; i += 1) {
      const res = await post(base, '/identity-only', { username: 'alice' });
      assert.notEqual(res.status, 429, `successful sign-in #${i + 1} was throttled`);
    }
  });
});

test('one mailbox cannot be flooded, while other recipients are unaffected', async () => {
  await withAuthLimiters(async (base) => {
    for (let i = 0; i < 5; i += 1) {
      const res = await post(base, '/otp/request', { email: 'victim@example.invalid' });
      assert.notEqual(res.status, 429, `code request #${i + 1} was throttled early`);
    }
    assert.equal(
      (await post(base, '/otp/request', { email: 'victim@example.invalid' })).status,
      429,
      'a sixth code to one address in the window must be refused',
    );
    assert.notEqual(
      (await post(base, '/otp/request', { email: 'someone-else@example.invalid' })).status,
      429,
      'a different recipient must have its own budget',
    );
  });
});

test('throttles stay code-free, so billing 429s keep their discriminator', async () => {
  await withAuthLimiters(async (base) => {
    let body = null;
    for (let i = 0; i < 8; i += 1) {
      const res = await post(base, '/login?fail=1', { username: 'mistyper', password: 'nope' });
      if (res.status === 429) { body = await res.json(); break; }
    }
    assert.ok(body);
    assert.equal(body.code, undefined, 'throttle 429s must stay code-free (budget_exceeded is the billing discriminator)');
    assert.ok(Number.isFinite(body.retryAfterSeconds));
  });
});
