'use strict';

// Versions, as an original and as a version (docs/plans/versions.md):
//
//   GET  /api/apps/:slug/versions   the original's hub, "From its versions":
//                                   how many versions it has and how many
//                                   get its updates, the suggestions they
//                                   sent, what they merged lately, and how
//                                   its last update went down
//                                   (services/version-links.js hub).
//   POST /api/apps/:slug/follow-pr  { follow } on a version: put whether it
//                                   gets its original's updates to the vote,
//                                   as the manifest PR that sets dapp.json's
//                                   `followOriginal` (services/follow-pr.js),
//                                   opened on a conductor like every settings
//                                   proposal. It answers
//                                   { ok, sessionId, prNumber, href }, or 409
//                                   `already_open` naming the one already up.
//
// The hub is view-gated like the page it is on. Proposing is taking part,
// so the POST has the membership gate (communities.requireAppMembership)
// and needs build access, as starting any other change does.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const communities = require('../services/communities');
const github = require('../services/github');
const repoRef = require('../services/repo-ref');
const lineage = require('../services/upstream-lineage');
const versionLinks = require('../services/version-links');
const followPr = require('../services/follow-pr');
const platformOperations = require('../services/platform-operations');
const { changeHref } = require('../services/change-destination');
const { drainGuard } = require('../services/lifecycle');
const { issueCreateLimiter } = require('../middleware/rate-limits');

const MESSAGES = Object.freeze({
  notAVersion: 'This project was not made from another one, so there are no updates to get.',
  already: (follow) => (follow ? 'This project already gets its original\'s updates.'
    : 'This project already does not get its original\'s updates.'),
  alreadyOpen: 'A change to whether this project gets its original\'s updates is already waiting for a vote.',
  collabRequired: 'Only people who build this project can propose this.',
  noCodeHost: 'Settings changes need a code host configured on the platform.',
});

function alreadyOpenBody(app, open) {
  return {
    error: MESSAGES.alreadyOpen,
    code: 'already_open',
    sessionId: open.id ?? open.sessionId ?? null,
    prNumber: open.pr_number ?? open.prNumber ?? null,
    href: changeHref(app.slug, open.id ?? open.sessionId, open.pr_number ?? open.prNumber),
    title: open.pr_title ?? null,
  };
}

// The settings proposal, on a conductor (`manifest.propose`), as
// routes/apps.js asks for its own; its refusal answered as it says, and a
// proposal of this kind already up (the conductor read it again) named.
async function proposeManifest(res, app, user, flavor, args) {
  const out = await platformOperations.request({
    op: 'manifest.propose', appId: app.id, userId: user.id,
    input: { flavor, args, repoUrl: app.repo_url },
  });
  if (out.ok) return out;
  const { ok: _ok, status, ...body } = out;
  if (status === 409 && body.sessionId != null) {
    res.status(409).json(alreadyOpenBody(app, { id: body.sessionId, pr_number: body.prNumber }));
    return null;
  }
  res.status(status || 500).json(body);
  return null;
}

function versionsRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  const requireAppMembership = communities.requireAppMembership(pool);

  // The app, as the caller may see it: 404 for a slug that does not resolve
  // or that they cannot view, as every app route answers.
  async function loadApp(req, res) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
    const app = rows[0] || null;
    if (!app || (app.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting)
      || !(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    return app;
  }

  router.get('/api/apps/:slug/versions', async (req, res) => {
    try {
      const app = await loadApp(req, res);
      if (!app) return;
      res.json(await versionLinks.hub(pool, app));
    } catch (err) {
      log.error('versions', 'Hub read failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/follow-pr', drainGuard, issueCreateLimiter, requireAppMembership, async (req, res) => {
    const follow = req.body?.follow;
    if (typeof follow !== 'boolean') {
      return res.status(400).json({ error: 'follow must be true or false' });
    }
    try {
      const app = await loadApp(req, res);
      if (!app) return;
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'collab'))) {
        return res.status(403).json({ error: MESSAGES.collabRequired });
      }
      const link = lineage.readUpstream(app);
      if (!link || app.self_hosted) {
        return res.status(409).json({ error: MESSAGES.notAVersion, code: 'not_a_version' });
      }
      if (link.following === follow) {
        return res.status(400).json({ error: MESSAGES.already(follow), code: 'unchanged' });
      }
      // One in flight per project: the caller is pointed at the open one.
      const open = await followPr.findFollowPr(pool, app.id);
      if (open) return res.status(409).json(alreadyOpenBody(app, open));

      if (!github.hasWriteAccess()) return res.status(503).json({ error: MESSAGES.noCodeHost });
      if (!app.repo_url || !repoRef.parse(app.repo_url)) {
        return res.status(400).json({ error: 'App has no repository to open a PR against' });
      }

      // The original by name, for the proposal's title ("Get Tier list's
      // updates"); its slug when it is gone.
      const { rows: [original] = [] } = await pool.query('SELECT name FROM apps WHERE id = $1', [link.appId]);
      const originalName = (original && original.name) || link.slug || null;

      const result = await proposeManifest(res, app, req.user, 'follow', { follow, originalName });
      if (!result) return;
      res.status(201).json({
        ok: true,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        href: changeHref(app.slug, result.sessionId, result.prNumber),
      });
    } catch (err) {
      log.error('versions', 'Follow PR failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { versionsRoutes, MESSAGES };
