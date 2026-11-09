'use strict';

// The "Stop these reminders" link in the waitlist reminders
// (services/waitlist-reminders.js), for people let in who have not signed in.
//
//   GET  /mail/reminders/stop?w=<row>&t=<token>   a page with one button, so a
//        link scanner that follows every URL in a mail stops nothing.
//   POST /mail/reminders/stop?w=<row>&t=<token>   stops them. Also the RFC 8058
//        one-click POST a mail client sends from its own Unsubscribe button
//        (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`), which is why
//        it needs no session and reads only the query.
//
// Mounted before authMiddleware, like the activity mail's
// (routes/activity-mail.js): most of these people have no account, and the
// token (an HMAC of the waitlist row and its address) is the whole of the
// access check. A wrong or missing token changes nothing and says so.

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const reminders = require('../services/waitlist-reminders');
const log = require('../services/logger');

const PAGE_STYLE = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'max-width:420px;margin:64px auto;padding:0 16px;color:#1c1c1e;line-height:1.5';
const BUTTON_STYLE = 'display:inline-block;padding:10px 18px;border-radius:8px;border:0;'
  + 'background:#0a6ee0;color:#fff;font-size:15px;text-decoration:none';
const SMALL_STYLE = 'font-size:13px;color:#68686c';

// Where "Sign in instead" goes: the sign-in form, as the reminders' own
// button does for an address with an account.
const SIGN_IN_PATH = '/?login=1';

function page(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title}</title><meta name="robots" content="noindex"></head>`
    + `<body style="${PAGE_STYLE}"><h1 style="font-size:22px">${title}</h1>${body}</body></html>`;
}

const SMALL_PRINT = `<p style="${SMALL_STYLE}">This stops reminders for this address only. Sign-in codes you ask for still arrive.</p>`;
const SIGN_IN_BUTTON = `<p><a href="${SIGN_IN_PATH}" style="${BUTTON_STYLE}">Sign in instead</a></p>`;

const BROKEN_GET = page('This link does not work',
  '<p>It may have been copied only in part. Open it again from the email.</p>');
const BROKEN_POST = page('This link does not work',
  '<p>Nothing was changed. Open the link again from the email.</p>');

// The page the POST answers, once the row is stamped.
const STOPPED = page('No more reminders',
  '<p>We won\'t email you about your spot again. It stays open: sign in any time with the email address we wrote to.</p>'
  + SIGN_IN_BUTTON
  + SMALL_PRINT);

function readQuery(req) {
  const signupId = Number(req.query.w);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  return { signupId: Number.isSafeInteger(signupId) && signupId > 0 ? signupId : null, token };
}

function noStore(res) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
}

function waitlistReminderRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  router.get('/mail/reminders/stop', limiter, async (req, res) => {
    const { signupId, token } = readQuery(req);
    noStore(res);
    try {
      if (!signupId || !(await reminders.stopLinkWorks(config, pool, { signupId, token }))) {
        return res.status(400).type('html').send(BROKEN_GET);
      }
      // The token is base64url, and the row id a number: nothing here needs
      // escaping in the form's action.
      const action = `/mail/reminders/stop?w=${signupId}&t=${encodeURIComponent(token)}`;
      return res.type('html').send(page('Stop these reminders?',
        `<form method="post" action="${action}"><button type="submit" style="${BUTTON_STYLE}">`
        + 'Stop these reminders</button></form>'
        + SIGN_IN_BUTTON
        + SMALL_PRINT));
    } catch (err) {
      log.error('waitlist-reminders', 'Stop page failed', { err: err.message });
      return res.status(500).type('html').send(page('Something went wrong', '<p>Try the link again in a minute.</p>'));
    }
  });

  router.post('/mail/reminders/stop', limiter, async (req, res) => {
    const { signupId, token } = readQuery(req);
    noStore(res);
    try {
      const done = signupId ? await reminders.stop(config, pool, { signupId, token }) : false;
      if (!done) return res.status(400).type('html').send(BROKEN_POST);
      return res.type('html').send(STOPPED);
    } catch (err) {
      log.error('waitlist-reminders', 'Stopping reminders failed', { err: err.message });
      return res.status(500).type('html').send(page('Something went wrong', '<p>Try the link again in a minute.</p>'));
    }
  });

  return router;
}

module.exports = { waitlistReminderRoutes, SIGN_IN_PATH };
