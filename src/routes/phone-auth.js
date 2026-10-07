'use strict';

/**
 * Firebase Phone Auth sign-in and sign-up (services/firebase-phone-auth.js),
 * beside the email code (routes/auth.js) and Apple/Google
 * (routes/sign-in-providers.js):
 *
 *   GET  /api/auth/phone/recaptcha the reCAPTCHA site key a web request
 *                                  answers first (services/firebase-phone-auth.js)
 *   POST /api/auth/phone/request   text a code to a phone number
 *   POST /api/auth/phone/verify    the code, or an ID token a client SDK
 *                                  earned with its own Firebase exchange
 *   POST /api/auth/phone/finish    the username step, for a brand-new account
 *                                  whose verify carried no name
 *
 * and, for an account that is signed in already and has no phone (made by
 * email, say, and waiting), mounted under /api/auth/ so the platform-access
 * gate lets a waiting account reach them, but outside the pre-login
 * /api/auth/phone/ prefix so the session is read:
 *
 *   POST /api/auth/phone-link/request  text a code, as above
 *   POST /api/auth/phone-link/verify   link the number to this account and
 *                                      join the links it is queued on as a
 *                                      private member (community-invites.js)
 *
 * The invite sheet's phone steps call these (sign-in-sheet.tsx `phone`).
 * The answers are shaped exactly like the email code's and the native OAuth
 * endpoints' JSON, so the sheet routes them identically (`next`, `created`,
 * the user block with roleFields).
 *
 * The offer gate is fail-closed: any of the four Firebase values missing
 * (config.js) leaves every endpoint here answering 404 not_offered, and
 * the waitlist options route advertises the flow as absent — unless
 * PHONE_TEST_CODE turns test numbers on, on a stack that is not production
 * (services/firebase-phone-auth.js, TEST NUMBERS).
 *
 * Like the OAuth finish route, verify and finish mint sessions, so they
 * sit in routes/auth.js's SESSION_MINT_PATHS and are refused 409
 * logout_required over a live session before any credential is consumed.
 */

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const phoneAuth = require('../services/firebase-phone-auth');
const providers = require('../services/sign-in-providers');
const communityInvites = require('../services/community-invites');
const challengeScorer = require('../services/topochain/challenge-scorer');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const {
  otpVerifyLimiter,
  phoneOtpRequestLimiter,
  phoneOtpRequestPhoneLimiter,
  phoneVerifyLimiter,
} = require('../middleware/rate-limits');
const { createSession, createSessionCookie, noteSignIn, roleFields } = require('./auth');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

const SECURE_COOKIE = process.env.NODE_ENV === 'production';

// The verify leg's sessionInfo → the SAME browser's verify call, the way
// the email code's signup cookie works (routes/auth.js SIGNUP_COOKIE) and
// the way the OAuth round trip's binder does. Scoped to the phone paths.
const PHONE_COOKIE_PATH = '/api/auth/phone';

function privateCookie(res, name, value, expiresAt) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: PHONE_COOKIE_PATH,
    expires: expiresAt,
  });
}

function clearPrivateCookie(res, name) {
  res.clearCookie(name, { path: PHONE_COOKIE_PATH });
}

function fail(res, error, what) {
  if (error instanceof phoneAuth.PhoneAuthError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  log.error('phone-auth', `${what} failed`, { message: error.message });
  return res.status(500).json({ error: 'Internal server error' });
}

function phoneAuthRoutes(config) {
  const pool = getPool(config);
  const router = express.Router();

  function requireOffered(req, res, next) {
    if (!phoneAuth.offered(config)) {
      return res.status(404).json({ error: 'That sign-in is not set up.', code: 'not_offered' });
    }
    return next();
  }

  // The code-request buckets bound texts, and a test number sends none
  // (services/firebase-phone-auth.js, TEST NUMBERS), so it skips them: a
  // first-run loop on a local stack asks for a code every round.
  function unlessTestNumber(limiter) {
    return (req, res, next) => (phoneAuth.usesTestNumber(config, req.body?.phoneNumber)
      ? next()
      : limiter(req, res, next));
  }

  // The Firebase project's reCAPTCHA site key, for a web client to earn the
  // token the request below carries. Public by nature (it is in every page
  // Firebase's own web SDK serves), so no limiter beyond the service's cache.
  router.get('/api/auth/phone/recaptcha', requireOffered, async (req, res) => {
    try {
      const siteKey = await phoneAuth.recaptchaSiteKey(config);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ siteKey });
    } catch (error) {
      return fail(res, error, 'reCAPTCHA site key');
    }
  });

  // Requesting a code SENDS A TEXT, so this carries the same two buckets
  // the email code's request does: per address (here per phone number) so
  // one person cannot work through a list of victims, and per source so
  // one IP cannot flood many numbers.
  router.post(
    '/api/auth/phone/request',
    requireOffered,
    unlessTestNumber(phoneOtpRequestLimiter),
    unlessTestNumber(phoneOtpRequestPhoneLimiter),
    async (req, res) => {
      try {
        const sent = await phoneAuth.requestCode(
          config,
          req.body?.phoneNumber,
          req.body?.recaptchaToken
        );
        return res.json({ ok: true, sessionInfo: sent.sessionInfo });
      } catch (error) {
        return fail(res, error, 'Phone code request');
      }
    }
  );

  router.post('/api/auth/phone/verify', requireOffered, phoneVerifyLimiter, async (req, res) => {
    try {
      // Either leg lands on the same claims: the server-side exchange
      // (sessionInfo + code from this browser's own /request), or an ID
      // token a client's own Firebase SDK earned. Same verifier, same
      // spent-once guard.
      const claims = req.body?.idToken
        ? await phoneAuth.verifyIdToken(pool, config, req.body.idToken)
        : await (async () => {
            const exchanged = await phoneAuth.exchangeCode(
              config,
              req.body?.sessionInfo,
              req.body?.code
            );
            return phoneAuth.verifyIdToken(pool, config, exchanged.idToken);
          })();
      const result = await phoneAuth.signIn(pool, claims, { createSession });
      if (result.refuse) {
        return res.status(422).json({
          error: 'Admin accounts sign in with their password.',
          code: result.refuse,
        });
      }

      // An invite link this visitor opened first is followed as the account
      // the phone just CREATED, and an existing account follows it only when
      // this sign-in IS the Join its page asked for — the email code's rule,
      // word for word (routes/auth.js, where the long comment lives).
      const consented = result.created || req.body?.followInvite === true;
      const invite = consented
        ? await communityInvites.redeemCarried(pool, req, res, result.userId, { requirePhone: true })
        : (communityInvites.clearInviteCookie(res), null);
      if (invite && invite.status === 'joined') await challengeScorer.scoreOnJoin(pool, config);

      if (result.created) {
        // #2568, for the phone-made account the same way: best effort by
        // construction (ensureIncludedKey never throws).
        await managedOpenRouter.ensureIncludedKey({
          pool, userId: result.userId, config, reason: 'signup_phone',
        });
      }

      // A new account whose sheet sent its name (an invite's Join): finished
      // here, with a provisional handle picked from the name, and no
      // username step. Not for a public community's invite: a public place
      // shows a username the person chose (usernames.js), so that one asks.
      const name = result.next === 'username' && !invite?.public
        ? phoneAuth.cleanName(req.body?.name) : null;
      const named = name
        ? await phoneAuth.finishWithName(pool, { signupToken: result.signupToken, name, createSession })
        : null;
      if (named) {
        createSessionCookie(res, named.session.token, named.session.expiresAt);
        noteSignIn(pool, req, named.user.id);
        log.info('phone-auth', 'Phone sign-up finished with a name', { userId: named.user.id });
        return res.json({
          ok: true,
          next: 'signed-in',
          created: true,
          user: {
            id: named.user.id,
            username: named.user.username,
            ...roleFields(named.user.isAdmin, named.user.adminReadonly),
          },
          ...(invite ? { invite } : {}),
        });
      }

      if (result.next === 'signed-in') {
        createSessionCookie(res, result.session.token, result.session.expiresAt);
        noteSignIn(pool, req, result.userId);
        log.info('phone-auth', 'Phone sign-in signed an account in', {
          userId: result.userId,
          created: !!result.created,
        });
        return res.json({
          ok: true,
          next: 'signed-in',
          created: !!result.created,
          user: {
            id: result.user.id,
            username: result.user.username,
            ...roleFields(result.user.isAdmin, result.user.adminReadonly),
          },
          ...(invite ? { invite } : {}),
        });
      }

      // A brand-new account continues to the username step. The
      // continuation rides this path-scoped HttpOnly cookie, the way the
      // email code's signup cookie does.
      privateCookie(res, 'hr_phone_signup', result.signupToken, result.expiresAt);
      log.info('phone-auth', 'Phone sign-up created an account, username pending', {
        userId: result.userId,
      });
      return res.json({
        ok: true,
        next: 'username',
        created: !!result.created,
        ...(invite ? { invite } : {}),
      });
    } catch (error) {
      return fail(res, error, 'Phone verification');
    }
  });

  router.post('/api/auth/phone/finish', requireOffered, otpVerifyLimiter, async (req, res) => {
    try {
      const done = await providers.completeUsername(pool, {
        signupToken: req.cookies?.hr_phone_signup,
        username: typeof req.body?.username === 'string' ? req.body.username : '',
        createSession,
      });
      clearPrivateCookie(res, 'hr_phone_signup');
      createSessionCookie(res, done.session.token, done.session.expiresAt);
      noteSignIn(pool, req, done.user.id);
      log.info('phone-auth', 'Phone sign-up chose a username', { userId: done.user.id });
      return res.json({
        ok: true,
        user: {
          id: done.user.id,
          username: done.user.username,
          ...roleFields(done.user.isAdmin, done.user.adminReadonly),
        },
      });
    } catch (error) {
      if (error instanceof providers.SignInProviderError) {
        // Field refusals keep the continuation, so the person fixes the
        // field and submits again (the email code's and the OAuth finish
        // route's shape); anything else spends it.
        if (error.code === 'invalid_username' || error.code === 'username_taken') {
          return res.status(422).json({ error: error.message, code: error.code, field: 'username' });
        }
        clearPrivateCookie(res, 'hr_phone_signup');
        return res.status(422).json({ error: error.message, code: error.code });
      }
      log.error('phone-auth', 'Username step failed', { message: error.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── A phone for the account signed in ─────────────────────────────────
  // The same two legs, for a session that exists: the number is linked to
  // it instead of signing anybody in, and the links it is queued on are
  // followed again, now as a private member. Same buckets as the pre-login
  // legs; the same-origin check after them (middleware/same-site-browser.js).
  function signedIn(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  }

  router.post(
    '/api/auth/phone-link/request',
    requireOffered,
    unlessTestNumber(phoneOtpRequestLimiter),
    unlessTestNumber(phoneOtpRequestPhoneLimiter),
    sameOriginBrowserOnly,
    signedIn,
    async (req, res) => {
      try {
        const sent = await phoneAuth.requestCode(config, req.body?.phoneNumber, req.body?.recaptchaToken);
        return res.json({ ok: true, sessionInfo: sent.sessionInfo });
      } catch (error) {
        return fail(res, error, 'Phone link code request');
      }
    }
  );

  router.post(
    '/api/auth/phone-link/verify',
    requireOffered,
    phoneVerifyLimiter,
    sameOriginBrowserOnly,
    signedIn,
    async (req, res) => {
      try {
        const exchanged = await phoneAuth.exchangeCode(config, req.body?.sessionInfo, req.body?.code);
        const claims = await phoneAuth.verifyIdToken(pool, config, exchanged.idToken);
        const linked = await phoneAuth.linkPhone(pool, claims, req.user.id);
        const joined = await communityInvites.joinQueued(pool, req.user.id);
        if (joined.length) await challengeScorer.scoreOnJoin(pool, config);
        log.info('phone-auth', 'Phone linked to a signed-in account', {
          userId: req.user.id, already: linked.already, joined: joined.length,
        });
        return res.json({ ok: true, joined, privateMember: joined.length > 0 });
      } catch (error) {
        return fail(res, error, 'Phone link');
      }
    }
  );

  return router;
}

module.exports = { phoneAuthRoutes, PHONE_COOKIE_PATH };
