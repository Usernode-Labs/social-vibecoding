'use strict';

// #940: saved dev-chat drafts, persisted per ACCOUNT instead of per browser.
//
// The composer's save icon parks typed text as a draft while a turn runs
// (#798, #810). Until this landed those drafts lived only in the
// localStorage of the browser that typed them — invisible on a second
// device, and silently lost by clearing site data. These endpoints are the
// write side of `chat_session_drafts` (see schema.sql for the shape and for
// why the table is staging:private).
//
// Surface (all owner-scoped, all under the global /api/* auth gate):
//
//   GET    /api/sessions/:id/drafts            → { drafts: [...], max }
//   POST   /api/sessions/:id/drafts            body { id?, text, savedAt? }
//   DELETE /api/sessions/:id/drafts/:draftId
//
// Every mutation returns the AUTHORITATIVE list, so a client converges on
// every write without a follow-up GET.
//
// DELIBERATELY NO full-replace PUT. A last-write-wins replace lets a stale
// device resurrect a draft another device just sent; per-row insert/delete
// has no lost-update window, which is exactly what matters once two devices
// are in play. DELETE is idempotent (deleting an already-gone row is a 200)
// so a client can safely replay tombstones it accumulated while offline.
//
// Ownership is the ONLY gate — no status restriction. Drafts must stay
// readable and deletable on a paused or archived session, exactly as the
// localStorage list was. A session the caller doesn't own is a flat 404,
// never a 403: don't confirm that someone else's session id exists.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { draftWriteLimiter } = require('../middleware/rate-limits');

// Kept in step with DevChat.MAX_SAVED_DRAFTS in public/js/dev-chat.js;
// tests/chat-session-drafts-route.test.js pins both.
const MAX_DRAFTS = 20;

// Matches the CHECK constraint on chat_session_drafts.content.
const MAX_DRAFT_CHARS = 10000;

// Client-generated ids (DevChat._newDraftId → `d<base36 time><rand>`).
// Strict enough that the value can only ever be an opaque token.
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// How far back a client-supplied savedAt may reach. A device replaying a
// months-old local mirror still gets sensible ordering; a device with a
// broken clock can't pin a draft above everything or into the far future.
const SAVED_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const CAP_MESSAGE = `That's ${MAX_DRAFTS} saved drafts — send or delete one first`;

function newDraftId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Client-supplied savedAt → a Date inside [now - 30d, now], or null to let
// the column default to NOW(). Anything unparseable is simply ignored.
function clampSavedAt(raw) {
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  return new Date(Math.min(Math.max(ms, now - SAVED_AT_MAX_AGE_MS), now));
}

// Wire shape. `text` (not `content`) so the payload matches the client's
// existing draft object and no field renaming is needed on either side.
function toWire(rows) {
  return rows.map((r) => ({
    id: r.draft_id,
    text: r.content,
    savedAt: r.saved_at,
  }));
}

// The one ordering used everywhere: oldest first ("newest last", matching
// the render order), with draft_id as the tiebreak because two devices can
// stamp the same second.
async function listDrafts(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT draft_id, content, saved_at
       FROM chat_session_drafts
      WHERE session_id = $1
      ORDER BY saved_at ASC, draft_id ASC`,
    [sessionId]
  );
  return toWire(rows);
}

// Resolve the session ONLY if the caller owns it. Returns the row or null;
// callers turn null into the flat 404.
async function ownedSession(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT cs.id, cs.user_id
       FROM chat_sessions cs
      WHERE cs.id = $1 AND cs.user_id = $2`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

// Every socket belonging to this user, so a second device with the same
// session open repaints without waiting for its next reconcile. Per-user
// fan-out, never the app-scoped broadcast — drafts are not public data.
// Best-effort: a WS hiccup must never fail the write that already landed.
function pushDraftsChanged(userId, sessionId) {
  try {
    const { pushNotificationToUser } = require('../services/ws');
    pushNotificationToUser(userId, { type: 'session_drafts_changed', sessionId });
  } catch (err) {
    log.warn('chat-drafts', 'drafts_changed push failed', { message: err.message });
  }
}

function chatDraftsRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/sessions/:id/drafts', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(sessionId)) return res.status(400).json({ error: 'Bad session id' });
    try {
      if (!await ownedSession(pool, sessionId, req.user.id)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({ drafts: await listDrafts(pool, sessionId), max: MAX_DRAFTS });
    } catch (err) {
      log.error('chat-drafts', 'List failed', { sessionId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/sessions/:id/drafts', draftWriteLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(sessionId)) return res.status(400).json({ error: 'Bad session id' });

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Draft text required' });
    if (text.length > MAX_DRAFT_CHARS) {
      return res.status(400).json({ error: `A draft can be at most ${MAX_DRAFT_CHARS} characters` });
    }

    // An id supplied by the client is what makes a re-upload idempotent;
    // absent (or malformed) is fine for a first save, but a MALFORMED one
    // is a broken client and gets a 400 rather than a silent replacement.
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
      const { rows: sessionRows } = await client.query(
        `SELECT cs.id FROM chat_sessions cs
          WHERE cs.id = $1 AND cs.user_id = $2
          FOR UPDATE`,
        [sessionId, req.user.id]
      );
      if (!sessionRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Session not found' });
      }

      // Cap check inside the transaction, and only when this id is NOT
      // already stored: re-uploading a draft that is already there must
      // never trip the cap (that is the reconcile flush's normal case).
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE draft_id = $2)::int AS mine
           FROM chat_session_drafts
          WHERE session_id = $1`,
        [sessionId, draftId]
      );
      if (!countRows[0].mine && countRows[0].total >= MAX_DRAFTS) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: CAP_MESSAGE, code: 'draft_cap' });
      }

      await client.query(
        `INSERT INTO chat_session_drafts (session_id, user_id, draft_id, content, saved_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
         ON CONFLICT (session_id, draft_id) DO NOTHING`,
        [sessionId, req.user.id, draftId, text, savedAt]
      );
      await client.query('COMMIT');

      const drafts = await listDrafts(pool, sessionId);
      pushDraftsChanged(req.user.id, sessionId);
      res.json({ ok: true, id: draftId, drafts, max: MAX_DRAFTS });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
      log.error('chat-drafts', 'Save failed', { sessionId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Idempotent by design — an already-gone row is still a 200 with the
  // current list. That is what lets a client replay the tombstones it
  // accumulated while offline without special-casing "already deleted".
  router.delete('/api/sessions/:id/drafts/:draftId', draftWriteLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(sessionId)) return res.status(400).json({ error: 'Bad session id' });
    const draftId = String(req.params.draftId || '');
    if (!DRAFT_ID_RE.test(draftId)) return res.status(400).json({ error: 'Bad draft id' });

    try {
      if (!await ownedSession(pool, sessionId, req.user.id)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const { rowCount } = await pool.query(
        `DELETE FROM chat_session_drafts WHERE session_id = $1 AND draft_id = $2`,
        [sessionId, draftId]
      );
      const drafts = await listDrafts(pool, sessionId);
      if (rowCount) pushDraftsChanged(req.user.id, sessionId);
      res.json({ ok: true, drafts, max: MAX_DRAFTS });
    } catch (err) {
      log.error('chat-drafts', 'Delete failed', { sessionId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  chatDraftsRoutes,
  listDrafts,
  // Exported for tests / reuse by GET /api/sessions/:id.
  MAX_DRAFTS,
  MAX_DRAFT_CHARS,
  DRAFT_ID_RE,
  clampSavedAt,
  CAP_MESSAGE,
};
