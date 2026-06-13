'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { anthropicProxyAuth } = require('../middleware/anthropic-proxy-auth');
const { getPool } = require('../db/pool');
const limits = require('../services/limits');
const anthropicStream = require('../services/anthropic-stream');
const log = require('../services/logger');

// Worker → platform Anthropic-proxy.
//
// Why this exists: the CC worker container runs `claude
// --dangerously-skip-permissions` against user prompts. If the worker
// holds the platform's real ANTHROPIC_API_KEY, any user can ask CC to
// `echo $ANTHROPIC_API_KEY` and exfiltrate the platform-wide key.
//
// Instead, the worker holds only its session-scoped WORKER_JWT (in
// ANTHROPIC_API_KEY env var, picked up by the SDK as x-api-key) and
// points ANTHROPIC_BASE_URL at /api/internal/anthropic on the platform.
// This proxy verifies the JWT, swaps the header for the real key, and
// forwards to api.anthropic.com. Exfiltrated JWTs are useless against
// Anthropic directly and expire with WORKER_JWT_TTL.
//
// The proxy also enforces the daily LLM cap mid-stream:
//   1. Start-of-call gate. Cheap pre-check; if today's recorded spend
//      already meets the cap, return 429 immediately so we don't even
//      open a socket to Anthropic.
//   2. Mid-stream kill. As Anthropic's SSE response flows through, the
//      shared forward loop (services/anthropic-stream.js) tees each
//      chunk into a tiny SSE parser, computes a running cost, and
//      aborts the upstream socket the moment running_total + this
//      call's running cost would cross the user's effective cap. The
//      Anthropic SDK in the `claude` CLI sees the truncated stream as
//      a normal API error and the turn ends. Worst-case overshoot is
//      bounded to "what landed between two `message_delta` events" —
//      typically a few cents.
//
// The stream-forwarding mechanics (SSE tee, header filtering, the
// forward/kill loop) live in src/services/anthropic-stream.js, shared
// with the app-LLM proxy (routes/app-llm-proxy.js, issue #34). What
// stays here is worker-specific: session→user resolution, the user
// budget cache, and the gates.
//
// BYOK turns bypass the proxy entirely (worker.js sets the user's key
// directly in ANTHROPIC_API_KEY and leaves ANTHROPIC_BASE_URL unset),
// so this enforcement only applies to the platform-key code path.

const ROUTE_PREFIX = '/api/internal/anthropic/';

// How long a per-user DB-spend snapshot is considered fresh. The cap
// itself comes from limits.js which has its own internal cache, so
// nothing here gates how often the cap is re-read — only the
// per-user `total_cost_cents` lookup is rate-limited by this TTL. A
// 10s window matches limits.js so admin cap changes propagate at the
// same speed as user-spend updates.
const BUDGET_CACHE_TTL_MS = 10_000;

// chat_sessions never change owners, so a per-process cache for the
// session→user lookup is safe forever. Cleared on process restart.
const sessionUserCache = new Map(); // sessionId -> userId

// Per-user spend tracker. `totalAtCheckpointCents` is the most recent
// `llm_usage.total_cost_cents` we read from the DB; `liveDeltaCents`
// is the sum of finalized Anthropic-call costs we've observed via the
// SSE tee since that checkpoint. On each refresh we re-read the DB
// and reset liveDeltaCents to 0 — once a CC turn ends, sessions.js
// writes the turn's full cost to llm_usage and the next refresh picks
// it up. There is a brief race window (turn-end write vs proxy
// refresh) where new costs aren't accounted for; bounded to
// BUDGET_CACHE_TTL_MS worth of generation, i.e. cents.
const userBudgetCache = new Map();
//   userId -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

async function resolveUserId(pool, sessionId) {
  if (sessionUserCache.has(sessionId)) return sessionUserCache.get(sessionId);
  try {
    const { rows } = await pool.query(
      'SELECT user_id FROM chat_sessions WHERE id = $1',
      [sessionId]
    );
    const userId = rows[0]?.user_id ?? null;
    // Don't cache the null result — the session might land in the DB a
    // moment later (e.g. row creation racing with the first proxy
    // call). Only memoize hits.
    if (userId) sessionUserCache.set(sessionId, userId);
    return userId;
  } catch (err) {
    log.warn('anthropic-proxy', 'Session lookup failed', { sessionId, err: err.message });
    return null;
  }
}

async function refreshUserBudget(pool, userId) {
  const cached = userBudgetCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached;
  try {
    const { rows } = await pool.query(
      'SELECT total_cost_cents FROM llm_usage WHERE user_id = $1 AND date = CURRENT_DATE',
      [userId]
    );
    const totalAtCheckpointCents = parseFloat(rows[0]?.total_cost_cents || 0);
    const fresh = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    userBudgetCache.set(userId, fresh);
    return fresh;
  } catch (err) {
    log.warn('anthropic-proxy', 'Budget refresh failed; failing open', {
      userId, err: err.message,
    });
    // Fail open on a transient DB hiccup rather than blocking traffic.
    // The next refresh will catch up; bounded by TTL.
    const fresh = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    userBudgetCache.set(userId, fresh);
    return fresh;
  }
}

function anthropicProxyRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  if (!config.anthropicApiKey) {
    log.warn('anthropic-proxy', 'ANTHROPIC_API_KEY not set — proxy will 502 platform-key requests');
  }

  // Scoped JSON parser. Global parser (server.js) is skipped for our
  // path so we can carry our own 32mb limit — Anthropic itself caps
  // request bodies at 32MB, and a normal CC turn can carry several
  // MB of file context. See server.js comment near the global
  // express.json() mount for context.
  router.use(express.json({ limit: '32mb' }));

  // Same shape as the push-proxy rate-limit in internal.js — bounds a
  // runaway CC turn (or a malicious prompt looping API calls) to
  // 60/min/session. Honest CC turns make a handful of API calls per
  // turn, well under this. Independent of the budget cap; this just
  // bounds API call rate.
  const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('anthropic-proxy', 'Rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // Catch-all under the proxy prefix. Express 4 / path-to-regexp v0
  // matches `*` against the remainder, accessible as req.params[0].
  router.all(`${ROUTE_PREFIX}*`, anthropicProxyAuth, proxyLimiter, async (req, res) => {
    if (!config.anthropicApiKey) {
      return res.status(502).json({ ok: false, code: 'no_platform_key' });
    }

    const sessionId = req.workerSession?.sessionId;
    const userId = await resolveUserId(pool, sessionId);
    if (!userId) {
      // No session row in DB (or the session has no user). Refuse —
      // we can't enforce a budget for an anonymous caller, and a
      // missing session row likely means the JWT outlived its row.
      return res.status(403).json({ ok: false, code: 'session_not_found' });
    }

    // Resolve effective cap + current spend snapshot. Both come from
    // small caches (limits.js's own 10s cache for the cap, our
    // userBudgetCache for the user's daily total) so the steady-state
    // cost per Anthropic call is one hash-map lookup, not a DB
    // roundtrip.
    const capCents = await limits.getEffectiveUserLimitCents(pool, userId);
    const budget = await refreshUserBudget(pool, userId);

    // Start-of-call gate: if we already know the user is over cap,
    // refuse before opening any socket to Anthropic. The gate uses
    // the cached snapshot, so it's only as fresh as BUDGET_CACHE_TTL_MS
    // — but mid-stream kill catches anything the gate misses.
    const spentBeforeCall = budget.totalAtCheckpointCents + budget.liveDeltaCents;
    if (spentBeforeCall >= capCents) {
      log.info('anthropic-proxy', 'Start-of-call gate fired', {
        sessionId, userId, spentCents: spentBeforeCall, capCents,
      });
      return res.status(429).json({
        ok: false,
        code: 'budget_exceeded',
        message: `Daily limit reached ($${(capCents / 100).toFixed(2)}). Resets at midnight UTC.`,
      });
    }

    const upstreamPath = req.params[0] ? `/${req.params[0]}` : '/';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const upstreamUrl = `${anthropicStream.ANTHROPIC_UPSTREAM}${upstreamPath}${qs}`;

    const result = await anthropicStream.forwardCall({
      req,
      res,
      upstreamUrl,
      apiKey: config.anthropicApiKey,
      logTag: 'anthropic-proxy',
      logCtx: { sessionId, userId, upstreamPath },
      shouldKill: (currentCallCents, model) => {
        // Re-read the snapshot in case a parallel session for the same
        // user updated liveDeltaCents while we were streaming.
        const live = userBudgetCache.get(userId);
        const spentEffectiveCents =
          (live ? live.totalAtCheckpointCents + live.liveDeltaCents : spentBeforeCall) +
          currentCallCents;
        if (spentEffectiveCents > capCents) {
          log.info('anthropic-proxy', 'Mid-stream kill — over budget', {
            sessionId, userId,
            spentEffectiveCents: spentEffectiveCents.toFixed(2),
            capCents,
            currentCallCents: currentCallCents.toFixed(4),
            model,
          });
          return 'over_budget';
        }
        return null;
      },
    });

    // Fold this call's cost into the user's running tracker so the
    // next request sees it. Even on kill we count what we sent — the
    // worker really did consume those tokens (Anthropic charges for
    // partial generations).
    if (result.costCents > 0) {
      const live = userBudgetCache.get(userId);
      if (live) {
        live.liveDeltaCents += result.costCents;
      }
    }
    if (result.killed) {
      log.info('anthropic-proxy', 'Killed call settled', {
        sessionId, userId,
        currentCallCents: result.costCents.toFixed(4),
        model: result.model,
      });
    }
  });

  return router;
}

module.exports = anthropicProxyRoutes;
