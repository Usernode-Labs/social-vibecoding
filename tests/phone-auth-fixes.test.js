'use strict';

// Phone sign-in (#4069), the fixes found wiring it to a screen: its
// endpoints answer a signed-out visitor, Firebase's `CODE : detail` refusals
// are read with their detail, a refused reCAPTCHA says so, and the reCAPTCHA
// site key a web client needs is served. The rest is tests/phone-auth.test.js.
//
// Run with: node --test tests/phone-auth-fixes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const phoneAuth = require('../src/services/firebase-phone-auth');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const FULL_CONFIG = {
  firebasePhoneAuthEnabled: true,
  firebaseWebApiKey: 'web-key',
  firebaseProjectId: 'proj',
  firebaseServiceAccountJsonB64: 'e30=',
};

function answer(data, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => data });
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a signed-out visitor reaches the phone endpoints, which answer for themselves', async () => {
  const { authMiddleware } = require('../src/middleware/auth');
  const { phoneAuthRoutes } = require('../src/routes/phone-auth');
  const app = express();
  app.use(express.json());
  // Mounted the way server.js mounts them: behind the session middleware.
  app.use(authMiddleware({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' }));
  app.use(phoneAuthRoutes({ firebasePhoneAuthEnabled: false }));
  await withServer(app, async (base) => {
    for (const [method, route] of [['POST', 'request'], ['POST', 'verify'], ['POST', 'finish'], ['GET', 'recaptcha']]) {
      const res = await fetch(`${base}/api/auth/phone/${route}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(res.status, 404, `${route}: its own not_offered, not the session middleware's 401`);
      assert.equal((await res.json()).code, 'not_offered');
    }
  });
  assert.match(read('src/middleware/auth.js'), /'\/api\/auth\/oauth\/',[\s\S]{0,400}'\/api\/auth\/phone\/',/);
});

test('Firebase\'s refusals are read with their detail, `CODE : detail`', async () => {
  await assert.rejects(
    () => phoneAuth.requestCode(FULL_CONFIG, '+15551234567', 'token', {
      fetch: answer({ error: { message: 'INVALID_PHONE_NUMBER : Invalid format.' } }, { ok: false, status: 400 }),
    }),
    (err) => err.code === 'invalid_phone' && err.status === 422
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '000000', {
      fetch: answer({ error: { message: 'INVALID_CODE : The SMS code is wrong.' } }, { ok: false, status: 400 }),
    }),
    (err) => err.code === 'invalid_or_expired_code'
  );
  await assert.rejects(
    () => phoneAuth.exchangeCode(FULL_CONFIG, 's', '000000', {
      fetch: answer({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER : Try later.' } }, { ok: false, status: 400 }),
    }),
    (err) => err.code === 'too_many_attempts' && err.status === 429
  );
});

test('Firebase refusing the reCAPTCHA is recaptcha_required, a 422 a client can say in words', async () => {
  for (const code of ['MISSING_APP_CREDENTIAL', 'INVALID_APP_CREDENTIAL', 'MISSING_RECAPTCHA_TOKEN', 'INVALID_RECAPTCHA_TOKEN', 'CAPTCHA_CHECK_FAILED']) {
    await assert.rejects(
      () => phoneAuth.requestCode(FULL_CONFIG, '+15551234567', null, {
        fetch: answer({ error: { message: `${code} : details` } }, { ok: false, status: 400 }),
      }),
      (err) => err.code === 'recaptcha_required' && err.status === 422 && /person/.test(err.message),
      code
    );
  }
});

test('the reCAPTCHA site key is the Firebase project\'s own, read once an hour', async () => {
  await assert.rejects(() => phoneAuth.recaptchaSiteKey({ firebasePhoneAuthEnabled: false }), (err) => err.code === 'not_offered');
  const config = { ...FULL_CONFIG, firebaseWebApiKey: 'site-key-test' };
  const asked = [];
  const fetchKey = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ recaptchaSiteKey: '6Lc-site' }) }; };
  let now = 1_000_000;
  assert.equal(await phoneAuth.recaptchaSiteKey(config, { fetch: fetchKey, now: () => now }), '6Lc-site');
  assert.equal(await phoneAuth.recaptchaSiteKey(config, { fetch: fetchKey, now: () => now }), '6Lc-site');
  assert.equal(asked.length, 1, 'kept');
  assert.match(asked[0], /\/v1\/recaptchaParams\?key=site-key-test$/);
  now += 61 * 60 * 1000;
  await phoneAuth.recaptchaSiteKey(config, { fetch: fetchKey, now: () => now });
  assert.equal(asked.length, 2, 'read again after an hour');
  await assert.rejects(
    () => phoneAuth.recaptchaSiteKey({ ...FULL_CONFIG, firebaseWebApiKey: 'no-key' }, { fetch: answer({}) }),
    (err) => err.code === 'firebase_unreachable' && err.status === 502
  );
  // Served by the phone router, behind its offer gate.
  const routes = read('src/routes/phone-auth.js');
  assert.match(routes, /router\.get\('\/api\/auth\/phone\/recaptcha', requireOffered, async/);
  assert.match(routes, /const siteKey = await phoneAuth\.recaptchaSiteKey\(config\);\s+res\.setHeader\('Cache-Control', 'no-store'\);\s+return res\.json\(\{ siteKey \}\);/);
});
