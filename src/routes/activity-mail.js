'use strict';

// WP-E: the unsubscribe link in every activity email (services/activity-mail.js).
//
//   GET  /mail/unsubscribe?u=<user>&t=<token>   a page with one button, so a
//        link scanner that follows every URL in a mail turns nothing off.
//   POST /mail/unsubscribe?u=<user>&t=<token>   turns them off. This is also
//        the RFC 8058 one-click POST a mail client sends from its own
//        Unsubscribe button (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`),
//        which is why it needs no session, and reads only the query.
//
// Mounted before authMiddleware: whoever holds the mail has no session to
// show, and the token (an HMAC of the account id) is the whole of the
// access check. A wrong or missing token changes nothing and says so.

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const activityMail = require('../services/activity-mail');
const log = require('../services/logger');

const PAGE_STYLE = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'max-width:420px;margin:64px auto;padding:0 16px;color:#1c1c1e;line-height:1.5';

function page(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title}</title><meta name="robots" content="noindex"></head>`
    + `<body style="${PAGE_STYLE}"><h1 style="font-size:22px">${title}</h1>${body}</body></html>`;
}

function readQuery(req) {
  const userId = Number(req.query.u);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  return { userId: Number.isInteger(userId) && userId > 0 ? userId : null, token };
}

function activityMailRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  router.get('/mail/unsubscribe', limiter, (req, res) => {
    const { userId, token } = readQuery(req);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (!userId || !activityMail.tokenMatches(userId, token)) {
      return res.status(400).type('html').send(page('This link does not work',
        '<p>It may have been copied only in part. Open it again from the email.</p>'));
    }
    const action = `/mail/unsubscribe?u=${userId}&t=${encodeURIComponent(token)}`;
    return res.type('html').send(page('Stop these emails?',
      '<p>Homeroom emails you when something you asked for is ready, or somebody joins through your invite, '
      + 'and there is no phone to send it to. Sign-in codes are not affected.</p>'
      + `<form method="post" action="${action}"><button type="submit" `
      + 'style="padding:10px 18px;border-radius:8px;border:0;background:#0a6ee0;color:#fff;font-size:15px">'
      + 'Stop these emails</button></form>'));
  });

  router.post('/mail/unsubscribe', limiter, async (req, res) => {
    const { userId, token } = readQuery(req);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    try {
      const done = userId ? await activityMail.turnOff(pool, { userId, token }) : false;
      if (!done) {
        return res.status(400).type('html').send(page('This link does not work',
          '<p>Nothing was changed. Open the link again from the email.</p>'));
      }
      return res.type('html').send(page('Done',
        '<p>Homeroom will not email you about builds or invites any more. Your phone still gets them '
        + 'if you set it up.</p>'));
    } catch (err) {
      log.error('activity-mail', 'Unsubscribe failed', { err: err.message });
      return res.status(500).type('html').send(page('Something went wrong', '<p>Try the link again in a minute.</p>'));
    }
  });

  return router;
}

module.exports = { activityMailRoutes };
