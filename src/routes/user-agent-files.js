'use strict';

// #460: /api/me/agent-files — per-user global agent instruction & skill
// files, managed from the account Settings modal ("Agent instructions &
// skills"). Storage + validation live in services/user-agent-files.js;
// the worker-side materialization happens at dispatch time in
// routes/sessions.js via worker.syncUserAgentFiles.
//
// All endpoints are personal (`req.user` only — 401 otherwise), matching
// the /api/me/* family in routes/auth.js and routes/llm-grants.js.

const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const uaf = require('../services/user-agent-files');
const { agentFileWriteLimiter } = require('../middleware/rate-limits');

function userAgentFilesRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // List (metadata only, no content). ?demo=1 in staging returns
  // fabricated rows — the table is staging:private (always empty in a
  // staging clone), same pattern as GET /api/me/llm-grants.
  router.get('/api/me/agent-files', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    if (req.query.demo === '1' && process.env.USERNODE_ENV === 'staging') {
      const files = uaf.demoFiles().map(({ content, ...meta }) => meta);
      return res.json({ files, demo: true, limits: limitsJson() });
    }

    try {
      const files = await uaf.listForUser(pool, req.user.id);
      res.json({ files, limits: limitsJson() });
    } catch (err) {
      log.error('agent-files', 'List failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Failed to load agent files' });
    }
  });

  // Single file's content (the Settings viewer). Demo rows are served
  // from the same fabricated set so the viewer works in staging too.
  router.get('/api/me/agent-files/content', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const kind = String(req.query.kind || '');
    const name = String(req.query.name || '');
    if (!uaf.KINDS.includes(kind) || !uaf.NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid kind or name' });
    }

    if (req.query.demo === '1' && process.env.USERNODE_ENV === 'staging') {
      const hit = uaf.demoFiles().find((f) => f.kind === kind && f.name === name);
      if (!hit) return res.status(404).json({ error: 'File not found' });
      return res.json({ file: hit, demo: true });
    }

    try {
      const file = await uaf.getFile(pool, req.user.id, kind, name);
      if (!file) return res.status(404).json({ error: 'File not found' });
      res.json({ file });
    } catch (err) {
      log.error('agent-files', 'Content fetch failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Failed to load the file' });
    }
  });

  // Upload / replace. Scoped body parser: the global express.json is the
  // 100 kb default (see server.js), too small for a 48 KB file once
  // JSON-escaped — same scoped-parser precedent as routes/anthropic-proxy.
  router.post('/api/me/agent-files', agentFileWriteLimiter, express.json({ limit: '256kb' }), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
    if (!uaf.KINDS.includes(kind)) {
      return res.status(400).json({ error: 'kind must be "instruction" or "skill"' });
    }
    const name = uaf.normalizeName(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: 'Name must contain letters or numbers (it becomes a lowercase slug like "code-style")' });
    }
    const contentCheck = uaf.validateContent(req.body?.content);
    if (!contentCheck.ok) {
      return res.status(400).json({ error: contentCheck.error });
    }
    const content = req.body.content;
    const description = kind === 'skill'
      ? uaf.skillDescription(content, req.body?.description)
      : (typeof req.body?.description === 'string'
          ? req.body.description.trim().slice(0, uaf.MAX_DESCRIPTION_LEN)
          : '');

    try {
      const file = await uaf.upsertFile(pool, req.user.id, {
        kind, name, description, content, sizeBytes: contentCheck.sizeBytes,
      });
      log.info('agent-files', 'File saved', {
        userId: req.user.id, kind, name, sizeBytes: contentCheck.sizeBytes,
      });
      res.status(201).json({ ok: true, file });
    } catch (err) {
      if (err.code === 'kind_cap') {
        return res.status(400).json({ error: err.message });
      }
      log.error('agent-files', 'Save failed', { userId: req.user.id, kind, name, err: err.message });
      res.status(500).json({ error: 'Failed to save the file' });
    }
  });

  // Delete. Takes kind+name in the body (mirrors the POST shape; names
  // are slugs so a path param would also work, but the body keeps the
  // pair atomic and symmetric with upload).
  router.delete('/api/me/agent-files', agentFileWriteLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!uaf.KINDS.includes(kind) || !uaf.NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid kind or name' });
    }
    try {
      const removed = await uaf.deleteFile(pool, req.user.id, kind, name);
      if (!removed) return res.status(404).json({ error: 'File not found' });
      log.info('agent-files', 'File deleted', { userId: req.user.id, kind, name });
      res.json({ ok: true });
    } catch (err) {
      log.error('agent-files', 'Delete failed', { userId: req.user.id, kind, name, err: err.message });
      res.status(500).json({ error: 'Failed to delete the file' });
    }
  });

  return router;
}

function limitsJson() {
  return {
    maxFilesPerKind: uaf.MAX_FILES_PER_KIND,
    maxFileBytes: uaf.MAX_FILE_BYTES,
  };
}

module.exports = { userAgentFilesRoutes };
