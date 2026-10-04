'use strict';

/**
 * Apple and Google sign-in (services/sign-in-providers.js has the whole
 * story), and the console screen that sets them up.
 *
 *   GET  /api/auth/oauth/:provider/start     the sheet's button; off to the provider
 *   GET  /api/auth/oauth/:provider/callback  back from it (Google, and Apple below)
 *   POST /api/auth/oauth/apple/callback      Apple's form POST, turned into the GET
 *   POST /api/auth/oauth/finish              the username step, for a new account
 *
 *   GET  /api/admin/sign-in-providers                 the console's view
 *   PUT  /api/admin/sign-in-providers/:provider       save one provider
 *   POST /api/admin/sign-in-providers/:provider/check ask the provider about it
 *
 * THE WAY BACK. The callback ends every trip with a redirect to where the
 * person started (Home, or the invite link they were on), and leaves its
 * outcome for the sign-in sheet in a short-lived cookie the page can read
 * (`hr_oauth_result`): nothing when it signed them in, `username` when the
 * account still needs a handle, `error-<code>` when it did not work. No
 * outcome rides in the URL, so nothing about it lands in history or logs.
 *
 * An invite link the person was on is followed exactly as the email code
 * follows it (routes/auth.js otp/verify): by an account the trip just made,
 * or by any account when the trip started from the link's own Join
 * (`follow=1`).
 */

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const providers = require('../services/sign-in-providers');
const communityInvites = require('../services/community-invites');
const challengeScorer = require('../services/topochain/challenge-scorer');
const firstSession = require('../services/first-session');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { oauthSignInLimiter, otpVerifyLimiter } = require('../middleware/rate-limits');
const { createSession, createSessionCookie, roleFields } = require('./auth');

const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const BINDER_COOKIE = 'hr_oauth_binder';
const SIGNUP_COOKIE = 'hr_oauth_signup';
const RESULT_COOKIE = 'hr_oauth_result';
const OAUTH_COOKIE_PATH = '/api/auth/oauth';
// Long enough for the page to load and read it, short enough to mean "just now".
const RESULT_MAX_AGE_MS = 2 * 60 * 1000;
const RESULT_RE = /^(username|error-[a-z_]{1,40})$/;

function privateCookie(res, name, value, maxAgeMs) {
  res.cookie(name, value, {
    httpOnly: true, secure: SECURE_COOKIE, sameSite: 'lax', path: OAUTH_COOKIE_PATH, maxAge: maxAgeMs,
  });
}

function clearPrivateCookie(res, name) {
  res.clearCookie(name, { httpOnly: true, secure: SECURE_COOKIE, sameSite: 'lax', path: OAUTH_COOKIE_PATH });
}

/** Back to where the trip started, with the outcome for the sheet. */
function goBack(res, returnTo, result) {
  if (result && RESULT_RE.test(result)) {
    res.cookie(RESULT_COOKIE, result, {
      httpOnly: false, secure: SECURE_COOKIE, sameSite: 'lax', path: '/', maxAge: RESULT_MAX_AGE_MS,
    });
  }
  res.set('Cache-Control', 'no-store');
  return res.redirect(303, providers.safeReturnTo(returnTo));
}

function errorResult(err) {
  return err instanceof providers.SignInProviderError ? `error-${err.code}` : 'error-failed';
}

function signInProviderRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);

  // The ordinary sign-in routes refuse to mint a session over a live one
  // (routes/auth.js SESSION_MINT_PATHS); these GETs make the same check.
  async function liveSession(req) {
    const token = req.cookies?.session;
    if (!token) return false;
    const { rows } = await pool.query(
      'SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1',
      [token]
    );
    return rows.length > 0;
  }

  // The trip runs on the canonical origin, the one registered with the
  // providers, so the binder cookie, the callback and the session it mints
  // all belong to one host. A start on another host (an alias of the same
  // server) restarts there.
  function onCanonicalHost(req) {
    try {
      return new URL(config.cliAuthOrigin).hostname === req.hostname;
    } catch {
      return false;
    }
  }

  router.get('/api/auth/oauth/:provider/start', oauthSignInLimiter, async (req, res) => {
    const provider = req.params.provider;
    const returnTo = providers.safeReturnTo(typeof req.query.return === 'string' ? req.query.return : '/');
    res.set('Referrer-Policy', 'no-referrer');
    if (!providers.isProvider(provider)) return goBack(res, returnTo, 'error-not_offered');
    if (config.cliAuthOrigin && !onCanonicalHost(req)) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, `${config.cliAuthOrigin}${req.originalUrl}`);
    }
    try {
      if (await liveSession(req)) return goBack(res, returnTo, 'error-logout_required');
      const { url, binder } = await providers.beginSignIn(pool, config, provider, {
        from: typeof req.query.from === 'string' ? req.query.from : null,
        followInvite: req.query.follow === '1',
        returnTo,
      });
      privateCookie(res, BINDER_COOKIE, binder, providers.STATE_TTL_MS);
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, url);
    } catch (err) {
      if (!(err instanceof providers.SignInProviderError)) {
        log.error('sign-in-providers', 'Start failed', { provider, err: err.message });
      }
      return goBack(res, returnTo, errorResult(err));
    }
  });

  async function callback(req, res, params) {
    const provider = req.params.provider;
    const binder = req.cookies?.[BINDER_COOKIE];
    clearPrivateCookie(res, BINDER_COOKIE);
    res.set('Referrer-Policy', 'no-referrer');
    if (!providers.isProvider(provider)) return goBack(res, '/', 'error-not_offered');
    let state;
    try {
      state = await providers.consumeState(pool, provider, params.state, binder);
    } catch (err) {
      log.error('sign-in-providers', 'State read failed', { provider, err: err.message });
      return goBack(res, '/', 'error-failed');
    }
    if (!state) return goBack(res, '/', 'error-expired');
    if (state.mismatch) return goBack(res, state.return_to, 'error-expired');
    const returnTo = state.return_to;
    if (typeof params.error === 'string' && params.error) {
      // The person said no at the provider (Apple: user_cancelled_authorize).
      const cancelled = params.error === 'access_denied' || params.error === 'user_cancelled_authorize';
      return goBack(res, returnTo, cancelled ? 'error-cancelled' : 'error-provider_refused');
    }
    try {
      if (await liveSession(req)) return goBack(res, returnTo, 'error-logout_required');
      const claims = await providers.exchangeCode(pool, config, provider, { code: params.code, state });
      const result = await providers.signIn(pool, provider, claims, { createSession });
      // Nobody signed in, so an invite link being followed stays carried for
      // the email code or password the sheet points them to next.
      if (result.refuse) return goBack(res, returnTo, `error-${result.refuse}`);
      if (result.created) {
        // What an email code does for an account it makes (email-signup.js
        // verifyCode, routes/auth.js): a released waitlist address is let
        // in, project invites to it are claimed, and the included
        // OpenRouter key is made. Each is best effort and never throws.
        const waitlist = require('../services/waitlist');
        await waitlist.linkUserByEmail(pool, { userId: result.userId, email: result.email });
        await require('../services/email-invites').claimEmailInvites(pool, { userId: result.userId, email: result.email });
        await managedOpenRouter.ensureIncludedKey({
          pool, userId: result.userId, config, reason: `signup_${provider}`,
        });
        // Made from the story's sheet: asked what to make, not which
        // communities to join (services/first-session.js).
        if (state.started_from === 'story') await firstSession.answerJoinScreen(pool, result.userId, 'story');
      }
      const consented = result.created || state.follow_invite === true;
      const invite = consented
        ? await communityInvites.redeemCarried(pool, req, res, result.userId)
        : (communityInvites.clearInviteCookie(res), null);
      if (invite && invite.status === 'joined') await challengeScorer.scoreOnJoin(pool, config);
      if (result.next === 'signed-in') {
        createSessionCookie(res, result.session.token, result.session.expiresAt);
        log.info('sign-in-providers', 'Signed in', { provider, userId: result.userId, created: result.created });
        return goBack(res, returnTo, null);
      }
      privateCookie(res, SIGNUP_COOKIE, result.signupToken, providers.SIGNUP_TTL_MS);
      log.info('sign-in-providers', 'Username step pending', { provider, userId: result.userId, created: result.created });
      return goBack(res, returnTo, 'username');
    } catch (err) {
      if (!(err instanceof providers.SignInProviderError)) {
        log.error('sign-in-providers', 'Callback failed', { provider, err: err.message });
      }
      return goBack(res, returnTo, errorResult(err));
    }
  }

  router.get('/api/auth/oauth/:provider/callback', oauthSignInLimiter, (req, res) => callback(req, res, {
    code: typeof req.query.code === 'string' ? req.query.code : null,
    state: typeof req.query.state === 'string' ? req.query.state : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  }));

  // Apple answers with a cross-site form POST (response_mode=form_post), and
  // a cross-site POST carries no SameSite=Lax cookie, so the binder is not on
  // this request. The same fields go on to the GET above, a top-level
  // navigation, which carries it.
  router.post(
    '/api/auth/oauth/apple/callback',
    oauthSignInLimiter,
    express.urlencoded({ extended: false, limit: '16kb' }),
    (req, res) => {
      const params = new URLSearchParams();
      for (const key of ['code', 'state', 'error']) {
        const value = req.body?.[key];
        if (typeof value === 'string' && value) params.set(key, value.slice(0, 2048));
      }
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      return res.redirect(303, `${providers.callbackPath('apple')}?${params.toString()}`);
    }
  );

  router.post('/api/auth/oauth/finish', otpVerifyLimiter, async (req, res) => {
    try {
      const done = await providers.completeUsername(pool, {
        signupToken: req.cookies?.[SIGNUP_COOKIE],
        username: typeof req.body?.username === 'string' ? req.body.username : '',
        createSession,
      });
      clearPrivateCookie(res, SIGNUP_COOKIE);
      createSessionCookie(res, done.session.token, done.session.expiresAt);
      return res.json({
        user: {
          id: done.user.id,
          username: done.user.username,
          ...roleFields(done.user.isAdmin, done.user.adminReadonly),
        },
      });
    } catch (err) {
      if (err instanceof providers.SignInProviderError) {
        // A username refusal leaves the continuation unspent: fix and resend.
        if (err.code === 'invalid_username' || err.code === 'username_taken') {
          return res.status(422).json({ error: err.message, code: err.code, field: 'username' });
        }
        clearPrivateCookie(res, SIGNUP_COOKIE);
        return res.status(422).json({ error: err.message, code: err.code });
      }
      log.error('sign-in-providers', 'Username step failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Admin → Sign-in providers ─────────────────────────────────────────
  // Read open to view-only admins; saving and the check are full-admin.

  function adminFail(res, err, what) {
    if (err instanceof providers.SignInProviderError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    log.error('sign-in-providers', `${what} failed`, { err: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  router.get('/api/admin/sign-in-providers', adminMiddleware, async (_req, res) => {
    try {
      return res.json(await providers.adminView(pool, config));
    } catch (err) {
      return adminFail(res, err, 'Admin read');
    }
  });

  router.put('/api/admin/sign-in-providers/:provider', adminMiddleware, requireAdminWrite, async (req, res) => {
    try {
      const view = await providers.saveProvider(pool, config, req.params.provider, req.body, req.user?.id ?? null);
      log.info('sign-in-providers', 'Provider saved', {
        provider: req.params.provider, adminId: req.user?.id,
        enabled: req.body?.enabled, cleared: req.body?.clear === true,
        secretChanged: typeof req.body?.secret === 'string' && !!req.body.secret.trim(),
      });
      return res.json(view);
    } catch (err) {
      return adminFail(res, err, 'Admin save');
    }
  });

  router.post('/api/admin/sign-in-providers/:provider/check', adminMiddleware, requireAdminWrite, async (req, res) => {
    try {
      return res.json(await providers.checkSetup(pool, config, req.params.provider));
    } catch (err) {
      return adminFail(res, err, 'Admin check');
    }
  });

  return router;
}

module.exports = { signInProviderRoutes, RESULT_COOKIE, BINDER_COOKIE, SIGNUP_COOKIE };
