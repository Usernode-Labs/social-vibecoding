'use strict';

// OpenRouter Responses relay (plan.md §8). The Codex worker points Codex
// at this base URL (http://<platform-internal>/api/internal/openrouter/v1)
// and appends /responses. The relay:
//   1. Authenticates a per-turn scoped bearer token (agent-proxy-auth).
//   2. Re-checks the token's claims against live DB state (session owns
//      the user, backend is codex_openrouter, the active turn matches,
//      the credential is still valid and its revision matches).
//   3. Decrypts the user's OpenRouter key, overwrites the request model
//      with the session-pinned model, rejects background/plural models,
//      clamps max_output_tokens, and forwards ONLY to /responses.
//   4. Transparently streams the OpenRouter SSE back to Codex while
//      parsing a copy to settle usage/cost idempotently.
//
// The raw OpenRouter key never enters the worker container, filesystem,
// args, journal, or logs.

const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { agentProxyAuth } = require('../middleware/agent-proxy-auth');
const credentialStore = require('../services/credential-store');
const openrouterClient = require('../services/openrouter-client');
const { parseSseFrames, extractUsage } = require('../services/openrouter-usage');

function openrouterProxyRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const UPSTREAM = (config.openrouterApiBase || openrouterClient.OPENROUTER_API_BASE).replace(/\/$/, '');
  const RELAY_PATH = '/api/internal/openrouter/v1';

  // Route-specific large-body parser (coding-agent requests carry MBs of
  // repo context). Bypass the global small JSON parser in server.js.
  router.use(RELAY_PATH, express.json({ limit: '32mb' }));

  // Only /responses is permitted — no account-management endpoints.
  router.post(`${RELAY_PATH}/responses`, agentProxyAuth, async (req, res) => {
    if (!config.openrouterProxyEnabled) {
      return res.status(503).json({ error: { message: 'OpenRouter relay is not enabled.' } });
    }
    const c = req.agentProxy;
    let userKey;
    try {
      // ── Re-check claims against live DB state ──────────────────────
      const { rows: sessRows } = await pool.query(
        `SELECT user_id, agent_backend, status FROM chat_sessions WHERE id = $1`,
        [c.sessionId],
      );
      const sess = sessRows[0];
      if (!sess) return res.status(404).json({ error: { message: 'session not found' } });
      if (sess.user_id !== c.userId) return res.status(403).json({ error: { message: 'session/user mismatch' } });
      if (sess.agent_backend !== 'codex_openrouter') return res.status(403).json({ error: { message: 'backend mismatch' } });
      if (sess.status === 'archived' || sess.status === 'merged') return res.status(409).json({ error: { message: 'session is closed' } });

      const meta = await credentialStore.readMetadata({
        pool, userId: c.userId, provider: 'openrouter', purpose: 'coding_agent',
      });
      if (!meta || meta.status !== 'valid') return res.status(401).json({ error: { message: 'credential not valid' } });
      if (c.credentialRevision != null && meta.revision !== c.credentialRevision) {
        return res.status(401).json({ error: { message: 'credential revision mismatch (key replaced or revoked)' } });
      }
      userKey = await credentialStore.readSecret({
        pool, userId: c.userId, provider: 'openrouter', purpose: 'coding_agent',
        dataKey: config.dataEncryptionKey,
      });
      if (!userKey) return res.status(401).json({ error: { message: 'credential unavailable' } });

      // ── Enforce / sanitize the request body ────────────────────────
      const body = req.body || {};
      body.model = c.model;                 // model fixed by the relay
      delete body.models;                   // reject plural fallback list
      if (body.background === true) return res.status(400).json({ error: { message: 'background mode not permitted' } });
      // Clamp max_output_tokens to a sane ceiling.
      const MAX_OUT = 128000;
      if (typeof body.max_output_tokens === 'number' && body.max_output_tokens > MAX_OUT) {
        body.max_output_tokens = MAX_OUT;
      }
      const stream = body.stream !== false;

      // ── Forward to OpenRouter ──────────────────────────────────────
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userKey}`,
        'X-OpenRouter-Metadata': 'enabled',
        ...openrouterClient.platformHeaders(config.openrouterOrigin),
      };
      const ctrl = new AbortController();
      req.on('close', () => ctrl.abort());
      const upstream = await fetch(`${UPSTREAM}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);

      if (!stream || !upstream.ok || !upstream.body) {
        const text = await upstream.text();
        return res.send(text);
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Transparent passthrough + incremental SSE parser for settlement.
      let buf = '';
      let settled = false;
      const reader = upstream.body.getReader();
      const turnId = c.turnId;
      const settle = async (u) => {
        if (settled || !u || !u.requestId) return;
        settled = true;
        try {
          await pool.query(
            `INSERT INTO agent_api_calls
               (id, turn_id, upstream_request_id, requested_model, routed_model,
                routed_provider, input_tokens, output_tokens, actual_cost_usd, status)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'completed')
             ON CONFLICT (turn_id, upstream_request_id) DO NOTHING`,
            [turnId, u.requestId, c.model, u.model, u.routedProvider,
             u.inputTokens, u.outputTokens, u.cost || 0],
          );
          await pool.query(
            `UPDATE agent_turns SET
               routed_model = COALESCE($2, routed_model),
               routed_provider = COALESCE($3, routed_provider),
               input_tokens = $4, cached_input_tokens = $5,
               output_tokens = $6, reasoning_output_tokens = $7,
               actual_cost_usd = $8, cost_source = 'openrouter_usage',
               billed_by = 'user_openrouter', status = 'completed',
               completed_at = NOW()
             WHERE id = $1`,
            [turnId, u.model, u.routedProvider, u.inputTokens,
             u.cachedInputTokens, u.outputTokens, u.reasoningOutputTokens, u.cost || 0],
          );
        } catch (err) {
          log.warn('openrouter-proxy', 'usage settlement failed', { turnId, err: err.message });
        }
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value).toString('utf8');
          res.write(chunk);
          buf += chunk;
          const parsed = parseSseFrames(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            const u = extractUsage(ev.event, ev.data);
            if (u) settle(u);
          }
        }
        // Best-effort final settle from any trailing buffered frame.
        if (buf.trim()) {
          const parsed = parseSseFrames(buf + '\n\n');
          for (const ev of parsed.events) { const u = extractUsage(ev.event, ev.data); if (u) settle(u); }
        }
      } catch (err) {
        if (err.name !== 'AbortError') log.warn('openrouter-proxy', 'stream error', { turnId, err: err.message });
      } finally {
        try { res.end(); } catch {}
      }
    } catch (err) {
      log.error('openrouter-proxy', 'relay failure', { turnId: c?.turnId, err: err.message });
      if (!res.headersSent) res.status(500).json({ error: { message: 'relay failure' } });
      else try { res.end(); } catch {}
    }
  });

  // Reject any other OpenRouter path — the worker only needs /responses.
  router.all(`${RELAY_PATH}/*`, agentProxyAuth, (req, res) => {
    res.status(404).json({ error: { message: 'unsupported endpoint' } });
  });

  return router;
}

module.exports = { openrouterProxyRoutes };
