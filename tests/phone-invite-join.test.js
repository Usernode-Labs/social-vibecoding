'use strict';

// An invite's Join with a phone number (#4069's APIs, connected): a private
// member signs up with a phone, so the Join sheet asks for one first whenever
// phone sign-in is offered, the endpoints answer a signed-out visitor, the
// code request carries the reCAPTCHA Firebase asks a web caller for, and an
// account with no verified phone is not made a private member by any of the
// ways a link is followed. The joining itself is pinned against PostgreSQL in
// tests/private-member-postgres.test.js.
//
// Run with: node --test tests/phone-invite-join.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const phoneAuth = require('../src/services/firebase-phone-auth');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';

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
});

test('Firebase refusing the reCAPTCHA is recaptcha_required, a 422 the sheet can say in words', async () => {
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
});

test('every way a link is followed asks for the phone while phone sign-in is offered', () => {
  const offered = /requirePhone: phoneAuth\.offered\(config\)/;
  assert.match(read('src/routes/community-invites.js'), offered, 'Join pressed while signed in');
  assert.match(read('src/routes/auth.js'), offered, 'the email code');
  assert.match(read('src/routes/sign-in-providers.js'), offered, 'Apple and Google');
  assert.match(read('src/routes/phone-auth.js'), /redeemCarried\(pool, req, res, result\.userId, \{ requirePhone: true \}\)/);
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /async function redeem\(pool, \{ token, user, browser = null, requirePhone = false \}\)/);
  assert.match(svc, /joinAsPrivateMember\(client, user\.id, redemptionId, \{ requirePhone \}\)/);
  assert.match(svc, /const result = await redeem\(pool, \{ token, user, browser, requirePhone \}\);/);
  // Checked before anything joins them, so a refusal leaves the row queued.
  const join = svc.slice(svc.indexOf('async function joinAsPrivateMember('));
  assert.ok(join.indexOf('user_phone_identities') < join.indexOf('apply_community_invite'));
  assert.match(read('src/middleware/auth.js'), /'\/api\/auth\/oauth\/',[\s\S]{0,400}'\/api\/auth\/phone\/',/);
});

test('the invite\'s Join sheet starts with a phone number when the server offers it', () => {
  const { SignInSheet, phoneE164 } = loadTsx(SHEET);
  const render = (props) => renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Join Best brunch spots', intro: 'Join with your phone number. We’ll text you a 6-digit code.',
    from: 'invite', followInvite: true, onClose() {}, primaryClass: 'pill', ...props,
  }));
  const phone = render({ phone: true, providers: ['apple', 'google'] });
  assert.match(phone, /data-sign-in-sheet="phone"/);
  assert.match(phone, /<label for="sign-in-sheet-phone"[^>]*>Phone number<\/label>/);
  assert.match(phone, /id="sign-in-sheet-phone"[^>]*type="tel"[^>]*autoComplete="tel"|id="sign-in-sheet-phone"[^>]*type="tel"/);
  assert.match(phone, />Text me a code</);
  assert.match(phone, /Join with your phone number/);
  assert.match(phone, /Already on Homeroom\? <a href="#login" data-sign-in-sheet-other-ways=""[^>]*>Sign in another way<\/a>/);
  assert.match(phone, /data-sign-in-sheet-recaptcha=""[^>]*>This is protected by reCAPTCHA/);
  assert.match(phone, /href="https:\/\/policies\.google\.com\/privacy"/);
  assert.doesNotMatch(phone, /Continue with Apple|Sign in with a password|This makes your account/, 'the other ways are one tap away, not first');
  assert.doesNotMatch(phone, /—/);
  // Without the offer it is the sheet it was.
  const before = render({ phone: false, providers: [], intro: 'Sign in or make an account with your email. It takes a minute.' });
  assert.match(before, /data-sign-in-sheet="email"/);
  assert.doesNotMatch(before, /Phone number|reCAPTCHA|Join with your phone/);

  // The number goes as the server takes it; no country code is guessed.
  assert.equal(phoneE164('+1 (415) 555-0123'), '+14155550123');
  assert.equal(phoneE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(phoneE164('+1.415.555.0123'), '+14155550123');
  assert.equal(phoneE164('4155550123'), null);
  assert.equal(phoneE164('+0 415'), null);
  assert.equal(phoneE164(''), null);
});

test('the sheet\'s phone steps: the code, then the username on the phone\'s own route', () => {
  const src = read(SHEET);
  assert.match(src, /const firstStep: Step = phone \? 'phone' : otherWays;/);
  assert.match(src, /const recaptchaToken = await phoneRecaptchaToken\(\);\s+const res = await fetch\('\/api\/auth\/phone\/request'/);
  assert.match(src, /body: JSON\.stringify\(\{ phoneNumber: value, \.\.\.\(recaptchaToken \? \{ recaptchaToken \} : \{\}\) \}\)/);
  const verify = src.slice(src.indexOf('const verifyPhone = useCallback'), src.indexOf('const finishAccount = useCallback'));
  assert.match(verify, /fetchSessionMint\('\/api\/auth\/phone\/verify'/);
  assert.match(verify, /sessionInfo: phoneSession\.current, code, \.\.\.\(followInvite \? \{ followInvite: true \} : \{\}\)/);
  assert.match(verify, /if \(data\.next === 'signed-in'\) \{\s+await finish\(data\.created === true \? 'new' : 'existing'\);/);
  assert.match(verify, /setUsernameVia\('phone'\);\s+setStep\('username'\);/);
  assert.match(src, /fetchSessionMint\(usernameVia === 'phone' \? '\/api\/auth\/phone\/finish' : '\/api\/auth\/oauth\/finish'/);
  assert.match(src, /'Check your messages'/);
  assert.match(src, /`We texted a 6-digit code to \$\{phoneNumber\}\.`/);
  // The landing hands the offer to the invite's sheet only.
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const phoneSignIn = waitlistPayload\?\.phone_sign_in === true;/);
  assert.equal((landing.match(/phone=\{phoneSignIn\}/g) || []).length, 1);
  assert.ok(landing.indexOf('phone={phoneSignIn}') < landing.indexOf('{storyOn ? (\n        <SignInSheet'));
  assert.match(read('frontend/src/features/auth/waitlist-shared.tsx'), /phone_sign_in\?: boolean;/);
});

test('Google\'s script loads only for a phone code, never with the shell', () => {
  const src = read('frontend/src/features/auth/recaptcha.ts');
  assert.match(src, /const SCRIPT_SRC = 'https:\/\/www\.google\.com\/recaptcha\/api\.js\?render=explicit';/);
  assert.match(src, /fetch\('\/api\/auth\/phone\/recaptcha'/);
  assert.match(src, /size: 'invisible',\s+badge: 'inline',/);
  assert.doesNotMatch(read('frontend/src/head.html'), /recaptcha/i);
  // Only the sheet reaches for it.
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && /from '\.\/recaptcha'|features\/auth\/recaptcha/.test(read(rel))) users.push(rel);
    }
  };
  walk('frontend/src');
  assert.deepEqual(users, [path.join('frontend/src/features/auth/sign-in-sheet.tsx')]);
});
