'use strict';

const { Router, raw } = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const gitHost = require('../services/git-host');
const source = require('../services/project-source');
const log = require('../services/logger');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

const UPLOAD_PACK = 'git-upload-pack';
const MAX_NEGOTIATION = '4mb';
const GIT_ROUTE = /^\/api\/internal\/project-source\/git\/([a-z0-9][a-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack)$/;
const ARCHIVE_ROUTE = /^\/api\/internal\/project-source\/archive\/([a-z0-9][a-z0-9._-]{0,99})\/([a-f0-9]{40})\.tar\.gz$/;

function validGitRequest(req) {
  const path = req.params[1];
  return (req.method === 'GET' && path === 'info/refs' && req.query.service === UPLOAD_PACK)
    || (req.method === 'POST' && path === UPLOAD_PACK && req.is('application/x-git-upload-pack-request'));
}

function authorizeGit(req, res, next) {
  const token = source.fromAuthorization(req.get('authorization'));
  if (!validGitRequest(req) || !source.selected(req.params[0])
      || !source.verifyGrant(token, 'git', req.params[0])) return res.sendStatus(404);
  next();
}

async function relayGit(req, res) {
  const repo = req.params[0];
  const endpoint = req.method === 'GET' ? `info/refs?service=${UPLOAD_PACK}` : UPLOAD_PACK;
  const credential = gitHost.readCredential();
  if (!credential) return res.sendStatus(503);
  const basic = Buffer.from(`${credential.username}:${credential.token}`, 'utf8').toString('base64');
  const headers = { Authorization: `Basic ${basic}` };
  const protocol = req.get('git-protocol');
  if (protocol === 'version=2') headers['Git-Protocol'] = protocol;
  if (req.method === 'POST') headers['Content-Type'] = 'application/x-git-upload-pack-request';
  const cancel = new AbortController();
  res.once('close', () => cancel.abort());
  try {
    const upstream = await fetch(`${gitHost.cloneUrl(repo)}/${endpoint}`, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? req.body : undefined,
      redirect: 'error',
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(source.MAX_SOURCE_TIME_MS)]),
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return res.sendStatus(upstream.status === 404 ? 404 : 502);
    }
    res.set('Content-Type', req.method === 'GET'
      ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result');
    res.set('Cache-Control', 'private, no-store');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (res.destroyed) return;
    log.warn('project-source', 'Source negotiation failed', { repo, code: err.code });
    if (!res.headersSent) res.sendStatus(502);
    else res.destroy();
  }
}

function internalProjectSourceRoutes(config) {
  const router = Router();
  // A read-only Git relay. The grant and URL agree on a repository before
  // reading the request body. No client-provided URL or receive-pack is used.
  router.get(GIT_ROUTE, authorizeGit, relayGit);
  router.post(GIT_ROUTE, sameOriginBrowserOnly, authorizeGit, raw({ type: 'application/x-git-upload-pack-request', limit: MAX_NEGOTIATION, inflate: false }), relayGit);
  router.get(ARCHIVE_ROUTE, async (req, res) => {
    const [repo, revision] = [req.params[0], req.params[1]];
    const grant = source.verifyGrant(req.query.grant, 'archive', repo);
    if (grant?.revision !== revision || !source.selected(repo)) return res.sendStatus(404);
    try {
      await source.archive(repo, revision, res);
    } catch (err) {
      if (res.destroyed) return;
      log.warn('project-source', 'Build source download failed', { repo, revision, code: err.code });
      if (!res.headersSent) res.sendStatus(502);
      else res.destroy();
    }
  });
  router.get('/api/external-tasks/:taskId/source/:repo', async (req, res) => {
    const taskId = Number(req.params.taskId);
    const repo = req.params.repo;
    const grant = source.verifyGrant(source.fromAuthorization(req.get('authorization')), 'work-order', repo);
    if (!Number.isSafeInteger(taskId) || taskId <= 0 || grant?.taskId !== taskId) return res.sendStatus(404);
    try {
      const pool = getPool(config);
      const { rows: [task] } = await pool.query(
        `SELECT a.*, t.base_sha, u.id AS source_user_id, u.is_admin AS source_user_admin
           FROM external_agent_tasks t
           JOIN apps a ON a.id = t.app_id
           JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 AND t.user_id = $2 AND t.status = 'open'
            AND t.expires_at > NOW() AND u.anonymised_at IS NULL`,
        [taskId, grant.userId],
      );
      if (!task || grant.revision !== task.base_sha || source.managedRepo(task.repo_url) !== repo
          || !await appAccess.checkAppAccess(pool, task, { id: task.source_user_id, isAdmin: task.source_user_admin }, 'collab')) {
        return res.sendStatus(404);
      }
      await source.bundle(repo, grant.revision, res);
    } catch (err) {
      if (res.destroyed) return;
      log.warn('project-source', 'Work order source download failed', { taskId, code: err.code });
      if (!res.headersSent) res.sendStatus(502);
      else res.destroy();
    }
  });
  return router;
}

function memberProjectSourceRoutes(config) {
  const router = Router();
  router.get('/api/apps/:slug/source', async (req, res) => {
    if (!req.user?.id) return res.sendStatus(404);
    try {
      const pool = getPool(config);
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab',
        `${appAccess.ACCESS_COLUMNS}, repo_url`);
      if (!source.privateApp(app)) return res.sendStatus(404);
      const repo = source.managedRepo(app.repo_url);
      const revision = await gitHost.readRef(repo);
      if (!revision) return res.sendStatus(404);
      if (req.query.revision != null && req.query.revision !== revision) return res.sendStatus(409);
      await source.bundle(repo, revision, res, `${app.slug}.bundle`);
    } catch (err) {
      if (res.destroyed) return;
      log.warn('project-source', 'Member source download failed', { code: err.code });
      if (!res.headersSent) res.sendStatus(502);
      else res.destroy();
    }
  });
  return router;
}

module.exports = { internalProjectSourceRoutes, memberProjectSourceRoutes };
