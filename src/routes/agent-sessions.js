'use strict';

// Agent sessions (#2779, spec: docs/agent-sessions.md): the HTTP surface.
//
// Every route is owner-scoped: another user's session answers 404, never
// 403, so ids are not enumerable. Only CREATING a session is gated on the
// experimental flag (req.user.agentSessionsEnabled). A user who turns the
// flag off keeps their existing conversations, the same way turning it on
// leaves their classic sessions alone.
//
// The Mayor's turn, its stream and its confirmation cards arrive in the next
// step of #2779; this is the conversation's data: create, list, read, rename,
// archive, and its transcript.

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { agentSessionCreateLimiter } = require('../middleware/rate-limits');
const agentSessions = require('../services/agent-sessions');

function sendError(res, err, what) {
  if (err instanceof agentSessions.AgentSessionError) {
    return res.status(err.status).json({ error: err.message });
  }
  log.error('agent-sessions', `${what} failed`, { message: err.message });
  return res.status(500).json({ error: 'Internal server error' });
}

function agentSessionRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);

  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  // POST /api/agent-sessions { hint?: { slug, issueNumber?, proposalId?, entry? } }
  router.post('/api/agent-sessions', requireUser, agentSessionCreateLimiter, async (req, res) => {
    if (!req.user.agentSessionsEnabled) {
      return res.status(403).json({ error: 'Agent sessions are not turned on for your account.' });
    }
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object.' });
    }
    const unknown = Object.keys(body).filter((key) => key !== 'hint');
    if (unknown.length) return res.status(400).json({ error: `Unsupported field: ${unknown[0]}` });
    try {
      const session = await agentSessions.createAgentSession(pool, { user: req.user, hint: body.hint });
      return res.status(201).json({ session });
    } catch (err) {
      return sendError(res, err, 'Create agent session');
    }
  });

  // GET /api/agent-sessions?status=open|archived&limit=&before=
  router.get('/api/agent-sessions', requireUser, async (req, res) => {
    try {
      const result = await agentSessions.listAgentSessions(pool, {
        userId: req.user.id,
        status: req.query.status ? String(req.query.status) : 'open',
        limit: req.query.limit,
        before: req.query.before ? String(req.query.before) : null,
      });
      return res.json(result);
    } catch (err) {
      return sendError(res, err, 'List agent sessions');
    }
  });

  router.get('/api/agent-sessions/:id', requireUser, async (req, res) => {
    try {
      const session = await agentSessions.getAgentSession(pool, { userId: req.user.id, id: req.params.id });
      if (!session) return res.status(404).json({ error: 'Agent session not found' });
      return res.json({ session });
    } catch (err) {
      return sendError(res, err, 'Read agent session');
    }
  });

  // GET /api/agent-sessions/:id/messages?after=<message id>&limit=
  router.get('/api/agent-sessions/:id/messages', requireUser, async (req, res) => {
    try {
      const result = await agentSessions.listMessages(pool, {
        userId: req.user.id,
        id: req.params.id,
        afterId: req.query.after,
        limit: req.query.limit,
      });
      if (!result) return res.status(404).json({ error: 'Agent session not found' });
      return res.json(result);
    } catch (err) {
      return sendError(res, err, 'Read agent session messages');
    }
  });

  router.patch('/api/agent-sessions/:id/title', requireUser, async (req, res) => {
    try {
      const session = await agentSessions.renameAgentSession(pool, {
        userId: req.user.id, id: req.params.id, title: req.body && req.body.title,
      });
      if (!session) return res.status(404).json({ error: 'Agent session not found' });
      return res.json({ session });
    } catch (err) {
      return sendError(res, err, 'Rename agent session');
    }
  });

  router.post('/api/agent-sessions/:id/archive', requireUser, async (req, res) => {
    try {
      const session = await agentSessions.archiveAgentSession(pool, { userId: req.user.id, id: req.params.id });
      if (!session) return res.status(404).json({ error: 'Agent session not found or already archived' });
      return res.json({ session });
    } catch (err) {
      return sendError(res, err, 'Archive agent session');
    }
  });

  router.post('/api/agent-sessions/:id/unarchive', requireUser, async (req, res) => {
    try {
      const session = await agentSessions.unarchiveAgentSession(pool, { userId: req.user.id, id: req.params.id });
      if (!session) return res.status(404).json({ error: 'Agent session not found or not archived' });
      return res.json({ session });
    } catch (err) {
      return sendError(res, err, 'Unarchive agent session');
    }
  });

  return router;
}

module.exports = { agentSessionRoutes };
