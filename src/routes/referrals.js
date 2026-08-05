'use strict';

const express = require('express');
const { Router } = express;
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const { referralPublicLimiter, referralWriteLimiter } = require('../middleware/rate-limits');
const referrals = require('../services/referrals');
const log = require('../services/logger');

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function pageHeaders(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

function unavailable(res) {
  pageHeaders(res);
  return res.status(404).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Referral unavailable</title><body><main><h1>Referral unavailable</h1>
    <p>This referral link is invalid, expired, revoked, or no longer points to a public app.</p>
    <a href="/">Go to Usernode</a></main></body></html>`);
}

function consentPage(app, token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Open ${esc(app.name)}</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#f4f4f5}.card{width:min(30rem,calc(100% - 2rem));box-sizing:border-box;padding:2rem;border:1px solid #3f3f46;border-radius:1rem;background:#18181b}h1{font-size:1.35rem;margin:0 0 .75rem}p{line-height:1.5;color:#d4d4d8}.actions{display:grid;gap:.75rem;margin-top:1.5rem}button,a{box-sizing:border-box;width:100%;border-radius:.65rem;padding:.8rem 1rem;text-align:center;font:inherit;font-weight:650;cursor:pointer}.yes{border:0;background:#7c3aed;color:white}.no{display:block;border:1px solid #52525b;color:#f4f4f5;text-decoration:none;background:transparent}small{display:block;margin-top:1.25rem;color:#a1a1aa;line-height:1.45}</style></head>
  <body><main class="card"><h1>Open ${esc(app.name)}?</h1>
  <p>The person who shared this link can receive one aggregate signup attribution if you create a new Usernode account. Their identity is not shown, and this grants no access, reward, credits, tokens, or notifications.</p>
  <p>Choosing attribution stores a secure referral cookie for up to 30 days. First touch wins, and it is removed after signup.</p>
  <div class="actions"><form method="post" action="/r/accept"><input type="hidden" name="consent" value="${esc(token)}"><button class="yes" type="submit">Continue with attribution</button></form>
  <a class="no" href="${esc(app.url)}" rel="noreferrer">Continue without attribution</a></div>
  <small>You can continue either way. Referral attribution never changes app or platform permissions.</small></main></body></html>`;
}

function referralRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // POST comes first so the literal `accept` is never interpreted as a code.
  router.post('/r/accept', referralPublicLimiter,
    express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 2 }),
    async (req, res) => {
      if (!referrals.sameOriginRequest(req)) return unavailable(res);
      const consent = referrals.verifyConsent(config, req.body?.consent);
      if (!consent) return unavailable(res);
      try {
        const [code, app] = await Promise.all([
          referrals.validCode(pool, consent.code),
          referrals.publicAppDestination(pool, consent.app),
        ]);
        if (!code || !app) return unavailable(res);
        referrals.setPendingCookie(res, consent.code);
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Cache-Control', 'no-store');
        return res.redirect(303, app.url);
      } catch (err) {
        log.error('referrals', 'consent failed', { message: err.message });
        return unavailable(res);
      }
    });

  router.get('/r/:code', referralPublicLimiter, async (req, res) => {
    const appSlug = typeof req.query.app === 'string' ? req.query.app : '';
    try {
      const [code, app] = await Promise.all([
        referrals.validCode(pool, req.params.code),
        referrals.publicAppDestination(pool, appSlug),
      ]);
      if (!code || !app) return unavailable(res);
      const token = referrals.signConsent(config, req.params.code, app.slug);
      pageHeaders(res);
      return res.status(200).type('html').send(consentPage(app, token));
    } catch (err) {
      log.error('referrals', 'landing failed', { message: err.message });
      return unavailable(res);
    }
  });

  router.get('/api/me/referrals', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await referrals.ownerSummary(pool, req.user.id));
    } catch (err) {
      log.error('referrals', 'owner summary failed', { userId: req.user.id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/referrals/link', referralWriteLimiter, async (req, res) => {
    const appSlug = typeof req.body?.appSlug === 'string' ? req.body.appSlug : '';
    try {
      const app = await referrals.publicAppDestination(pool, appSlug);
      if (!app) return res.status(404).json({ error: 'Public app not found' });
      const code = await referrals.getOrCreateCode(pool, req.user.id, {
        rotate: req.body?.rotate === true,
      });
      const origin = referrals.platformOrigin(req);
      const link = `${origin}/r/${code.code}?app=${encodeURIComponent(app.slug)}`;
      const summary = await referrals.ownerSummary(pool, req.user.id);
      res.set('Cache-Control', 'no-store');
      res.json({ link, expiresAt: code.expires_at, attributedSignups: summary.attributedSignups });
    } catch (err) {
      log.error('referrals', 'link creation failed', { userId: req.user.id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/referrals/code', referralWriteLimiter, async (req, res) => {
    try {
      await referrals.revokeCode(pool, req.user.id);
      res.json({ ok: true });
    } catch (err) {
      log.error('referrals', 'revocation failed', { userId: req.user.id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/referrals', adminMiddleware, async (_req, res) => {
    try {
      const referralsByUser = await referrals.adminAggregates(pool);
      const total = referralsByUser.reduce((sum, row) => sum + row.attributedSignups, 0);
      res.set('Cache-Control', 'no-store');
      res.json({ totalAttributedSignups: total, referrals: referralsByUser });
    } catch (err) {
      log.error('referrals', 'admin aggregate failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { referralRoutes, consentPage };
