'use strict';

// Cookies that carry a token or a sign-in binder are named `__Host-` when
// they are Secure (src/services/browser-session-cookies.js
// protectedCookieName). A browser accepts that name only Secure, Path=/ and
// with no Domain, so an app on a sibling host (<slug>.onhomeroom.com) cannot
// plant one for the platform to read. Plain-HTTP development keeps the bare
// name. Each cookie's writer, reader and clear make the same decision, and no
// reader falls back to the bare name where the prefixed one is due: that is
// the cookie a sibling host can plant.
//
//   usernode_signup                       src/routes/auth.js (NODE_ENV)
//   hr_oauth_binder, hr_oauth_signup,
//   hr_oauth_result                       src/routes/sign-in-providers.js (NODE_ENV)
//   hr_phone_signup                       src/routes/phone-auth.js (NODE_ENV)
//   hr_invite                             src/services/community-invites.js (the request)
//   hr_iv, hr_iv_src                      src/services/invite-activity.js (the request)
//
// The page reads hr_oauth_result itself (frontend/src/features/auth/landing.tsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const { protectedCookieName, requestCookieSecure } = require('../src/services/browser-session-cookies');
const auth = require('../src/routes/auth');
const oauth = require('../src/routes/sign-in-providers');
const phone = require('../src/routes/phone-auth');
const invites = require('../src/services/community-invites');
const activity = require('../src/services/invite-activity');
const { loadTsx } = require('./lib/render-tsx');

async function withNodeEnv(value, fn) {
  const prior = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
}

function recorder() {
  const set = [];
  const cleared = [];
  const res = {
    cookie: (name, value, opts) => set.push({ name, value, opts }),
    clearCookie: (name, opts) => cleared.push({ name, opts }),
    set() {},
    redirect() {},
  };
  return { set, cleared, res };
}

// What a browser demands of a `__Host-` cookie, writing or clearing it.
function assertHostCookie(name, opts, base) {
  assert.equal(name, `__Host-${base}`);
  assert.equal(opts.secure, true, `${name} is Secure`);
  assert.equal(opts.path, '/', `${name} is Path=/`);
  assert.equal('domain' in opts, false, `${name} names no Domain`);
}

const HTTPS = Object.freeze({ 'x-forwarded-proto': 'https' });

test('the rule: the __Host- name when Secure, the bare name on plain HTTP', () => {
  assert.equal(protectedCookieName('hr_invite', true), '__Host-hr_invite');
  assert.equal(protectedCookieName('hr_invite', false), 'hr_invite');
  // A cookie decided by the request: always Secure in production, else when
  // the request reached the proxy over HTTPS.
  assert.equal(requestCookieSecure({ headers: {} }, { NODE_ENV: 'production' }), true);
  assert.equal(requestCookieSecure({}, { NODE_ENV: 'production' }), true);
  assert.equal(requestCookieSecure({ headers: HTTPS }, {}), true);
  assert.equal(requestCookieSecure({ headers: { 'x-forwarded-proto': 'https, http' } }, {}), true);
  assert.equal(requestCookieSecure({ secure: true, headers: {} }, {}), true);
  assert.equal(requestCookieSecure({ headers: { 'x-forwarded-proto': 'http' } }, {}), false);
  assert.equal(requestCookieSecure({ headers: {} }, { NODE_ENV: 'development' }), false);
  assert.equal(requestCookieSecure({}, {}), false);
});

// The sign-in continuations and the OAuth binder: Secure exactly when
// NODE_ENV is production, as the session cookie is.
const SIGN_IN_COOKIES = [
  {
    base: 'usernode_signup',
    write: (res) => auth.createSignupCookie(res, 'fake-signup-token', new Date(Date.now() + 3600e3)),
    read: (req) => auth.readSignupCookie(req),
    clear: (res) => auth.clearSignupCookie(res),
  },
  {
    base: 'hr_oauth_binder',
    write: (res) => oauth.privateCookie(res, oauth.BINDER_COOKIE, 'fake-signup-token', 600e3),
    read: (req) => oauth.readPrivateCookie(req, oauth.BINDER_COOKIE),
    clear: (res) => oauth.clearPrivateCookie(res, oauth.BINDER_COOKIE),
  },
  {
    base: 'hr_oauth_signup',
    write: (res) => oauth.privateCookie(res, oauth.SIGNUP_COOKIE, 'fake-signup-token', 600e3),
    read: (req) => oauth.readPrivateCookie(req, oauth.SIGNUP_COOKIE),
    clear: (res) => oauth.clearPrivateCookie(res, oauth.SIGNUP_COOKIE),
  },
  {
    base: 'hr_phone_signup',
    write: (res) => phone.privateCookie(res, 'hr_phone_signup', 'fake-signup-token', new Date(Date.now() + 3600e3)),
    read: (req) => phone.readPrivateCookie(req, 'hr_phone_signup'),
    clear: (res) => phone.clearPrivateCookie(res, 'hr_phone_signup'),
  },
];

test('in production the sign-in cookies are __Host-, read only by that name, and cleared with its attributes', async () => {
  await withNodeEnv('production', () => {
    for (const { base, write, read, clear } of SIGN_IN_COOKIES) {
      const { set, cleared, res } = recorder();
      write(res);
      assert.equal(set.length, 1, base);
      assertHostCookie(set[0].name, set[0].opts, base);
      assert.equal(set[0].opts.httpOnly, true, `${base} stays HttpOnly`);
      assert.equal(set[0].opts.sameSite, 'lax', `${base} stays SameSite=Lax`);
      assert.equal(read({ cookies: { [`__Host-${base}`]: 'fake-signup-token' } }), 'fake-signup-token', base);
      // What a sibling host can plant is never read.
      assert.equal(read({ cookies: { [base]: 'planted' } }), undefined, `${base}: the bare name is ignored`);
      clear(res);
      assert.equal(cleared.length, 1, base);
      assertHostCookie(cleared[0].name, cleared[0].opts, base);
      assert.deepEqual(cleared[0].opts, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, base);
    }
  });
});

test('on plain-HTTP development the sign-in cookies keep their bare names, at Path=/', async () => {
  await withNodeEnv('development', () => {
    for (const { base, write, read, clear } of SIGN_IN_COOKIES) {
      const { set, cleared, res } = recorder();
      write(res);
      assert.equal(set[0].name, base);
      assert.equal(set[0].opts.secure, false, base);
      assert.equal(set[0].opts.path, '/', base);
      assert.equal(read({ cookies: { [base]: 'fake-signup-token' } }), 'fake-signup-token', base);
      clear(res);
      assert.deepEqual(cleared[0], { name: base, opts: { httpOnly: true, secure: false, sameSite: 'lax', path: '/' } });
    }
  });
});

test('the way back\'s outcome, which the page reads: __Host- and not HttpOnly in production', async () => {
  await withNodeEnv('production', () => {
    const { set, res } = recorder();
    oauth.goBack(res, '/', 'username');
    assertHostCookie(set[0].name, set[0].opts, 'hr_oauth_result');
    assert.equal(set[0].opts.httpOnly, false, 'the page reads it');
    assert.equal(set[0].value, 'username');
  });
  await withNodeEnv('development', () => {
    const { set, res } = recorder();
    oauth.goBack(res, '/', 'error-expired');
    assert.equal(set[0].name, 'hr_oauth_result');
    assert.equal(set[0].opts.secure, false);
  });
});

test('the page reads the outcome by the name its protocol earns, and clears it with Secure over HTTPS', () => {
  const { takeProviderResult } = loadTsx('frontend/src/features/auth/landing.tsx');
  const jar = (cookie) => {
    const writes = [];
    return { writes, doc: { get cookie() { return cookie; }, set cookie(v) { writes.push(v); } } };
  };
  const https = jar('other=1; __Host-hr_oauth_result=username');
  assert.equal(takeProviderResult(https.doc, true), 'username');
  assert.deepEqual(https.writes, ['__Host-hr_oauth_result=; Max-Age=0; path=/; Secure']);
  // Over HTTPS the bare name is what a sibling host could plant: never read.
  const planted = jar('hr_oauth_result=username');
  assert.equal(takeProviderResult(planted.doc, true), null);
  assert.deepEqual(planted.writes, []);
  const dev = jar('hr_oauth_result=error-expired');
  assert.equal(takeProviderResult(dev.doc, false), 'error-expired');
  assert.deepEqual(dev.writes, ['hr_oauth_result=; Max-Age=0; path=/']);
  assert.equal(takeProviderResult(jar('__Host-hr_oauth_result=username').doc, false), null);
  assert.equal(takeProviderResult(undefined, true), null);
});

test('a carried invite link is __Host- over HTTPS and in production, and its readers ignore the bare name there', async () => {
  await withNodeEnv('development', async () => {
    const https = { headers: HTTPS, cookies: {} };
    const { set, cleared, res } = recorder();
    invites.setInviteCookie(https, res, 'fake-invite-token');
    assertHostCookie(set[0].name, set[0].opts, 'hr_invite');
    assert.equal(set[0].opts.httpOnly, true);
    assert.equal(set[0].opts.sameSite, 'lax');
    assert.equal(set[0].opts.maxAge, 7 * 24 * 60 * 60 * 1000);
    assert.equal(invites.carriedToken({ headers: HTTPS, cookies: { '__Host-hr_invite': 'fake-invite-token' } }), 'fake-invite-token');
    assert.equal(invites.carriedToken({ headers: HTTPS, cookies: { hr_invite: 'planted' } }), undefined);
    invites.clearInviteCookie(https, res);
    assert.deepEqual(cleared[0], { name: '__Host-hr_invite', opts: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' } });

    // Plain HTTP: the bare name, both ways.
    const plain = recorder();
    invites.setInviteCookie({ headers: {}, cookies: {} }, plain.res, 'fake-invite-token');
    assert.equal(plain.set[0].name, 'hr_invite');
    assert.equal(plain.set[0].opts.secure, false);
    assert.equal(invites.carriedToken({ headers: {}, cookies: { hr_invite: 'fake-invite-token' } }), 'fake-invite-token');
  });

  // Production decides __Host- whatever the request says, so no request
  // there can read the bare name. A sign-in that carried only a planted
  // copy follows nothing, and its clear still satisfies the prefix.
  await withNodeEnv('production', async () => {
    const planted = { headers: {}, cookies: { hr_invite: 'planted' } };
    assert.equal(invites.inviteCookieName(planted), '__Host-hr_invite');
    const redeem = recorder();
    assert.equal(await invites.redeemCarried(null, planted, redeem.res, 1), null);
    assert.deepEqual(redeem.cleared, [], 'nothing carried, nothing spent');
    const drop = recorder();
    assert.equal(await invites.dropCarried(null, planted, drop.res, 1), null);
    assert.deepEqual(drop.cleared, [{ name: '__Host-hr_invite', opts: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' } }]);
  });
});

test('the invite page\'s browser and source cookies are __Host- over HTTPS, and their readers ignore the bare names there', async () => {
  await withNodeEnv('development', () => {
    const { set, res } = recorder();
    const req = { headers: HTTPS, cookies: {} };
    const key = activity.ensureBrowser(req, res);
    assertHostCookie(set[0].name, set[0].opts, 'hr_iv');
    assert.equal(req.cookies['__Host-hr_iv'], set[0].value, 'the rest of the request reads it under the same name');
    assert.equal(activity.browserFrom({ headers: HTTPS, cookies: { '__Host-hr_iv': set[0].value } }), key);
    assert.equal(activity.browserFrom({ headers: HTTPS, cookies: { hr_iv: set[0].value } }), null);

    activity.setSourceCookie(req, res, { referrerHost: 'discord.com', via: 'copied' });
    assertHostCookie(set[1].name, set[1].opts, 'hr_iv_src');
    assert.deepEqual(activity.sourceFrom({ headers: HTTPS, cookies: { '__Host-hr_iv_src': 'discord.com|copied' } }),
      { referrerHost: 'discord.com', via: 'copied' });
    assert.equal(activity.sourceFrom({ headers: HTTPS, cookies: { hr_iv_src: 'discord.com|copied' } }), null);
  });
  await withNodeEnv('production', () => {
    const value = 'a'.repeat(32);
    assert.equal(activity.browserFrom({ headers: {}, cookies: { hr_iv: value } }), null);
    assert.match(activity.browserFrom({ headers: {}, cookies: { '__Host-hr_iv': value } }), /^[0-9a-f]{64}$/);
    assert.equal(activity.sourceFrom({ headers: {}, cookies: { hr_iv_src: 'none|' } }), null);
  });
});

test('what a browser receives: every write and clear satisfies the __Host- prefix', async (t) => {
  await withNodeEnv('production', async () => {
    const app = express();
    app.use(cookieParser());
    app.get('/set', (req, res) => {
      auth.createSignupCookie(res, 'fake-signup-token', new Date(Date.now() + 3600e3));
      oauth.privateCookie(res, oauth.BINDER_COOKIE, 'fake-binder', 600e3);
      phone.privateCookie(res, 'hr_phone_signup', 'fake-signup-token', new Date(Date.now() + 3600e3));
      invites.setInviteCookie(req, res, 'fake-invite-token');
      activity.ensureBrowser(req, res);
      oauth.goBack(res, '/', 'username');
    });
    app.get('/clear', (req, res) => {
      auth.clearSignupCookie(res);
      oauth.clearPrivateCookie(res, oauth.BINDER_COOKIE);
      phone.clearPrivateCookie(res, 'hr_phone_signup');
      invites.clearInviteCookie(req, res);
      res.end();
    });
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const written = (await fetch(`${base}/set`, { redirect: 'manual' })).headers.getSetCookie();
    assert.deepEqual(written.map((line) => line.split('=')[0]).sort(), [
      '__Host-hr_invite', '__Host-hr_iv', '__Host-hr_oauth_binder', '__Host-hr_oauth_result',
      '__Host-hr_phone_signup', '__Host-usernode_signup',
    ]);
    const cleared = (await fetch(`${base}/clear`)).headers.getSetCookie();
    assert.equal(cleared.length, 4);
    for (const line of [...written, ...cleared]) {
      assert.match(line, /^__Host-/, line);
      assert.match(line, /; Path=\/(;|$)/, line);
      assert.match(line, /; Secure(;|$)/, line);
      assert.doesNotMatch(line, /Domain=/i, line);
    }
    for (const line of cleared) assert.match(line, /=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT;/, line);
  });
});
