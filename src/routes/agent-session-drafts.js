'use strict';

// An agent session's saved drafts (#2779 follow-up): the dev chat's #798 /
// #940 list, carried over to the conversation with the Mayor.
//
// While a turn runs the composer's button is Save: what the owner types next
// is parked here, and sent later by a tap, never on its own. The contract is
// the dev chat's (routes/chat-drafts.js), whose constants and helpers this
// reuses, so the two lists cannot drift apart:
//
//   GET    /api/agent-sessions/:id/drafts            → { drafts: [...], max }
//   POST   /api/agent-sessions/:id/drafts            body { id?, text, savedAt? }
//   DELETE /api/agent-sessions/:id/drafts/:draftId
//
// - OWNERSHIP IS THE ONLY GATE, and a miss is a flat 404: someone else's
//   conversation is indistinguishable from none. No status rule: an archived
//   conversation's drafts stay readable and deletable.
// - Every write answers with the AUTHORITATIVE list, oldest first.
// - POST is idempotent on (conversation, draft id), and re-sending a stored
//   draft never trips the cap. DELETE is idempotent too.
// - The owner's other tabs and devices hear `agent_session_drafts_changed`
//   over the per-user socket (every pod) and re-read.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { draftWriteLimiter } = require('../middleware/rate-limits');
const {
  MAX_DRAFTS,
  MAX_DRAFT_CHARS,
  DRAFT_ID_RE,
  CAP_MESSAGE,
  clampSavedAt,
} = require('./chat-drafts');

function newDraftId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function toWire(rows) {
  return rows.map((r) => ({ id: r.draft_id, text: r.content, savedAt: r.saved_at }));
}

async function listAgentDrafts(pool, agentSessionId) {
  const { rows } = await pool.query(
    `SELECT draft_id, content, saved_at
       FROM agent_session_drafts
      WHERE agent_session_id = $1
      ORDER BY saved_at ASC, draft_id ASC`,
    [agentSessionId]
  );
  return toWire(rows);
}

async function ownsConversation(pool, agentSessionId, userId) {
  const { rows } = await pool.query(
    'SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2',
    [agentSessionId, userId]
  );
  return rows.length > 0;
}

function pushDraftsChanged(userId, agentSessionId) {
  try {
    require('../services/ws').pushToUser(userId, { type: 'agent_session_drafts_changed', agentSessionId });
  } catch (err) {
    log.warn('agent-session-drafts', 'drafts_changed push failed', { message: err.message });
  }
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function agentSessionDraftsRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/agent-sessions/:id/drafts', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad session id' });
    try {
      if (!await ownsConversation(pool, id, req.user.id)) return res.status(404).json({ error: 'Session not found' });
      res.json({ drafts: await listAgentDrafts(pool, id), max: MAX_DRAFTS });
    } catch (err) {
      log.error('agent-session-drafts', 'List failed', { agentSessionId: id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/agent-sessions/:id/drafts', draftWriteLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad session id' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Draft text required' });
    if (text.length > MAX_DRAFT_CHARS) {
      return res.status(400).json({ error: `A draft can be at most ${MAX_DRAFT_CHARS} characters` });
    }
    let draftId = newDraftId();
    if (req.body?.id != null) {
      const candidate = String(req.body.id);
      if (!DRAFT_ID_RE.test(candidate)) return res.status(400).json({ error: 'Bad draft id' });
      draftId = candidate;
    }
    const savedAt = clampSavedAt(req.body?.savedAt);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The conversation row is the lock, so two devices saving at once
      // cannot both squeeze under the cap.
      const { rows: owned } = await client.query(
        'SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, req.user.id]
      );
      if (!owned.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Session not found' });
      }
      const { rows: counts } = await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE draft_id = $2)::int AS mine
           FROM agent_session_drafts
          WHERE agent_session_id = $1`,
        [id, draftId]
      );
      if (!counts[0].mine && counts[0].total >= MAX_DRAFTS) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: CAP_MESSAGE, code: 'draft_cap' });
      }
      await client.query(
        `INSERT INTO agent_session_drafts (agent_session_id, user_id, draft_id, content, saved_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
         ON CONFLICT (agent_session_id, draft_id) DO NOTHING`,
        [id, req.user.id, draftId, text, savedAt]
      );
      await client.query('COMMIT');
      const drafts = await listAgentDrafts(pool, id);
      pushDraftsChanged(req.user.id, id);
      res.json({ ok: true, id: draftId, drafts, max: MAX_DRAFTS });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
      log.error('agent-session-drafts', 'Save failed', { agentSessionId: id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  router.delete('/api/agent-sessions/:id/drafts/:draftId', draftWriteLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad session id' });
    const draftId = String(req.params.draftId || '');
    if (!DRAFT_ID_RE.test(draftId)) return res.status(400).json({ error: 'Bad draft id' });
    try {
      if (!await ownsConversation(pool, id, req.user.id)) return res.status(404).json({ error: 'Session not found' });
      const { rowCount } = await pool.query(
        'DELETE FROM agent_session_drafts WHERE agent_session_id = $1 AND draft_id = $2',
        [id, draftId]
      );
      const drafts = await listAgentDrafts(pool, id);
      if (rowCount) pushDraftsChanged(req.user.id, id);
      res.json({ ok: true, drafts, max: MAX_DRAFTS });
    } catch (err) {
      log.error('agent-session-drafts', 'Delete failed', { agentSessionId: id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { agentSessionDraftsRoutes, listAgentDrafts };
