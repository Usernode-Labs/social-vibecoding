'use strict';

// Specs on a request: post one, list them. The model and its reasons are in
// services/request-specs.js; these two routes are the doors.
//
//   POST /api/apps/:slug/issues/:number/spec   { spec }   a person's spec
//   GET  /api/apps/:slug/issues/:number/specs           the specs to read
//
// Posting is taking part (communities.requireAppMembership), at the same
// collaborator bar as filing the request, and only on a request that is open
// now. Reading needs only what reading the request needs. A version's text is
// GET /api/sessions/:id/specs/:version, the spec card's own read.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const appAccess = require('../services/app-access');
const communities = require('../services/communities');
const requestSpecs = require('../services/request-specs');
const { requestSpecLimiter, conversationActionLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const publicPlan = require('../services/homeroom-bot-public-plan');
const repoRef = require('../services/repo-ref');

function parseOwnerRepo(repoUrl) {
  return repoRef.ownerRepo(repoUrl);
}

function issueNumberOf(req) {
  const n = Number(req.params.number);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

function requestSpecRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.post('/api/apps/:slug/issues/:number/spec', requestSpecLimiter, communities.requireAppMembership(pool), async (req, res) => {
    const issueNumber = issueNumberOf(req);
    if (!issueNumber) return res.status(400).json({ error: 'Invalid request number' });
    const spec = req.body && req.body.spec;
    if (typeof spec !== 'string') {
      return res.status(400).json({ error: 'invalid_request', message: 'spec must be a string.' });
    }
    // Refuse a spec that cannot be stored before reading GitHub, so a
    // malformed post costs nothing.
    const prepared = requestSpecs.prepareSpec(spec);
    if (!prepared.ok) {
      const { status, code, message, ok, ...extra } = prepared;
      return res.status(status).json({ error: code, message, ...extra });
    }
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Only a request that is open now, the same positive confirmation the
      // claim route asks for: a degraded GitHub read changes nothing.
      // 1 Nov 2026: the check is the service's, shared with a design posted
      // as a plan (design-threads.js postDesignPlan).
      const open = await requestSpecs.openRequest(app, issueNumber, { github });
      if (!open.ok) return res.status(open.status).json({ error: open.error });
      const { repo, issue } = open;

      // The same host the screenshot embeds name (routes/feedback.js).
      const domain = require('../services/caddy').USERNODE_DOMAIN;
      const posted = await requestSpecs.postRequestSpec(pool, {
        app, repo, issueNumber, issueTitle: issue.title, user: req.user, text: spec,
        webPath: domain ? `https://${domain}/#app/${app.slug}/dev/issues/${issueNumber}` : null,
      });
      return res.status(201).json({ ok: true, issueNumber, ...posted });
    } catch (err) {
      if (err instanceof requestSpecs.SpecError) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
      }
      log.error('request-specs', 'Posting a spec failed', { issueNumber, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/issues/:number/specs', async (req, res) => {
    const issueNumber = issueNumberOf(req);
    if (!issueNumber) return res.status(400).json({ error: 'Invalid request number' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const specs = await requestSpecs.listRequestSpecs(pool, {
        appId: app.id, issueNumber, viewerId: req.user.id,
      });
      return res.json({ issueNumber, specs, listLimit: requestSpecs.MAX_LISTED_SPECS });
    } catch (err) {
      log.error('request-specs', 'Listing specs failed', { issueNumber, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6207/#6210 (3 Nov 2026): Homeroom bot's plan for the request, public on
  // its page (services/homeroom-bot-public-plan.js). Reading it needs what
  // reading the request needs; Build it is taking part, so members only,
  // and the presser's own week pays for it.
  router.get('/api/apps/:slug/issues/:number/bot-plan', async (req, res) => {
    const issueNumber = issueNumberOf(req);
    if (!issueNumber) return res.status(400).json({ error: 'Invalid request number' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view');
      if (!app) return res.status(404).json({ error: 'App not found' });
      return res.json(await publicPlan.readPlan(pool, { app, issueNumber, viewer: req.user || null }));
    } catch (err) {
      log.error('request-specs', 'Reading a request\'s plan failed', { issueNumber, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/issues/:number/bot-plan/build', conversationActionLimiter, sameOriginBrowserOnly,
    communities.requireAppMembership(pool), async (req, res) => {
      const issueNumber = issueNumberOf(req);
      if (!issueNumber) return res.status(400).json({ error: 'Invalid request number' });
      if (!req.user || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      try {
        const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view');
        if (!app) return res.status(404).json({ error: 'App not found' });
        const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
        const runId = Number(req.body?.runId) || null;
        const went = await publicPlan.buildPlan(pool, {
          app, issueNumber, user: req.user, runId, answers,
        });
        if (!went.ok) {
          return res.status(went.status).json({
            error: went.error, ...(went.code ? { code: went.code, signals: went.signals || [] } : {}),
          });
        }
        return res.json({ ok: true });
      } catch (err) {
        log.error('request-specs', 'Build it on a request\'s plan failed', { issueNumber, message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

  return router;
}

module.exports = { requestSpecRoutes, parseOwnerRepo };
