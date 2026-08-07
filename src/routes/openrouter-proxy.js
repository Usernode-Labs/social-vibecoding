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
const crypto = require('crypto');

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
        `SELECT user_id, agent_backend, status, agent_config_version FROM chat_sessions WHERE id = $1`,
        [c.sessionId],
      );
      const sess = sessRows[0];
      if (!sess) return res.status(404).json({ error: { message: 'session not found' } });
      if (sess.user_id !== c.userId) return res.status(403).json({ error: { message: 'session/user mismatch' } });
      if (sess.agent_backend !== 'codex_openrouter') return res.status(403).json({ error: { message: 'backend mismatch' } });
      if (sess.status === 'archived' || sess.status === 'merged') return res.status(409).json({ error: { message: 'session is closed' } });
      // Honor context resets (review P3): compare the token's version
      // against the LIVE session version — reset-agent-context bumps
      // agent_config_version, so a stale pre-reset token must be refused.
      // The immutable turn snapshot alone is not enough (it never changes
      // after creation).
      if (c.agentConfigVersion != null && sess.agent_config_version !== c.agentConfigVersion) {
        return res.status(409).json({ error: { message: 'agent config version mismatch (context was reset)' } });
      }

      const meta = await credentialStore.readMetadata({
        pool, userId: c.userId, provider: 'openrouter', purpose: 'coding_agent',
      });
      if (!meta || meta.status !== 'valid') return res.status(401).json({ error: { message: 'credential not valid' } });
      // The revision + secret are now read ATOMICALLY inside readSecret via
      // expectedRevision (review P2): a revision-N token cannot race a key
      // replacement and receive revision N+1's key. The separate
      // readMetadata-then-readSecret gap is gone.
      // Verify the claimed turnId against a LIVE ledger row (review F9):
      // the relay must not accept a token for a turn that doesn't exist,
      // already completed, or belongs to a different session/user.
      const { rows: turnRows } = await pool.query(
        `SELECT id, status, agent_config_version FROM agent_turns
         WHERE id = $1 AND session_id = $2 AND user_id = $3`,
        [c.turnId, c.sessionId, c.userId],
      );
      const turn = turnRows[0];
      if (!turn) return res.status(404).json({ error: { message: 'turn not found' } });
      if (turn.status === 'completed' || turn.status === 'failed') {
        return res.status(409).json({ error: { message: 'turn already finished' } });
      }
      userKey = await credentialStore.readSecret({
        pool, userId: c.userId, provider: 'openrouter', purpose: 'coding_agent',
        dataKey: config.dataEncryptionKey,
        expectedRevision: c.credentialRevision,
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

      // ── Cost ceiling resolution + entry check (review P4) ──────────
      const turnId = c.turnId;
      // Effective cap = MIN(global operator cap, user preference cap).
      // A positive global cap must not bypass a lower user cap.
      let effectiveMaxCost = config.openrouterMaxTurnCostUsd || 0;
      const { rows: prefRows } = await pool.query(
        `SELECT max_turn_cost_usd FROM user_agent_preferences
         WHERE user_id = $1 AND backend = 'codex_openrouter'`,
        [c.userId],
      );
      const userCap = parseFloat(prefRows[0]?.max_turn_cost_usd || '0') || 0;
      if (userCap > 0 && (effectiveMaxCost === 0 || userCap < effectiveMaxCost)) {
        effectiveMaxCost = userCap;
      }
      // Entry check: reject a NEW upstream call once the turn has already
      // reached the ceiling, before we spend anything. Uses PER-REQUEST
      // reservation records (review P1): each admitted request gets its
      // own agent_api_calls row with a reserved_cost_usd, and the turn's
      // reserved_cost_usd total is the SUM of active reservations. This
      // lets concurrent requests each reserve independently, and lets one
      // request's settlement release only ITS reservation (not wipe the
      // others'). We serialize admission with FOR UPDATE on the turn.
      let reservationId = null;
      if (effectiveMaxCost > 0) {
        {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows: costRows } = await client.query(
            'SELECT actual_cost_usd FROM agent_turns WHERE id = $1 FOR UPDATE', [turnId],
          );
          const spent = parseFloat(costRows[0]?.actual_cost_usd || 0);
          // sum of currently-active per-request reservations
          const { rows: resRows } = await client.query(
            'SELECT COALESCE(SUM(reserved_cost_usd),0) s FROM agent_api_calls WHERE turn_id = $1 AND status = \'reserved\'',
            [turnId],
          );
          const reserved = parseFloat(resRows[0]?.s || 0);
          // Conservative reservation that accounts for request size (review
          // P1d): estimate input tokens from the actual payload bytes (~4
          // chars/token) plus output budget, at conservative per-token rates
          // ($2/M in, $6/M out). Even when the exact model price is unknown,
          // the reservation scales with how much we're sending. Stored per
          // request; settlement reconciles THIS request's reservation only.
          const inputChars = Buffer.byteLength(JSON.stringify(body || {}), 'utf8');
          const estInput = Math.ceil(inputChars / 4) + 5000;
          const estOutput = body.max_output_tokens || 128000;
          const reserve = (estInput * 2 / 1000000) + (estOutput * 6 / 1000000) + 0.10;
          if (spent + reserved + reserve >= effectiveMaxCost) {
            await client.query('ROLLBACK').catch(() => {});
            log.warn('openrouter-proxy', 'turn cost ceiling would be exceeded', { turnId, effectiveMaxCost, spent, reserved });
            return res.status(429).json({ error: { message: 'turn cost ceiling reached' } });
          }
          // Create a per-request reservation row (status=reserved). Its
          // uuid is later used by settle to release exactly this request.
          reservationId = crypto.randomUUID();
          await client.query(
            `INSERT INTO agent_api_calls
               (id, turn_id, requested_model, reserved_cost_usd, status)
             VALUES ($1, $2, $3, $4, 'reserved')
             ON CONFLICT (turn_id, upstream_request_id) DO NOTHING`,
            [reservationId, turnId, c.model, reserve],
          );
          // Recompute turn-level reserved total from active reservations.
          const { rows: totRows } = await client.query(
            'SELECT COALESCE(SUM(reserved_cost_usd),0) s FROM agent_api_calls WHERE turn_id = $1 AND status = \'reserved\'',
            [turnId],
          );
          await client.query(
            'UPDATE agent_turns SET reserved_cost_usd = $2 WHERE id = $1',
            [turnId, parseFloat(totRows[0]?.s || 0)],
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        }
      }

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

      // settle is declared here (before the non-streaming branch) so BOTH
      // the non-streaming and streaming paths can use it (review P7).
      const settle = async (u) => {
        if (!u || !u.requestId) return;
        try {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            // Unified, idempotent settlement (review P1):
            //  - Uncapped (no reservationId): insert the call row and, ONLY
            //    on first insert (rowCount===1), add its tokens/cost to the
            //    turn totals (previously turned totals were never updated).
            //  - Capped: fill the reserved row, release its reservation, mark
            //    completed, and add tokens/cost to turn totals — guarded by
            //    `status='reserved'` (RETURNING rowCount) so a replayed
            //    terminal event is a no-op (idempotent).
            //  - Cost absent: charge the reservation as the authoritative
            //    cost so the call COMPLETES (not left reserved forever) and
            //    the cap still accounts for its estimated spend.
            let applied = false;
            let costToCharge = 0;
            if (reservationId) {
              const { rows: resRows } = await client.query(
                'SELECT reserved_cost_usd FROM agent_api_calls WHERE id = $1 FOR UPDATE', [reservationId],
              );
              const reserved = parseFloat(resRows[0]?.reserved_cost_usd || 0);
              costToCharge = (u.cost != null) ? u.cost : reserved;
              const upd = await client.query(
                `UPDATE agent_api_calls SET
                   upstream_request_id = $2,
                   routed_model = $3,
                   routed_provider = $4,
                   input_tokens = $5,
                   output_tokens = $6,
                   actual_cost_usd = $7,
                   reserved_cost_usd = 0,
                   status = 'completed',
                   completed_at = NOW()
                 WHERE id = $1 AND status = 'reserved'
                 RETURNING id`,
                [reservationId, u.requestId, u.model, u.routedProvider,
                 u.inputTokens, u.outputTokens, costToCharge],
              );
              applied = upd.rowCount === 1;
            } else {
              const ins = await client.query(
                `INSERT INTO agent_api_calls
                   (id, turn_id, upstream_request_id, requested_model, routed_model,
                    routed_provider, input_tokens, output_tokens, actual_cost_usd, status)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'completed')
                 ON CONFLICT (turn_id, upstream_request_id) DO NOTHING`,
                [turnId, u.requestId, c.model, u.model, u.routedProvider,
                 u.inputTokens, u.outputTokens, u.cost || 0],
              );
              applied = ins.rowCount === 1;
              costToCharge = u.cost || 0;
            }
            // Add this call's spend to the turn totals exactly once.
            if (applied) {
              await client.query(
                `UPDATE agent_turns SET
                   routed_model = COALESCE($2, routed_model),
                   routed_provider = COALESCE($3, routed_provider),
                   input_tokens = input_tokens + $4,
                   cached_input_tokens = cached_input_tokens + $5,
                   output_tokens = output_tokens + $6,
                   reasoning_output_tokens = reasoning_output_tokens + $7,
                   actual_cost_usd = actual_cost_usd + $8,
                   cost_source = 'openrouter_usage',
                   billed_by = 'user_openrouter'
                 WHERE id = $1`,
                [turnId, u.model, u.routedProvider, u.inputTokens,
                 u.cachedInputTokens, u.outputTokens, u.reasoningOutputTokens, costToCharge],
              );
            }
            // Reconcile turn-level reserved total = SUM of still-active
            // reservations (review P1): releasing this request must NOT
            // erase the reservations of other in-flight requests.
            const { rows: totRows } = await client.query(
              "SELECT COALESCE(SUM(reserved_cost_usd),0) s FROM agent_api_calls WHERE turn_id = $1 AND status = 'reserved'",
              [turnId],
            );
            await client.query(
              'UPDATE agent_turns SET reserved_cost_usd = $2 WHERE id = $1',
              [turnId, parseFloat(totRows[0]?.s || 0)],
            );
            await client.query('COMMIT');
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
          } finally {
            client.release();
          }
          if (effectiveMaxCost > 0) {
            const { rows: costRows } = await pool.query(
              'SELECT actual_cost_usd, reserved_cost_usd FROM agent_turns WHERE id = $1', [turnId]
            );
            if ((parseFloat(costRows[0]?.actual_cost_usd || 0) + parseFloat(costRows[0]?.reserved_cost_usd || 0)) >= effectiveMaxCost) {
              log.warn('openrouter-proxy', 'turn cost ceiling exceeded', { turnId, effectiveMaxCost });
              ctrl.abort();
            }
          }
        } catch (err) {
          log.error('openrouter-proxy', 'usage settlement failed; aborting', { turnId, err: err.message });
          ctrl.abort();
          throw err;
        }
      };

      if (!stream || !upstream.ok || !upstream.body) {
        const text = await upstream.text();
      // Non-streaming response (review F8): parse the JSON body for
        // usage and settle it — never skip settlement just because the
        // client didn't request streaming.
        if (upstream.ok) {
          // Fail closed (review P2): if settlement throws (accounting
          // failure), propagate and return an error rather than silently
          // delivering a response whose cost was never recorded.
          const body = JSON.parse(text);
          const u = extractUsage(body.type || 'response.completed', body);
          if (u) await settle(u);
        }
        return res.send(text);
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Transparent passthrough + incremental SSE parser for settlement.
      let buf = '';
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
          buf += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            const u = extractUsage(ev.event, ev.data);
            if (u) await settle(u);
          }
        }
        buf += decoder.decode();
        // Best-effort final settle from any trailing buffered frame.
        if (buf.trim()) {
          const parsed = parseSseFrames(buf + '\n\n');
          for (const ev of parsed.events) { const u = extractUsage(ev.event, ev.data); if (u) await settle(u); }
        }
     } catch (err) {
       if (err.name !== 'AbortError') log.warn('openrouter-proxy', 'stream error', { turnId, err: err.message });
     } finally {
       // Do NOT complete the turn here (review P5): a single Responses
       // stream is ONE request in a tool loop — Codex makes many within
       // one logical turn. Marking the turn completed on the first stream
       // would 409 the next tool-loop request. Completion is owned by the
       // worker dispatch lifecycle, which closes the ledger row when the
       // runner finishes.
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
