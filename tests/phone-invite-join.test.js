'use strict';

// An invite's Join with a phone number (#4069's APIs, connected): a private
// member signs up with a phone, so the Join sheet asks for a name and a
// phone first whenever phone sign-in is offered (no username: the handle is
// picked from the name), the code request carries the reCAPTCHA Firebase
// asks a web caller for, an account with no verified phone is not made a
// private member by any of the ways a link is followed, and the waiting room
// lets such an account add one. The joining itself is pinned against
// PostgreSQL in tests/private-member-postgres.test.js, and #4069's own fixes
// (signed-out access, Firebase's error detail, reCAPTCHA) in
// tests/phone-auth-fixes.test.js.
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

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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
    open: true, title: 'Join Best brunch spots', intro: 'Just your name and phone number. No app, no password.',
    from: 'invite', followInvite: true, onClose() {}, primaryClass: 'pill', ...props,
  }));
  const phone = render({ phone: true, providers: ['apple', 'google'] });
  assert.match(phone, /data-sign-in-sheet="phone"/);
  assert.match(phone, /<label for="sign-in-sheet-name"[^>]*>Your name<\/label>/);
  assert.match(phone, /<label for="sign-in-sheet-phone"[^>]*>Phone number<\/label>/);
  assert.ok(phone.indexOf('sign-in-sheet-name') < phone.indexOf('sign-in-sheet-phone"'), 'the name first, as the canvas draws it');
  assert.match(phone, /The group sees your name, never your number\./);
  assert.doesNotMatch(phone, /username/i, 'no username is asked for');
  assert.match(phone, /id="sign-in-sheet-phone"[^>]*type="tel"[^>]*autoComplete="tel"|id="sign-in-sheet-phone"[^>]*type="tel"/);
  assert.match(phone, />Text me a code</);
  assert.match(phone, /Just your name and phone number\. No app, no password\./);
  assert.match(phone, /Already on Homeroom\? <a href="#login" data-sign-in-sheet-other-ways=""[^>]*>Sign in another way<\/a>/);
  assert.match(phone, /data-sign-in-sheet-recaptcha=""[^>]*>This is protected by reCAPTCHA/);
  assert.match(phone, /href="https:\/\/policies\.google\.com\/privacy"/);
  assert.doesNotMatch(phone, /Continue with Apple|Sign in with a password|This makes your account/, 'the other ways are one tap away, not first');
  assert.doesNotMatch(phone, /—/);
  // Without the offer it is the sheet it was.
  const before = render({ phone: false, providers: [], intro: 'Sign in or make an account with your email. It takes a minute.' });
  assert.match(before, /data-sign-in-sheet="email"/);
  assert.doesNotMatch(before, /Phone number|Your name|reCAPTCHA|Join with your phone/);

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
  assert.match(verify, /sessionInfo: phoneSession\.current,\s+code,\s+\.\.\.\(phoneName\.current \? \{ name: phoneName\.current \} : \{\}\),\s+\.\.\.\(followInvite \? \{ followInvite: true \} : \{\}\),/);
  assert.match(src, /if \(!name\) \{ setError\('Enter your name\.'\);/);
  assert.match(verify, /if \(data\.next === 'signed-in'\) \{\s+await finish\(data\.created === true \? 'new' : 'existing'\);/);
  assert.match(verify, /setUsernameVia\('phone'\);\s+setStep\('username'\);/);
  assert.match(src, /fetchSessionMint\(usernameVia === 'phone' \? '\/api\/auth\/phone\/finish' : '\/api\/auth\/oauth\/finish'/);
  assert.match(src, /'Check your texts'/);
  assert.match(src, /`We sent a 6-digit code to the number ending \$\{phoneNumber\.slice\(-4\)\}\.`/);
  assert.match(src, /The code fills itself in on most phones\./);
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
  // Only the phone screens reach for it: the sheet and the waiting room's card.
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && /from '\.\/recaptcha'|features\/auth\/recaptcha/.test(read(rel))) users.push(rel);
    }
  };
  walk('frontend/src');
  assert.deepEqual(users.sort(), [
    path.join('frontend/src/features/auth/add-phone.tsx'),
    path.join('frontend/src/features/auth/sign-in-sheet.tsx'),
  ]);
});

test('a new phone account gives a name: verify finishes it, with a handle picked from the name', () => {
  const { handlesFromName } = require('../src/services/usernames');
  assert.deepEqual(handlesFromName('Lina Park', 1), ['lina_park']);
  assert.deepEqual(handlesFromName('José Álvarez', 1), ['jose_alvarez']);
  assert.match(handlesFromName('Lina', 2)[1], /^lina_[0-9]{3,4}$/, 'then digits, for when it is taken');
  assert.deepEqual(handlesFromName('Al', 1), ['al_member'], 'too short alone');
  assert.deepEqual(handlesFromName('李小龙', 1), ['member'], 'nothing foldable');
  assert.match(handlesFromName('Homeroom Fan', 1)[0], /^member_[0-9]{3,4}$/, 'never a reserved prefix');
  for (const h of handlesFromName('O\'Brien-Smith the Third of Many Names', 4)) assert.match(h, /^[a-z0-9_]{3,32}$/);
  assert.equal(phoneAuth.cleanName('  Lina   Park '), 'Lina Park');
  assert.equal(phoneAuth.cleanName(''), null);
  assert.equal(phoneAuth.cleanName('x'.repeat(41)), null, 'the profile\'s 40');
  assert.equal(phoneAuth.cleanName('a\u0007b'), null);
  const routes = read('src/routes/phone-auth.js');
  const verify = routes.slice(routes.indexOf("router.post('/api/auth/phone/verify'"), routes.indexOf("router.post('/api/auth/phone/finish'"));
  assert.match(verify, /const name = result\.next === 'username' \? phoneAuth\.cleanName\(req\.body\?\.name\) : null;/);
  assert.match(verify, /phoneAuth\.finishWithName\(pool, \{ signupToken: result\.signupToken, name, createSession \}\)/);
  assert.ok(verify.indexOf('finishWithName') > verify.indexOf('redeemCarried'), 'the link is followed by the account first');
  assert.ok(verify.indexOf('finishWithName') < verify.indexOf("privateCookie(res, 'hr_phone_signup'"), 'before any username step');
});

test('a signed-in account adds a phone through routes the waiting room can reach', async () => {
  const routes = read('src/routes/phone-auth.js');
  // Limiters first, then the same-origin check (tests/same-site-browser.test.js).
  assert.match(routes, /router\.post\(\s+'\/api\/auth\/phone-link\/request',\s+requireOffered,\s+phoneOtpRequestLimiter,\s+phoneOtpRequestPhoneLimiter,\s+sameOriginBrowserOnly,\s+signedIn,/);
  assert.match(routes, /router\.post\(\s+'\/api\/auth\/phone-link\/verify',\s+requireOffered,\s+phoneVerifyLimiter,\s+sameOriginBrowserOnly,\s+signedIn,/);
  assert.match(routes, /const linked = await phoneAuth\.linkPhone\(pool, claims, req\.user\.id\);\s+const joined = await communityInvites\.joinQueued\(pool, req\.user\.id\);/);
  // Under /api/auth/, which the platform-access gate leaves open to a waiting
  // account, and outside the pre-login /api/auth/phone/, so the session is read.
  const auth = read('src/middleware/auth.js');
  assert.match(auth, /const GATE_OPEN_PATHS = \[[\s\S]*?'\/api\/auth\/',/);
  assert.equal('/api/auth/phone-link/verify'.startsWith('/api/auth/phone/'), false);
  // Signed out, with the offer off, it answers its own gate.
  const { authMiddleware } = require('../src/middleware/auth');
  const { phoneAuthRoutes } = require('../src/routes/phone-auth');
  const app = express();
  app.use(express.json());
  app.use(authMiddleware({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' }));
  app.use(phoneAuthRoutes({ firebasePhoneAuthEnabled: false }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/auth/phone-link/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401, 'no session: the session middleware answers, not the phone route');
  });
});

test('the waiting room: a queued group can be joined now by adding a phone, and lands in its app', () => {
  const { AddPhoneCard } = loadTsx('frontend/src/features/auth/add-phone.tsx');
  const card = renderToHtml(createElement(AddPhoneCard, { groups: ['Best brunch spots'], onJoined() {} }));
  assert.match(card, /data-add-phone="phone"/);
  assert.match(card, />Join Best brunch spots now</);
  assert.match(card, /Add your phone number and you’re in, no waiting\. The group sees your name, never your number\./);
  assert.match(card, /<label for="add-phone-number"[^>]*>Phone number<\/label>/);
  assert.match(card, />Text me a code</);
  assert.match(card, /This is protected by reCAPTCHA/);
  assert.doesNotMatch(card, /—/);
  const two = renderToHtml(createElement(AddPhoneCard, { groups: ['A', 'B'], onJoined() {} }));
  assert.match(two, />Join them now</);
  const src = read('frontend/src/features/auth/add-phone.tsx');
  assert.match(src, /fetch\('\/api\/auth\/phone-link\/request'/);
  assert.match(src, /fetch\('\/api\/auth\/phone-link\/verify'/);
  const waiting = read('frontend/src/features/auth/waiting.tsx');
  assert.match(waiting, /setPhoneOffered\(options\?\.phone_sign_in === true\);/);
  assert.match(waiting, /\{phoneOffered && queued\.length \? \(\s+<AddPhoneCard groups=\{queued\.map\(\(q\) => q\.name\)\} onJoined=\{onJoined\} \/>/);
  assert.match(waiting, /if \(host && joined\[0\]\?\.slug\) host\._pendingHash = `\/app\/\$\{joined\[0\]\.slug\}`;\s+void check\(\);/);
  // deepLinkUrl takes that app path as it is.
  assert.match(read('public/js/auth-screens.js'), /if \(value\.startsWith\('\/app\/'\)\) return value;/);
});
