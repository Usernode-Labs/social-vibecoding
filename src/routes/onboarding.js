'use strict';

// A new account's first run (communities, stage 5): the "What communities do
// you want to join?" screen and the Getting started card on Home. Me-scoped,
// so mounted behind authMiddleware like the other /api/me routes. The rules
// live in src/services/onboarding.js; this file is the HTTP around them.
//
//   GET  /api/me/join-suggestions          what the join screen lists
//   POST /api/me/communities               answer it: { join: [slug] }
//   GET  /api/me/getting-started           the card's three steps
//   POST /api/me/getting-started/seen      { step: 'workshop' | 'discover' }
//   POST /api/me/getting-started/close     the card's close button

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const onboarding = require('../services/onboarding');
const { acceptInvite } = require('../services/collab-invites');
const { drainGuard } = require('../services/lifecycle');

function onboardingRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  // Where the platform's own project is listed at all, it is offered first;
  // where it is not (the deployment keeps it to admins), it is not offered.
  // The same rule GET /api/apps and the membership route apply.
  const showSelfHosted = (user) => !!user?.isAdmin || !!config.selfAppPublicVoting;

  router.get('/api/me/join-suggestions', async (req, res) => {
    try {
      const list = await onboarding.joinSuggestions(pool, req.user.id, {
        showSelfHosted: showSelfHosted(req.user),
      });
      res.json({ communities: list });
    } catch (err) {
      log.error('onboarding', 'join suggestions failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/communities', drainGuard, async (req, res) => {
    try {
      const result = await onboarding.answerJoin(pool, req.user, req.body || {}, {
        showSelfHosted: showSelfHosted(req.user),
        acceptInvite: (app) => acceptInvite(pool, { appId: app.id, user: req.user }),
      });
      if (!result.ok) {
        return res.status(result.status).json({
          error: result.error,
          ...(result.alreadyDone ? { alreadyDone: true } : null),
        });
      }
      res.json(result);
    } catch (err) {
      log.error('onboarding', 'join answer failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/me/getting-started', async (req, res) => {
    try {
      res.json(await onboarding.gettingStarted(pool, req.user.id, {
        showSelfHosted: showSelfHosted(req.user),
      }));
    } catch (err) {
      log.error('onboarding', 'getting started failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/getting-started/seen', drainGuard, async (req, res) => {
    try {
      const result = await onboarding.markSeen(pool, req.user.id, req.body?.step);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (err) {
      log.error('onboarding', 'getting started seen failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/getting-started/close', drainGuard, async (req, res) => {
    try {
      res.json(await onboarding.closeCard(pool, req.user.id));
    } catch (err) {
      log.error('onboarding', 'getting started close failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { onboardingRoutes };
