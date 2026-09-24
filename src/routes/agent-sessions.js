'use strict';

// Agent sessions (#2779, spec: docs/agent-sessions.md): the HTTP surface.
//
// Every route is owner-scoped: another user's session answers 404, never
// 403, so ids are not enumerable. Only CREATING a session is gated on the
// experimental flag (req.user.agentSessionsEnabled). A user who turns the
// flag off keeps their existing conversations, the same way turning it on
// leaves their classic sessions alone.
//
// The conversation's data (create, list, read, rename, archive, its
// transcript), and since step 3b its Mayor: a turn streamed over SSE, its
// resumable event stream, stop, and the confirmation cards the Mayor's
// writes wait on.

const crypto = require('node:crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { agentSessionCreateLimiter, attachmentUploadLimiter, chatLimiter } = require('../middleware/rate-limits');
const attachmentsSvc = require('../services/attachments');
const { drainGuard } = require('../services/lifecycle');
const agentSessions = require('../services/agent-sessions');
const actions = require('../services/agent-session-actions');
const agentTurn = require('../services/mayor/agent-turn');
const models = require('../services/models');
const agentPreferences = require('../services/agent-preferences');
const notifications = require('../services/notifications');

const MAX_MESSAGE_CHARS = 20000;

const positiveId = (value) => (/^[1-9]\d{0,9}$/.test(String(value || '')) && Number(value) <= 2147483647
  ? Number(value) : null);

function sendError(res, err, what) {
  if (err instanceof agentSessions.AgentSessionError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof actions.ActionError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  log.error('agent-sessions', `${what} failed`, { message: err.message });
  return res.status(500).json({ error: 'Internal server error' });
}

// `scheduleInteractiveRecovery` is server.js's retained-turn scheduler, the
// one routes/sessions.js is given: a dispatch from a conversation leaves its
// change's durable turn to it exactly as a classic turn does.
function agentSessionRoutes(config, { scheduleInteractiveRecovery = null } = {}) {
  const router = express.Router();
  const pool = getPool(config);

  // After a confirmed card the Mayor gets a short follow-up turn, so it can
  // say what happened and carry on (dispatch the build the user asked for
  // before the change existed). No request is open for it: it streams on the
  // conversation's bus, which GET .../events follows. It only runs when the
  // conversation is free and somebody can pay for it; otherwise the outcome
  // simply waits in the conversation for the next turn.
  const startFollowUp = async ({ user, agentSessionId, outcome }) => {
    const turnId = agentTurn.newTurnId();
    const leased = await agentSessions.acquireTurnLease(pool, { agentSessionId, userId: user.id, turnId });
    if (!leased) return null;
    let mayor = null;
    try {
      mayor = await agentTurn.resolveAgentMayor({ pool, config, userId: user.id, agentSessionId });
    } catch (err) {
      log.warn('agent-sessions', 'Follow-up turn could not resolve the Mayor', { agentSessionId, err: err.message });
    }
    if (!mayor || !mayor.ok) {
      await agentSessions.releaseTurnLease(pool, { agentSessionId, turnId }).catch(() => {});
      return null;
    }
    agentTurn.runAgentTurn({
      pool,
      config,
      user,
      agentSessionId,
      turnId,
      followUp: {
        toolName: outcome.toolName,
        title: actions.ACTION_LABELS[outcome.toolName] || outcome.toolName,
        ok: outcome.status === 'done',
      },
      mayor,
      res: null,
      scheduleInteractiveRecovery,
    }).catch((err) => {
      log.error('agent-sessions', 'Follow-up turn crashed', { agentSessionId, err: err.message });
    });
    return { turnId };
  };

  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  // The composer's model choice, validated the way the dev chat's picker is.
  // `{ backend: 'claude_code', model }` names one of the Anthropic models
  // (none means the default); `{ backend: 'codex_openrouter', model,
  // reasoningEffort? }` goes through the dev chat's own explicit resolver
  // (routes/sessions.js), which checks the deployment, the account and the
  // model against the viewer's OpenRouter catalog. Throws an error carrying a
  // status on a choice that cannot be honoured.
  const resolveChoice = async (user, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new agentSessions.AgentSessionError(400, 'agent must be an object');
    }
    const unknown = Object.keys(raw).filter((key) => !['backend', 'model', 'reasoningEffort'].includes(key));
    if (unknown.length) throw new agentSessions.AgentSessionError(400, `Unsupported agent field: ${unknown[0]}`);
    if (raw.backend === 'claude_code') {
      const model = raw.model == null || raw.model === '' ? null : String(raw.model);
      if (model !== null && !models.isAllowed(model)) {
        throw new agentSessions.AgentSessionError(400, 'That model is not available.');
      }
      return { backend: 'claude_code', model: model || models.DEFAULT_MODEL, reasoningEffort: null };
    }
    if (raw.backend !== 'codex_openrouter') {
      throw new agentSessions.AgentSessionError(400, 'agent.backend must be claude_code or codex_openrouter');
    }
    const { resolveExplicitAgentPreference, AgentSelectionError } = require('./sessions');
    try {
      const pref = await resolveExplicitAgentPreference(pool, user.id, config, {
        backend: raw.backend, model: raw.model, reasoningEffort: raw.reasoningEffort,
      });
      return { backend: pref.backend, model: pref.model, reasoningEffort: pref.reasoningEffort || null };
    } catch (err) {
      if (err instanceof AgentSelectionError) {
        throw new agentSessions.AgentSessionError(err.statusCode || 400, err.message);
      }
      throw err;
    }
  };

  // A pick is also the answer to "which one did you use last", as it is in the
  // dev chat (#1348): the next conversation and the next classic change start
  // from it. Best effort and after the fact: a default that failed to save
  // must not turn a successful pick into an error. The Anthropic model is not
  // part of the stored default (a Claude default carries none), so only the
  // backend, and an OpenRouter model and effort, are remembered.
  const rememberChoice = (userId, agent) => {
    agentPreferences.setDefaultBackend(pool, userId, {
      backend: agent.backend,
      model: agent.backend === 'codex_openrouter' ? agent.model : null,
      reasoningEffort: agent.backend === 'codex_openrouter' ? agent.reasoningEffort : null,
    }).catch((err) => {
      log.warn('agent-sessions', 'Model choice not remembered as the default', { userId, err: err.message });
    });
  };

  // GET /api/agent-sessions/draft?slug=&issueNumber=&proposalId=&entry=
  // What an UNSENT conversation is about: the hint resolved exactly as
  // creating one would resolve it, and nothing written. New change opens this
  // state; the row only exists once the first message is sent.
  router.get('/api/agent-sessions/draft', requireUser, async (req, res) => {
    if (!req.user.agentSessionsEnabled) {
      return res.status(403).json({ error: 'Agent sessions are not turned on for your account.' });
    }
    const q = req.query || {};
    const hint = {};
    if (q.slug) hint.slug = String(q.slug);
    if (q.issueNumber) hint.issueNumber = Number(q.issueNumber);
    if (q.proposalId) hint.proposalId = Number(q.proposalId);
    if (q.entry) hint.entry = String(q.entry);
    try {
      const draft = await agentSessions.previewDraft(pool, { user: req.user, hint: Object.keys(hint).length ? hint : null });
      return res.json({ draft });
    } catch (err) {
      return sendError(res, err, 'Preview agent session');
    }
  });

  // POST /api/agent-sessions { hint?: { slug, issueNumber?, proposalId?, entry? }, agent? }
  // Called on the FIRST message of a New change, carrying the model the
  // viewer picked while it was unsent (`agent`, see resolveChoice).
  router.post('/api/agent-sessions', requireUser, agentSessionCreateLimiter, async (req, res) => {
    if (!req.user.agentSessionsEnabled) {
      return res.status(403).json({ error: 'Agent sessions are not turned on for your account.' });
    }
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object.' });
    }
    const unknown = Object.keys(body).filter((key) => key !== 'hint' && key !== 'agent');
    if (unknown.length) return res.status(400).json({ error: `Unsupported field: ${unknown[0]}` });
    try {
      const agent = body.agent == null ? null : await resolveChoice(req.user, body.agent);
      const session = await agentSessions.createAgentSession(pool, { user: req.user, hint: body.hint, agent });
      if (agent) rememberChoice(req.user.id, agent);
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
      // Reading the conversation is seeing what it finished, so the green
      // dot beside it in the lists clears; before the read, so the session
      // this answers with says so too. The owner's other tabs are told.
      const cleared = await agentSessions.markSeen(pool, { userId: req.user.id, id: req.params.id }).catch((err) => {
        log.warn('agent-sessions', 'Could not mark the conversation seen', { err: err.message });
        return false;
      });
      if (cleared) {
        require('../services/ws').pushToUser(req.user.id, { type: 'agent_session_changed', agentSessionId: Number(req.params.id), busy: false });
      }
      const session = await agentSessions.getAgentSession(pool, { userId: req.user.id, id: req.params.id });
      if (!session) return res.status(404).json({ error: 'Agent session not found' });
      // Reading the conversation is seeing what its changes finished with:
      // the bell's "The coding agent finished" rows for it are answered,
      // however the user got here. Fire-and-forget, like the dev chat's.
      notifications.markReadForAgentSession(pool, req.user.id, session.id)
        .then((cleared) => {
          if (cleared > 0) require('../services/ws').pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
        })
        .catch((err) => log.warn('agent-sessions', 'session_done dismiss failed', { err: err.message }));
      // Where a running turn is, when it runs in this process, so a client
      // that opens the conversation mid-turn shows the right controls.
      return res.json({ session, turn: agentTurn.turnState(session.id) });
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

  // PATCH /api/agent-sessions/:id/agent { backend, model?, reasoningEffort? }
  // The composer's picker. Allowed at any time, mid-turn included: the Mayor
  // reads the choice when its next turn starts and a dispatch when its next
  // build starts, so what is running finishes on the model it started with.
  router.patch('/api/agent-sessions/:id/agent', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    try {
      const existing = id ? await agentSessions.getAgentSession(pool, { userId: req.user.id, id }) : null;
      if (!existing) return res.status(404).json({ error: 'Agent session not found' });
      if (existing.status !== 'open') return res.status(409).json({ error: 'This agent session is archived.' });
      const agent = await resolveChoice(req.user, req.body || null);
      const session = await agentSessions.setAgentChoice(pool, { userId: req.user.id, id, agent });
      if (!session) return res.status(409).json({ error: 'This agent session is archived.' });
      rememberChoice(req.user.id, agent);
      return res.json({ session });
    } catch (err) {
      return sendError(res, err, 'Choose agent session model');
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

  // ── The Mayor (#2779 step 3b) ─────────────────────────────────────────

  // ── Attachments (#2779 follow-up) ───────────────────────────────────
  //
  // The dev chat's (routes/sessions.js, #450), on the conversation: the
  // client uploads each file's raw bytes here before sending, gets an id
  // back, and names the ids on the turn, which links them to the message.
  // The same validation (magic bytes, per-kind caps), the same rate limit,
  // the same 50 MB cap per conversation; the rows live in
  // chat_session_attachments with agent_session_id set, so the 24h orphan
  // sweep, account deletion and the coding agent's download path apply.
  router.post(
    '/api/agent-sessions/:id/attachments',
    requireUser,
    attachmentUploadLimiter,
    // Above the largest single-file cap (20 MB zips).
    express.raw({ type: 'application/octet-stream', limit: '21mb' }),
    async (req, res) => {
      const id = positiveId(req.params.id);
      try {
        const { rows: owned } = id
          ? await pool.query(
            `SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2 AND status = 'open'`,
            [id, req.user.id]
          )
          : { rows: [] };
        if (!owned.length) return res.status(404).json({ error: 'Agent session not found' });

        const filename = String(req.query.filename || '').trim();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = attachmentsSvc.validateUpload({ filename, data });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        const { rows: sum } = await pool.query(
          `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
             FROM chat_session_attachments WHERE agent_session_id = $1`,
          [id]
        );
        if (Number(sum[0].total) + data.length > attachmentsSvc.MAX_SESSION_BYTES) {
          return res.status(400).json({
            error: `This conversation's attachment storage is full (${Math.round(attachmentsSvc.MAX_SESSION_BYTES / 1024 / 1024)} MB max)`,
          });
        }

        const attId = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO chat_session_attachments
             (id, session_id, agent_session_id, user_id, kind, filename, content_type, size_bytes, meta, data)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [attId, id, req.user.id, verdict.kind, filename, verdict.contentType, data.length,
            verdict.meta ? JSON.stringify(verdict.meta) : null, data]
        );
        return res.json({
          id: attId, kind: verdict.kind, filename,
          contentType: verdict.contentType, sizeBytes: data.length, meta: verdict.meta || null,
        });
      } catch (err) {
        log.error('agent-sessions', 'Attachment upload failed', { agentSessionId: id, err: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // The bytes, to the conversation's owner only. Images render inline,
  // everything else downloads; nosniff either way (the dev chat's rule).
  router.get('/api/agent-sessions/:id/attachments/:attId', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    const attId = String(req.params.attId || '');
    if (!id || !/^[a-f0-9]{32}$/.test(attId)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        `SELECT att.kind, att.filename, att.content_type, att.data
           FROM chat_session_attachments att
           JOIN agent_sessions s ON s.id = att.agent_session_id
          WHERE att.id = $1 AND att.agent_session_id = $2 AND s.user_id = $3`,
        [attId, id, req.user.id]
      );
      if (!rows.length) return res.status(404).end();
      const att = rows[0];
      res.set('Content-Type', att.content_type || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', attachmentsSvc.attachmentDisposition(att.kind === 'image' ? 'inline' : 'attachment', att.filename));
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.send(att.data);
    } catch (err) {
      log.error('agent-sessions', 'Attachment serve failed', { attId, err: err.message });
      return res.status(500).end();
    }
  });

  // POST /api/agent-sessions/:id/turns { message, model? } — one Mayor turn,
  // streamed as server-sent events. One turn at a time per conversation: a
  // second one answers 409 while the first holds the lease. Everything that
  // can refuse the turn (the lease, the payer, the model) is decided before
  // the stream opens, so a refusal is an ordinary JSON answer.
  router.post('/api/agent-sessions/:id/turns', requireUser, chatLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    const body = req.body || {};
    const unknown = Object.keys(body).filter((key) => !['message', 'model', 'attachmentIds'].includes(key));
    if (unknown.length) return res.status(400).json({ error: `Unsupported field: ${unknown[0]}` });
    const attachmentIds = attachmentsSvc.sanitizeAttachmentIds(body.attachmentIds);
    if (attachmentIds === null) {
      return res.status(400).json({ error: `attachmentIds must be up to ${attachmentsSvc.MAX_PER_MESSAGE} attachment ids` });
    }
    // Files alone are a message, as in the dev chat.
    const typed = typeof body.message === 'string' ? body.message.trim() : '';
    const message = typed || (attachmentIds.length ? attachmentsSvc.ATTACHMENTS_ONLY_TEXT : '');
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` });
    }
    const turnId = agentTurn.newTurnId();
    try {
      const session = id ? await agentSessions.getAgentSession(pool, { userId: req.user.id, id }) : null;
      if (!session) return res.status(404).json({ error: 'Agent session not found' });
      if (session.status !== 'open') return res.status(409).json({ error: 'This agent session is archived.' });
      // Every id must be this user's own upload to this conversation, not
      // yet sent. Checked before the stream opens, so a refusal is a plain
      // 400 and nothing is recorded.
      let attachments = [];
      if (attachmentIds.length) {
        const { rows } = await pool.query(
          `SELECT id, kind, filename, content_type, size_bytes, meta
             FROM chat_session_attachments
            WHERE id = ANY($1) AND agent_session_id = $2 AND user_id = $3 AND message_id IS NULL`,
          [attachmentIds, id, req.user.id]
        );
        if (rows.length !== attachmentIds.length) {
          return res.status(400).json({ error: 'One or more attachments are missing or already sent. Attach them again.' });
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        attachments = attachmentIds.map((attId) => {
          const row = byId.get(attId);
          return {
            id: row.id, kind: row.kind, filename: row.filename, contentType: row.content_type,
            sizeBytes: row.size_bytes, ...(row.meta ? { meta: row.meta } : {}),
          };
        });
      }
      const leased = await agentSessions.acquireTurnLease(pool, { agentSessionId: id, userId: req.user.id, turnId });
      if (!leased) {
        return res.status(409).json({ error: 'The Mayor is already answering in this conversation.', busy: true });
      }
      let mayor;
      try {
        mayor = await agentTurn.resolveAgentMayor({
          pool, config, userId: req.user.id, agentSessionId: id, requestedModel: body.model,
        });
      } catch (err) {
        await agentSessions.releaseTurnLease(pool, { agentSessionId: id, turnId }).catch(() => {});
        throw err;
      }
      if (!mayor.ok) {
        await agentSessions.releaseTurnLease(pool, { agentSessionId: id, turnId }).catch(() => {});
        return res.status(mayor.status).json({
          error: mayor.error,
          code: mayor.code,
          ...(mayor.reason ? { reason: mayor.reason } : {}),
          ...(mayor.verificationRequired ? { verificationRequired: true } : {}),
        });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      await agentTurn.runAgentTurn({
        pool, config, user: req.user, agentSessionId: id, turnId, messageText: message, attachments, mayor, res,
        scheduleInteractiveRecovery,
      });
      return undefined;
    } catch (err) {
      if (res.headersSent) {
        log.error('agent-sessions', 'Agent turn crashed after the stream opened', { message: err.message });
        try { res.end(); } catch { /* already closed */ }
        return undefined;
      }
      return sendError(res, err, 'Agent turn');
    }
  });

  // GET /api/agent-sessions/:id/events — resume a turn's stream. Replays what
  // the conversation's bus still holds after Last-Event-Id, then follows it.
  router.get('/api/agent-sessions/:id/events', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    try {
      const { rows } = id
        ? await pool.query('SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2', [id, req.user.id])
        : { rows: [] };
      if (!rows.length) return res.status(404).end();
    } catch {
      return res.status(500).end();
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try { res.write(':ok\n\n'); } catch { /* client gone */ }
    const sinceSeq = req.headers['last-event-id'] || req.query.since || null;
    const sessionBus = require('../services/session-bus');
    const unsubscribe = sessionBus.subscribe(agentTurn.busKey(id), (event) => {
      try {
        res.write(`id: ${event._seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch { /* client gone */ }
    }, sinceSeq);
    const heartbeat = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch { /* client gone */ }
    }, 15000);
    const close = () => {
      clearInterval(heartbeat);
      try { unsubscribe(); } catch { /* already gone */ }
    };
    req.on('close', close);
    req.on('error', close);
    return undefined;
  });

  router.post('/api/agent-sessions/:id/stop', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    try {
      const { rows } = id
        ? await pool.query('SELECT active_turn FROM agent_sessions WHERE id = $1 AND user_id = $2', [id, req.user.id])
        : { rows: [] };
      if (!rows.length) return res.status(404).json({ error: 'Agent session not found' });
      // During a dispatch the answer names the change: its own stop route
      // (POST /api/sessions/:changeId/stop) confirms the kill and escalates.
      const answer = agentTurn.stopAgentTurn(id, { by: req.user.username });
      if (answer.reason === 'no_active_turn' && rows[0].active_turn) {
        answer.released = await agentTurn.handBackOrphanedTurn({ pool, agentSessionId: id, userId: req.user.id });
      }
      return res.json({ ok: true, ...answer });
    } catch (err) {
      return sendError(res, err, 'Stop agent turn');
    }
  });

  // POST /api/agent-sessions/:id/active-change { changeId } — the changes
  // drawer's "Switch to". The same move as the Mayor's switch_active_change
  // (parks the current change, appends a change_switched note), without
  // spending a model call on a button press.
  router.post('/api/agent-sessions/:id/active-change', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Agent session not found' });
    try {
      await agentSessions.switchActiveChange(pool, {
        agentSessionId: id, userId: req.user.id, changeId: (req.body || {}).changeId,
      });
      const session = await agentSessions.getAgentSession(pool, { userId: req.user.id, id });
      return res.json({ session });
    } catch (err) {
      return sendError(res, err, 'Switch active change');
    }
  });

  // The confirmation cards: their state, and the owner's decision.
  router.get('/api/agent-sessions/:id/actions', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    try {
      const { rows } = id
        ? await pool.query('SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2', [id, req.user.id])
        : { rows: [] };
      if (!rows.length) return res.status(404).json({ error: 'Agent session not found' });
      const list = await actions.listActions(pool, { userId: req.user.id, agentSessionId: id, limit: req.query.limit });
      return res.json({ actions: list });
    } catch (err) {
      return sendError(res, err, 'List agent session actions');
    }
  });

  router.post('/api/agent-sessions/:id/actions/:actionId/confirm', requireUser, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Agent session not found' });
    try {
      const outcome = await actions.confirmAction(pool, {
        config, user: req.user, agentSessionId: id, actionId: req.params.actionId,
      });
      const followUp = await startFollowUp({ user: req.user, agentSessionId: id, outcome }).catch((err) => {
        log.warn('agent-sessions', 'Follow-up turn did not start', { agentSessionId: id, err: err.message });
        return null;
      });
      return res.json({ ...outcome, followUp });
    } catch (err) {
      return sendError(res, err, 'Confirm agent session action');
    }
  });

  router.post('/api/agent-sessions/:id/actions/:actionId/dismiss', requireUser, async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Agent session not found' });
    try {
      const dismissed = await actions.dismissAction(pool, {
        user: req.user, agentSessionId: id, actionId: req.params.actionId,
      });
      if (!dismissed) return res.status(404).json({ error: 'No pending confirmation with that id' });
      return res.json({ ok: true });
    } catch (err) {
      return sendError(res, err, 'Dismiss agent session action');
    }
  });

  return router;
}

module.exports = { agentSessionRoutes };
