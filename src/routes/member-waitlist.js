'use strict';

/**
 * A private member's waitlist card (services/member-waitlist.js):
 *
 *   GET  /api/me/waitlist          where they stand
 *   POST /api/me/waitlist/join     { email }: joins with the account's own
 *                                  address, or mails a code to another
 *   POST /api/me/waitlist/join     { phone: true }: joins with the account's
 *                                  verified phone, no address asked for
 *   POST /api/me/waitlist/verify   { email, code }: confirms it and joins
 *
 * Signed in only. Anybody may ask where they stand; joining from here is for
 * an account that is not let in yet, which today is a private member (an
 * account with access has nothing to wait for).
 */

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const memberWaitlist = require('../services/member-waitlist');
const { sendWaitlistCodeMail } = require('../services/topochain/mailer');
const { drainGuard } = require('../services/lifecycle');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { otpRequestLimiter, otpRequestEmailLimiter, otpVerifyLimiter } = require('../middleware/rate-limits');

function fail(res, err, what) {
  if (err instanceof memberWaitlist.MemberWaitlistError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  log.error('member-waitlist', `${what} failed`, { message: err.message });
  return res.status(500).json({ error: 'Internal server error' });
}

function memberWaitlistRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  function waiting(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.hasPlatformAccess || req.user.isAdmin) {
      return res.status(409).json({ error: 'You are in already.', code: 'already_in' });
    }
    return next();
  }

  router.get('/api/me/waitlist', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      return res.json(await memberWaitlist.stateFor(pool, req.user.id));
    } catch (err) {
      return fail(res, err, 'Reading the waitlist');
    }
  });

  router.post('/api/me/waitlist/join', drainGuard, otpRequestLimiter, otpRequestEmailLimiter,
    sameOriginBrowserOnly, waiting, async (req, res) => {
      try {
        // The phone branch (#4223): { phone: true } and no email joins with
        // the account's verified phone in one tap. No limiter of its own —
        // the one-row-per-account index bounds it — and GET and /verify are
        // untouched.
        if (req.body?.phone === true && !req.body?.email) {
          const result = await memberWaitlist.joinWithPhone(pool, {
            userId: req.user.id,
            ip: req.ip || null,
          });
          return res.json({ ok: true, ...result });
        }
        const result = await memberWaitlist.join(pool, {
          userId: req.user.id,
          rawEmail: req.body?.email,
          ip: req.ip || null,
          // Fire-and-forget like every waitlist mail: a mail that fails does
          // not fail the join, and "New code" sends another.
          send: (email, code) => {
            Promise.resolve(sendWaitlistCodeMail(config, email, { code, moreToken: null }))
              .catch((err) => log.warn('member-waitlist', 'Code mail failed', { message: err.message }));
          },
        });
        return res.json({ ok: true, ...result });
      } catch (err) {
        return fail(res, err, 'Joining the waitlist');
      }
    });

  router.post('/api/me/waitlist/verify', drainGuard, otpVerifyLimiter,
    sameOriginBrowserOnly, waiting, async (req, res) => {
      try {
        const result = await memberWaitlist.verify(pool, {
          userId: req.user.id,
          rawEmail: req.body?.email,
          code: req.body?.code,
        });
        return res.json({ ok: true, ...result });
      } catch (err) {
        return fail(res, err, 'Confirming the waitlist email');
      }
    });

  return router;
}

module.exports = memberWaitlistRoutes;
