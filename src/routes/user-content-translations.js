'use strict';

// #6081: translate a person's words into the reader's language, when the
// reader asks for it. The table and the model call are in
// services/user-content-translations.js; this is the one endpoint:
//
//   POST /api/translations  { texts: string[], language?: string }
//     -> { language, results: [{ state: 'translated'|'same'|'failed', text?, from? }] }
//
// At most two texts, each 1 to 8000 characters: a request's title and its
// words. Errors are a code the client can word itself, never English the page
// shows. Only a signed-in person may ask; each person's new translations are
// capped per day by the service, and the platform's system budget bounds it
// too. A cached translation still answers once either bound is reached.

const { Router } = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const translations = require('../services/user-content-translations');

const MAX_PER_MINUTE = 30;

function userContentTranslationRoutes(config, deps = {}) {
  const router = Router();
  const pool = deps.pool || getPool(config);
  const service = deps.service || translations;
  const ask = deps.translate || service.translate;
  const targetLanguage = deps.targetLanguage || service.targetLanguage;

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: MAX_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
    handler: (req, res) => {
      log.warn('user-content-translations', 'Rate-limited', { userId: req.user?.id });
      res.status(429).json({ error: 'rate_limited' });
    },
  });

  const signedIn = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'sign_in_required' });
    return next();
  };

  router.post('/api/translations', signedIn, limiter, async (req, res) => {
    const texts = req.body?.texts;
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > service.MAX_TEXTS) {
      return res.status(400).json({ error: 'invalid_texts' });
    }
    if (texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > service.MAX_TEXT)) {
      return res.status(400).json({ error: 'invalid_texts' });
    }

    const language = targetLanguage(req.body?.language, req.user, req.get('accept-language'),
      deps.source !== undefined ? { source: deps.source } : undefined);

    let outcome;
    try {
      outcome = await ask(pool, { texts, language, userId: req.user.id }, {
        ...deps.deps,
        ...(deps.source !== undefined ? { source: deps.source } : {}),
      });
    } catch (err) {
      log.warn('user-content-translations', 'Could not translate', { userId: req.user.id, message: err.message });
      return res.status(503).json({ error: 'translation_unavailable' });
    }

    const results = Array.isArray(outcome?.results) ? outcome.results : [];
    const blocked = outcome?.blocked;
    if (blocked && results.length && results.every((result) => result.state === 'failed')) {
      const status = blocked === 'translation_unavailable' ? 503 : 429;
      return res.status(status).json({ error: blocked });
    }
    return res.json({ language, results });
  });

  return router;
}

module.exports = { MAX_PER_MINUTE, userContentTranslationRoutes };
