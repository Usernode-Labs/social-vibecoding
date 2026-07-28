'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { appLlmAuth } = require('../middleware/app-llm-auth');
const { getPool } = require('../db/pool');
const limits = require('../services/limits');
const anthropicStream = require('../services/anthropic-stream');
const log = require('../services/logger');

// Dapp → platform LLM proxy (issue #34).
//
// Lets apps make Claude API calls billed to the signed-in user's
// existing daily token budget (or their stored Anthropic key), gated
// by an explicit per-app, per-user grant (app_llm_grants) with a daily
// cap — so apps never handle raw API keys. Auth (app token + user
// iframe JWT + active grant) lives in middleware/app-llm-auth.js; the
// stream-forwarding mechanics are shared with the worker proxy via
// services/anthropic-stream.js.
//
// Per call:
//   1. Payer resolution — limit-first, same semantics as
//      limits.resolveBillingPath: platform key while the user+global
//      budget has headroom; the user's own BYOK key takes over only
//      when the budget is exhausted AND the grant has allow_byok=true.
//   2. Start-of-call gates — (a) user/global budget (platform path
//      only), (b) per-app cap: today's app_llm_usage total vs the
//      grant's daily_cap_cents → 429 { code: 'app_cap_exceeded' }.
//   3. Mid-stream kill — the SSE tee estimates running cost and aborts
//      when either the user's effective budget (platform path) or the
//      per-app cap (both paths) would be crossed.
//   4. Settlement — spend is written to BOTH ledgers: llm_usage via
//      limits.recordSpend (platform-wide caps + /api/budget stay
//      correct) and app_llm_usage (per-app breakdown in Settings).
//
// Every post-auth response additionally carries the spend-meter
// headers (issue #655): x-usernode-llm-spent-cents (today's spend for
// this app+user at the START of the call — both buckets, the same
// figure the cap gate compares) and x-usernode-llm-cap-cents (the
// grant's daily cap). They're set before forwarding, so they ride
// successful streams and the route's own 429s alike; apps read them
// instead of keeping their own token-price tables.

const ROUTE_PREFIX = '/api/app-llm/';

// Tighter than the worker proxy's catch-all — callers are unreviewed
// app code, so only the two JSON message endpoints are forwarded.
const ALLOWED_PATHS = new Set(['v1/messages', 'v1/messages/count_tokens']);

// Same TTL scheme as the worker proxy's userBudgetCache, additionally
// keyed per (app, user) for the per-app cap check.
const CACHE_TTL_MS = 10_000;

// `${appId}:${userId}` -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents }
// totalAtCheckpoint counts BOTH buckets (total + byok) — the per-app
// cap applies regardless of who pays Anthropic.
const appUsageCache = new Map();

// userId -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents } —
// platform-key spend only, mirroring llm_usage.total_cost_cents.
const userBudgetCache = new Map();

async function refreshAppUsage(pool, appId, userId) {
  const key = `${appId}:${userId}`;
  const cached = appUsageCache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  try {
    const { rows } = await pool.query(
      `SELECT total_cost_cents, byok_cost_cents FROM app_llm_usage
        WHERE app_id = $1 AND user_id = $2 AND date = CURRENT_DATE`,
      [appId, userId]
    );
    const totalAtCheckpointCents =
      parseFloat(rows[0]?.total_cost_cents || 0) + parseFloat(rows[0]?.byok_cost_cents || 0);
    const fresh = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    appUsageCache.set(key, fresh);
    return fresh;
  } catch (err) {
    log.warn('app-llm-proxy', 'App usage refresh failed; failing open', {
      appId, userId, err: err.message,
    });
    const fresh = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    appUsageCache.set(key, fresh);
    return fresh;
  }
}

async function refreshUserBudget(pool, userId) {
  const cached = userBudgetCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
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
    log.warn('app-llm-proxy', 'User budget refresh failed; failing open', {
      userId, err: err.message,
    });
    const fresh = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    userBudgetCache.set(userId, fresh);
    return fresh;
  }
}

// Limit-first payer decision, scoped by the grant: platform key while
// the user+global budget has headroom; the user's own key only when
// the budget is exhausted AND the user opted this app into BYOK
// spillover (grant.allowByok, off by default). Returns exactly one of
//   { byok: false }                — bill the platform key
//   { byok: true, apiKey: '...' }  — bill the user's own key
//   { error: '...' }               — exhausted, no usable path
// Mirrors limits.resolveBillingPath but consults the grant before the
// key lookup — an app the user didn't opt in never sees their key
// spend, even when one is on file.
async function resolveAppPayer(pool, dataKey, userId, grant) {
  const budget = await limits.checkBudget(pool, userId);
  if (!budget.error) return { byok: false };
  if (grant.allowByok) {
    const apiKey = await limits.loadUserApiKey(pool, userId, dataKey);
    if (apiKey) return { byok: true, apiKey };
  }
  return { error: budget.error };
}

// Serialize the spend meter for the x-usernode-llm-spent-cents
// response header (issue #655). Ledger values are NUMERIC(10,4) —
// fractional cents — so round to 4 decimal places, trimming the float
// noise the cache's liveDelta additions accumulate.
function spentCentsHeaderValue(spentCents) {
  const n = Number(spentCents);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return String(Math.round(n * 10000) / 10000);
}

// Settlement upsert into the per-app ledger, mirroring
// limits.recordSpend's shape and tolerance (billing bookkeeping must
// never fail the request that incurred the spend).
async function recordAppSpend(pool, appId, userId, costCents, { byok = false } = {}) {
  if (!appId || !userId || !(costCents > 0)) return;
  const column = byok ? 'byok_cost_cents' : 'total_cost_cents';
  try {
    await pool.query(
      `INSERT INTO app_llm_usage (app_id, user_id, date, ${column}) VALUES ($1, $2, CURRENT_DATE, $3)
       ON CONFLICT (app_id, user_id, date) DO UPDATE SET ${column} = app_llm_usage.${column} + EXCLUDED.${column}`,
      [appId, userId, costCents]
    );
  } catch (err) {
    log.warn('app-llm-proxy', 'Failed to record app_llm_usage spend', {
      appId, userId, costCents, byok, err: err.message,
    });
  }
}

function appLlmProxyRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Scoped JSON parser, same rationale and limit as the worker proxy.
  router.use(ROUTE_PREFIX, express.json({ limit: '32mb' }));

  const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appLlm?.appId || 'anon'}:user:${req.appLlm?.userId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-llm-proxy', 'Rate-limited', {
        appId: req.appLlm?.appId, userId: req.appLlm?.userId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  const auth = appLlmAuth(pool, config);

  router.post(`${ROUTE_PREFIX}*`, auth, proxyLimiter, async (req, res) => {
    const upstreamPathRaw = req.params[0] || '';
    if (!ALLOWED_PATHS.has(upstreamPathRaw)) {
      return res.status(404).json({ ok: false, code: 'unsupported_endpoint' });
    }

    const { appId, appSlug, userId, grant } = req.appLlm;

    // Spend-meter headers (issue #655), set before ANY response body
    // so they ride every post-auth outcome — successful streams,
    // upstream errors, and the gate 429s below. The value is the
    // cumulative spend at the START of this call (the call's own cost
    // isn't known until after headers have flushed).
    const capCents = grant.dailyCapCents;
    const appUsage = await refreshAppUsage(pool, appId, userId);
    const appSpentBefore = appUsage.totalAtCheckpointCents + appUsage.liveDeltaCents;
    res.setHeader('x-usernode-llm-spent-cents', spentCentsHeaderValue(appSpentBefore));
    res.setHeader('x-usernode-llm-cap-cents', String(capCents));

    // 1. Payer resolution (limit-first, grant-scoped BYOK spillover).
    const payer = await resolveAppPayer(pool, config.dataEncryptionKey, userId, grant);
    if (payer.error) {
      return res.status(429).json({ ok: false, code: 'budget_exceeded', message: payer.error });
    }
    if (!payer.byok && !config.anthropicApiKey) {
      return res.status(502).json({ ok: false, code: 'no_platform_key' });
    }
    const apiKey = payer.byok ? payer.apiKey : config.anthropicApiKey;

    // 2. Per-app cap gate (both payment paths — the cap bounds total
    // spend through this app regardless of who pays Anthropic).
    if (appSpentBefore >= capCents) {
      log.info('app-llm-proxy', 'Per-app cap gate fired', {
        appId, appSlug, userId, spentCents: appSpentBefore, capCents,
      });
      return res.status(429).json({
        ok: false,
        code: 'app_cap_exceeded',
        message: `Daily cap reached for this app ($${(capCents / 100).toFixed(2)}). Resets at midnight UTC.`,
      });
    }

    // User-budget snapshot for the mid-stream kill (platform path
    // only; BYOK calls don't draw from the shared allowance).
    const userCapCents = payer.byok
      ? null
      : await limits.getEffectiveUserLimitCents(pool, userId);
    const userBudget = payer.byok ? null : await refreshUserBudget(pool, userId);
    const userSpentBefore = userBudget
      ? userBudget.totalAtCheckpointCents + userBudget.liveDeltaCents
      : 0;

    const upstreamUrl = `${anthropicStream.ANTHROPIC_UPSTREAM}/${upstreamPathRaw}`;

    // 3. Forward, with the mid-stream kill watching both budgets.
    const result = await anthropicStream.forwardCall({
      req,
      res,
      upstreamUrl,
      apiKey,
      // The app's credentials must never reach Anthropic.
      stripHeaders: ['x-usernode-app-token', 'x-usernode-user-token', 'cookie', 'authorization'],
      logTag: 'app-llm-proxy',
      logCtx: { appId, appSlug, userId, upstreamPath: upstreamPathRaw },
      shouldKill: (currentCallCents, model) => {
        const appLive = appUsageCache.get(`${appId}:${userId}`);
        const appEffective =
          (appLive ? appLive.totalAtCheckpointCents + appLive.liveDeltaCents : appSpentBefore) +
          currentCallCents;
        if (appEffective > capCents) {
          log.info('app-llm-proxy', 'Mid-stream kill — over app cap', {
            appId, appSlug, userId,
            spentEffectiveCents: appEffective.toFixed(2), capCents,
            currentCallCents: currentCallCents.toFixed(4), model,
          });
          return 'over_app_cap';
        }
        if (userCapCents != null) {
          const live = userBudgetCache.get(userId);
          const userEffective =
            (live ? live.totalAtCheckpointCents + live.liveDeltaCents : userSpentBefore) +
            currentCallCents;
          if (userEffective > userCapCents) {
            log.info('app-llm-proxy', 'Mid-stream kill — over user budget', {
              appId, appSlug, userId,
              spentEffectiveCents: userEffective.toFixed(2), userCapCents,
              currentCallCents: currentCallCents.toFixed(4), model,
            });
            return 'over_budget';
          }
        }
        return null;
      },
    });

    // 4. Settlement: both ledgers + the live trackers. Even on kill we
    // count what was sent — Anthropic charges for partial generations.
    if (result.costCents > 0) {
      await limits.recordSpend(pool, userId, result.costCents, { byok: payer.byok });
      await recordAppSpend(pool, appId, userId, result.costCents, { byok: payer.byok });
      const appLive = appUsageCache.get(`${appId}:${userId}`);
      if (appLive) appLive.liveDeltaCents += result.costCents;
      if (!payer.byok) {
        const live = userBudgetCache.get(userId);
        if (live) live.liveDeltaCents += result.costCents;
      }
    }
    if (result.killed) {
      log.info('app-llm-proxy', 'Killed call settled', {
        appId, appSlug, userId,
        currentCallCents: result.costCents.toFixed(4),
        model: result.model, byok: payer.byok,
      });
    }
  });

  return router;
}

module.exports = appLlmProxyRoutes;
// Exposed for tests (payer matrix, cap gates, dual-ledger settlement,
// spend-meter header serialization).
module.exports.resolveAppPayer = resolveAppPayer;
module.exports.recordAppSpend = recordAppSpend;
module.exports.spentCentsHeaderValue = spentCentsHeaderValue;
