'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { clientIp } = require('../services/client-ip');
const { consumeSharedTokenBucket } = require('../services/cli-auth');
const log = require('../services/logger');
const limits = require('../services/limits');
const socialIdentity = require('../services/social-identity');
const githubLink = require('../services/github-link');
const xLink = require('../services/x-link');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PROVIDER_ADAPTERS = Object.freeze({ github: githubLink, x: xLink });

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

function browserCsrf(config, req, res) {
  if (req.headers.origin !== config.cliAuthOrigin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite != null && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

function providerAdapter(provider) {
  return PROVIDER_ADAPTERS[provider] || null;
}

function callbackUri(config, provider) {
  const path = provider === 'github'
    ? '/api/me/github/callback'
    : '/api/me/x/callback';
  return `${config.cliAuthOrigin}${path}`;
}

function settingsUrl(config, status, provider) {
  const params = new URLSearchParams({ identity: status, provider });
  return `${config.cliAuthOrigin}/#settings/connectors?${params.toString()}`;
}

async function statusPayload(pool, config, userId) {
  const [providers, entitlement] = await Promise.all([
    socialIdentity.identityStatus(pool, userId),
    limits.getUserCreditEntitlement(pool, userId),
  ]);
  for (const provider of socialIdentity.PROVIDERS) {
    providers[provider].available = providerAdapter(provider).isEnabled(config);
  }
  return { providers, entitlement };
}

function demoPayload(mode) {
  const day = 24 * 60 * 60 * 1000;
  const linkedAt = new Date(Date.now() - 6 * day).toISOString();
  const base = (provider) => ({
    provider, linked: false, handle: null, linkedAt: null,
    lastVerifiedAt: null, creditEligible: false, reconnectRequired: false,
    access: 'identity', available: true,
  });
  const providers = { github: base('github'), x: base('x') };
  let entitlement = {
    policy: 'tiered', tier: 'unverified', source: 'identity',
    limitCents: 0, verificationRequired: true, entitlementAvailable: true,
  };

  if (mode === 'identity-legacy') {
    providers.github = {
      ...providers.github,
      linked: true,
      handle: 'legacy-contributor',
      linkedAt,
      reconnectRequired: true,
    };
  } else if (mode !== 'identity-unverified') {
    providers.github = {
      ...providers.github,
      linked: true,
      handle: 'octo-contributor',
      linkedAt,
      lastVerifiedAt: linkedAt,
      creditEligible: true,
    };
    entitlement = {
      policy: 'tiered', tier: 'social', source: 'identity',
      limitCents: limits.TIER_ONE_LIMIT_CENTS,
      verificationRequired: false, entitlementAvailable: true,
    };
  }
  return { providers, entitlement, demo: true };
}

function socialIdentityRoutes(config) {
  const router = Router({ strict: true, caseSensitive: true });
  const pool = getPool(config);

  router.use([
    '/api/me/social-identities',
    '/api/me/social-identities/*',
    '/api/me/github',
    '/api/me/github/*',
    '/api/me/x',
    '/api/me/x/*',
  ], noStore);

  const userRate = async (req, res, next) => {
    try {
      const state = await consumeSharedTokenBucket(pool, {
        namespace: 'social-identity-user',
        subject: String((req.user && req.user.id) || clientIp(req)),
        ratePerMinute: 30,
        capacity: 30,
      });
      if (!state.allowed) {
        res.setHeader('Retry-After', String(state.retryAfter));
        return res.status(429).json({ error: 'rate_limited' });
      }
      return next();
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };

  router.get('/api/me/social-identities', userRate, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    const demo = typeof req.query.demo === 'string' ? req.query.demo : '';
    if (IS_STAGING) {
      if (demo === '1' || demo === 'identity-connected'
          || demo === 'identity-unverified' || demo === 'identity-legacy') {
        return res.json(demoPayload(demo));
      }
      const payload = demoPayload('identity-unverified');
      payload.providers.github.available = false;
      payload.providers.x.available = false;
      payload.entitlement = {
        policy: 'legacy', tier: 'legacy', source: 'default',
        limitCents: 2500, verificationRequired: false, entitlementAvailable: true,
      };
      delete payload.demo;
      return res.json(payload);
    }
    try {
      return res.json(await statusPayload(pool, config, req.user.id));
    } catch (err) {
      log.warn('social-identity', 'status read failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // Backward-compatible GitHub status for connector clients on the old
  // endpoint. New Settings code reads the provider-neutral endpoint above.
  router.get('/api/me/github', userRate, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (IS_STAGING && req.query.demo === '1') {
      const demo = demoPayload('identity-connected');
      const github = demo.providers.github;
      return res.json({
        linked: github.linked, login: github.handle, linkedAt: github.linkedAt,
        access: github.access, available: true, demo: true,
      });
    }
    try {
      const payload = await statusPayload(pool, config, req.user.id);
      const github = payload.providers.github;
      return res.json({
        linked: github.linked,
        login: github.handle,
        linkedAt: github.linkedAt,
        access: github.access,
        available: github.available,
        creditEligible: github.creditEligible,
        reconnectRequired: github.reconnectRequired,
      });
    } catch (err) {
      log.warn('social-identity', 'legacy GitHub status read failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  const startLink = async (req, res, explicitProvider) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (IS_STAGING) return res.status(404).json({ error: 'not_found' });
    const provider = explicitProvider || req.params.provider;
    const adapter = providerAdapter(provider);
    if (!adapter || !adapter.isEnabled(config)) {
      return res.status(404).json({ error: 'not_found' });
    }
    try {
      const pending = await socialIdentity.createOauthState(pool, {
        userId: req.user.id,
        provider,
      });
      const url = adapter.authorizeUrl(config, {
        redirectUri: callbackUri(config, provider),
        state: pending.state,
        challenge: pending.challenge,
      });
      if (!url) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(302, url);
    } catch (err) {
      log.warn('social-identity', 'link start failed', {
        provider, userId: req.user.id, message: err.message,
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };

  router.get('/api/me/social-identities/:provider/connect', userRate,
    (req, res) => startLink(req, res));
  router.get('/api/me/github/connect', userRate,
    (req, res) => startLink(req, res, 'github'));

  const finishLink = async (req, res, provider) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (IS_STAGING) return res.status(404).json({ error: 'not_found' });
    const adapter = providerAdapter(provider);
    if (!adapter || !adapter.isEnabled(config)) {
      return res.status(404).json({ error: 'not_found' });
    }

    let pending;
    try {
      pending = await socialIdentity.consumeOauthState(pool, {
        userId: req.user.id,
        provider,
        state: req.query.state,
      });
    } catch (err) {
      log.warn('social-identity', 'state consume failed', {
        provider, userId: req.user.id, message: err.message,
      });
      return res.redirect(302, settingsUrl(config, 'error', provider));
    }
    const code = typeof req.query.code === 'string' && req.query.code.length <= 2048
      ? req.query.code
      : '';
    if (!pending || !code) {
      return res.redirect(302, settingsUrl(config, code ? 'error' : 'denied', provider));
    }

    try {
      const identity = await adapter.exchangeCode(config, {
        code,
        redirectUri: callbackUri(config, provider),
        verifier: pending.verifier,
      });
      if (!identity) return res.redirect(302, settingsUrl(config, 'error', provider));
      await socialIdentity.saveIdentity(pool, req.user.id, identity);
      log.info('social-identity', 'account linked', { provider, userId: req.user.id });
      return res.redirect(302, settingsUrl(config, 'linked', provider));
    } catch (err) {
      const status = err instanceof socialIdentity.SocialIdentityError
        ? 'conflict'
        : 'error';
      log.warn('social-identity', 'link callback failed', {
        provider, userId: req.user.id, code: err.code || 'exchange_failed',
      });
      return res.redirect(302, settingsUrl(config, status, provider));
    }
  };

  router.get('/api/me/github/callback', userRate,
    (req, res) => finishLink(req, res, 'github'));
  router.get('/api/me/x/callback', userRate,
    (req, res) => finishLink(req, res, 'x'));

  const unlink = async (req, res, explicitProvider) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (IS_STAGING) return res.status(404).json({ error: 'not_found' });
    if (!browserCsrf(config, req, res)) return undefined;
    const provider = explicitProvider || req.params.provider;
    if (!providerAdapter(provider)) return res.status(404).json({ error: 'not_found' });
    try {
      await socialIdentity.clearIdentity(pool, req.user.id, provider);
      log.info('social-identity', 'account unlinked', { provider, userId: req.user.id });
      return res.status(204).end();
    } catch (err) {
      log.warn('social-identity', 'unlink failed', {
        provider, userId: req.user.id, message: err.message,
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };

  router.delete('/api/me/social-identities/:provider', userRate,
    (req, res) => unlink(req, res));
  router.delete('/api/me/github', userRate,
    (req, res) => unlink(req, res, 'github'));

  return router;
}

module.exports = {
  socialIdentityRoutes,
  callbackUri,
  demoPayload,
};
