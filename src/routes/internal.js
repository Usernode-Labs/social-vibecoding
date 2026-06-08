'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { internalAuth } = require('../middleware/internal-auth');
const log = require('../services/logger');
const worker = require('../services/worker');
const github = require('../services/github');

// Worker → platform internal API surface.
//
// Mounted in server.js BEFORE the global authMiddleware so cookie auth
// doesn't apply. Auth is handled by the internalAuth middleware, which
// verifies a session-scoped JWT minted at warm-container bootstrap (see
// src/services/worker.js's mintWorkerJwt).
//
// These endpoints are the only path by which a worker container can
// affect anything outside its own filesystem. The worker carries no
// GitHub credentials at all — its sole write capability is whatever
// this router chooses to expose. Today:
//   - POST /api/internal/sessions/:id/push  →  git push the session's
//     canonical branch (looked up from the DB; the worker doesn't get
//     to pick).
//   - POST /api/internal/sessions/:id/pr    →  create a PR for the
//     session's canonical branch.
//
// Both endpoints are rate-limited per session to bound the blast
// radius of a runaway CC turn. A push storm at 60/min still gives us
// plenty of headroom for normal use (typical session pushes 1–5 times)
// while preventing 1000+/sec API hammering.

function internalRoutes(_config) {
  const router = Router();
  const pool = getPool(_config);

  const pushLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Push proxy rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.post(
    '/api/internal/sessions/:sessionId/push',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let session;
      try {
        const { rows } = await pool.query(
          `SELECT cs.id, cs.branch_name, cs.status, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        session = rows[0];
      } catch (err) {
        log.error('internal-api', 'Session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      if (!session.branch_name) {
        return res.status(400).json({ ok: false, code: 'no_branch' });
      }
      if (['closed', 'archived', 'merged', 'failed'].includes(session.status)) {
        return res.status(409).json({ ok: false, code: 'session_inactive', status: session.status });
      }

      // Defensive: re-confirm the repo is public before pushing. The
      // worker bootstrap guard catches most cases, but a user could
      // flip the repo to private mid-session. Keeping the worker's
      // push proxy public-only matches the import-time enforcement.
      const parsed = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.status(400).json({ ok: false, code: 'bad_repo_url' });
      }
      const [, owner, repo] = parsed;
      const privacy = await github.checkRepoPublic(owner, repo);
      if (!privacy.ok) {
        return res.status(502).json({ ok: false, code: privacy.code, message: privacy.message });
      }
      if (privacy.private) {
        return res.status(403).json({
          ok: false, code: 'private_repo',
          message: `${owner}/${repo} is private; Usernode supports public repos only.`,
        });
      }

      try {
        const { sha } = await worker.execPushFromWorker(sessionId, session.branch_name);
        return res.json({ ok: true, branch: session.branch_name, sha });
      } catch (err) {
        return res.status(502).json({
          ok: false,
          code: err.code || 'push_failed',
          message: err.message,
        });
      }
    }
  );

  // Read-only: list the session repo's OPEN GitHub issues. Backs the
  // worker's usernode-issues CLI (scout + build), giving Claude Code the
  // same list_github_issues capability the Mayor has in-process. Anonymous
  // public fetch with no credentials — caching, pagination, and PR-filtering
  // all live in github.fetchPublicIssues. GET because it mutates nothing;
  // accepts the session-scoped ISSUES_JWT via the same internalAuth gate.
  router.get(
    '/api/internal/sessions/:sessionId/issues',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issues)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        repoUrl = rows[0].repo_url || '';
      } catch (err) {
        log.error('internal-api', 'Issues session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      // Same .git-tolerant parse the push route uses. No repo → return the
      // well-formed empty-with-note shape so the agent gets a clean answer.
      const parsed = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.json({ ok: true, issues: [], truncatedList: false, note: 'no repo' });
      }
      const [, owner, repo] = parsed;
      const result = await github.fetchPublicIssues(owner, repo);
      return res.json({ ok: true, ...result });
    }
  );

  // PR creation endpoint. Today's `git push` path doesn't strictly
  // need a worker-callable PR endpoint (the platform's sessions route
  // creates PRs as part of the per-turn finalization flow), but
  // exposing it here closes the last hole where the worker would need
  // a token to do something cross-cutting. It's a thin wrapper around
  // github.createPR; same per-session auth + rate limit as push.
  router.post(
    '/api/internal/sessions/:sessionId/pr',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      const { title, body } = req.body || {};
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ ok: false, code: 'bad_title' });
      }

      let session;
      try {
        const { rows } = await pool.query(
          `SELECT cs.id, cs.branch_name, cs.status, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, code: 'session_not_found' });
        session = rows[0];
      } catch (err) {
        return res.status(500).json({ ok: false, code: 'db_error', message: err.message });
      }

      if (!session.branch_name) {
        return res.status(400).json({ ok: false, code: 'no_branch' });
      }
      const parsed = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) return res.status(400).json({ ok: false, code: 'bad_repo_url' });
      const [, owner, repo] = parsed;

      try {
        const pr = await github.createPR(owner, repo, {
          branch: session.branch_name,
          title,
          body: body || '',
        });
        return res.json({ ok: true, number: pr.number, url: pr.html_url });
      } catch (err) {
        log.warn('internal-api', 'PR create via worker proxy failed', {
          sessionId, owner, repo, err: err.message,
        });
        return res.status(502).json({ ok: false, code: 'pr_failed', message: err.message });
      }
    }
  );

  return router;
}

module.exports = { internalRoutes };
