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
const { requestSpecLimiter } = require('../middleware/rate-limits');

function parseOwnerRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
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
      const repo = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !repo) {
        return res.status(422).json({ error: 'Cannot verify the request right now: GitHub is unavailable for this app.' });
      }
      const open = await github.fetchPublicIssues(repo.owner, repo.repo);
      if (open.note) {
        return res.status(422).json({ error: "Couldn't confirm this request is open right now. Try again in a moment." });
      }
      const issue = (open.issues || []).find((i) => i.number === issueNumber);
      if (!issue) return res.status(404).json({ error: `Request #${issueNumber} isn't open on this app.` });

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

  return router;
}

module.exports = { requestSpecRoutes, parseOwnerRepo };
