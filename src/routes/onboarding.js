'use strict';

// A new account's first run (communities, stage 5): the "What communities do
// you want to join?" screen, the welcome tour's "done" and the Getting
// started card on Home. Me-scoped, so mounted behind authMiddleware like the
// other /api/me routes. The rules live in src/services/onboarding.js; this
// file is the HTTP around them.
//
//   GET  /api/me/join-suggestions          what the join screen lists
//   POST /api/me/communities               answer it: { join: [slug] }
//   POST /api/me/tour-done                 the tour's Finish and Skip
//   GET  /api/me/getting-started           the card: the tour, then the
//                                          season's First challenges
//   POST /api/me/getting-started/close     the card's close button, once
//                                          its list is done
//   POST /api/me/getting-started/workshop-visit
//                                          the Vote step's "Look": its
//                                          Workshop opened while nothing is
//                                          up for a vote, which ticks it
//
// POST /api/me/getting-started/seen is gone (2026-10-01). It recorded the two
// visits the old card's steps ticked from (the Workshop, Discover), whether
// or not anything was waiting; the card's steps are the First challenges
// now, and each ticks from its own credit. The one visit that is a credit,
// the Workshop when nothing is up for a vote, is workshop-visit above, and
// the server decides whether it counts.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const onboarding = require('../services/onboarding');
const firstSession = require('../services/first-session');
const { acceptInvite } = require('../services/collab-invites');
const challengeScorer = require('../services/topochain/challenge-scorer');
const { drainGuard } = require('../services/lifecycle');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

function onboardingRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  // Where the platform's own project is listed at all, it is offered first;
  // where it is not (the deployment keeps it to admins), it is not offered.
  // The same rule GET /api/apps and the membership route apply.
  const showSelfHosted = (user) => !!user?.isAdmin || !!config.selfAppPublicVoting;
  // What the card reads for a viewer: the same two flags the Needs you feed
  // resolves (routes/workshop-overview.js), so the Vote step and that feed
  // agree about which projects, and so which votes, there are.
  const cardOpts = (user) => ({ showSelfHosted: showSelfHosted(user), isAdmin: !!user?.isAdmin });

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

  // An account just made from the signed-out story (the sheet the story's
  // "Get started" opens): the first session asks what to make, not which
  // communities to join (services/first-session.js).
  router.post('/api/me/first-session/started', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await firstSession.answerJoinScreen(pool, req.user.id, 'story');
      res.json({ ok: true });
    } catch (err) {
      log.error('onboarding', 'first session start failed', { message: err.message });
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
      // Once for the whole answer, not per community: the first thing this
      // screen leads to is Home, whose Getting started card should already
      // have its join step ("Find people to build with", #3564) ticked.
      // Never throws.
      if (result.joined.length) await challengeScorer.scoreOnJoin(pool, config);
      res.json(result);
    } catch (err) {
      log.error('onboarding', 'join answer failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read back as `tourDone` on /api/auth/me.
  router.post('/api/me/tour-done', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      res.json(await onboarding.markTourDone(pool, req.user.id, req.body || {}));
    } catch (err) {
      log.error('onboarding', 'tour done failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/me/getting-started', async (req, res) => {
    try {
      res.json(await onboarding.gettingStarted(pool, req.user.id, cardOpts(req.user)));
    } catch (err) {
      log.error('onboarding', 'getting started failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/getting-started/close', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const result = await onboarding.closeCard(pool, req.user.id, cardOpts(req.user));
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (err) {
      log.error('onboarding', 'getting started close failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The Vote step's Workshop visit (onboarding.markWorkshopVisit): recorded
  // only when nothing is waiting for this person's vote, then counted on the
  // spot as a vote would be. scoreOnVote never throws, and is a no-op with
  // scoring off or no VOTE_CAST rule.
  router.post('/api/me/getting-started/workshop-visit', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const result = await onboarding.markWorkshopVisit(pool, req.user.id, cardOpts(req.user));
      if (!result.ok) {
        return res.status(result.status).json({
          error: result.error,
          ...(result.waiting ? { waiting: result.waiting } : null),
        });
      }
      await challengeScorer.scoreOnVote(pool, config);
      res.json(result);
    } catch (err) {
      log.error('onboarding', 'getting started workshop visit failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { onboardingRoutes };
