'use strict';

// A new account's first run (communities, stage 5): the "What communities do
// you want to join?" screen and the welcome tour's "done". Me-scoped, so
// mounted behind authMiddleware like the other /api/me routes. The rules live
// in src/services/onboarding.js; this file is the HTTP around them.
//
//   GET  /api/me/join-suggestions          what the join screen lists
//   POST /api/me/communities               answer it: { join: [slug] }
//   POST /api/me/first-session/started     "What do you want to make?", asked
//                                          in its place, was put to them
//   POST /api/me/first-session/look-around that question's "Look around
//                                          first" (Make it answers it in
//                                          POST /api/apps)
//   POST /api/me/tour-done                 the tour's Finish and Skip
//
// The Getting started card's routes are gone with the card (#4635): GET
// /api/me/getting-started, POST …/close and POST …/workshop-visit (and,
// before them, POST …/seen, 2026-10-01). Every new account gets a tour,
// and the season's First challenges are ordinary cards in Home's Challenges
// area, each ticking from its own credit.

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

  // The first session's question, "What do you want to make?", was put to
  // this account in the join screen's place (services/first-session.js):
  // from the signed-out story's own sheet, or `{ via: 'sign_in' }` from any
  // other sign-in (communities-first-run.js), so Journey can tell the two
  // apart. Kept once, the first time. It ANSWERS nothing: the question
  // stays owed, and every later boot asks it again, until Make it or
  // "Look around first" below.
  router.post('/api/me/first-session/started', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const via = req.body && req.body.via === 'sign_in' ? 'sign_in' : 'story';
    try {
      await firstSession.recordStart(pool, req.user.id, via);
      res.json({ ok: true });
    } catch (err) {
      log.error('onboarding', 'first session start failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // "Look around first": the first session's other answer, after Make it
  // (which POST /api/apps records as it makes the project). The question is
  // not asked again; Home, with nothing on it yet, is where they go.
  router.post('/api/me/first-session/look-around', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await firstSession.answerJoinScreenByLookingAround(pool, req.user.id);
      res.json({ ok: true });
    } catch (err) {
      log.error('onboarding', 'first session look around failed', { message: err.message });
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
      // screen leads to is Home, whose Challenges area should already have
      // the First challenge for joining ("Find people to build with", #3564)
      // ticked. Never throws.
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

  return router;
}

module.exports = { onboardingRoutes };
