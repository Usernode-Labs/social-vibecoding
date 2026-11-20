'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { anthropicProxyAuth } = require('../middleware/anthropic-proxy-auth');
const { getPool } = require('../db/pool');
const limits = require('../services/limits');
// #2513: fail CLOSED on a database error. Every refresher below used to
// install `totalAtCheckpointCents: 0` — "no spend today" — and cache it for a
// full TTL, so a Postgres blip removed the spending cap rather than the
// traffic. Shared with app-llm-proxy.js so the two cannot drift.
const spendCache = require('../services/spend-cache');
const anthropicStream = require('../services/anthropic-stream');
const budgetLive = require('../services/budget-live');
const openrouterMessages = require('../services/openrouter-messages');
const log = require('../services/logger');

// Worker → platform model relay (the "Anthropic proxy" by its route).
//
// Why this exists: the CC worker container runs `claude
// --dangerously-skip-permissions` against user prompts. If the worker
// held a real model key, any user could ask CC to `echo` it and
// exfiltrate a platform-wide credential.
//
// Instead, the worker holds a session-scoped worker:anthropic-proxy token
// (in ANTHROPIC_API_KEY, picked up by the CLI as x-api-key) and points
// ANTHROPIC_BASE_URL at /api/internal/anthropic on the platform. This relay
// verifies that narrow purpose and forwards the call to OpenRouter's Claude
// Messages endpoint on the platform's OpenRouter key (services/openrouter-
// messages.js, task 2275; it went to api.anthropic.com on a separate
// Anthropic key before). An exfiltrated relay token cannot call the
// platform's push/draft APIs or any provider directly, and expires with the
// worker-token TTL. The turns that come here are the platform's own Claude
// Code turns: before & after shots and Sync with main's conflict turns.
//
// The relay also enforces the daily LLM cap mid-stream:
//   1. Start-of-call gate. Cheap pre-check; if today's recorded spend
//      already meets the cap, return 429 immediately so we don't even
//      open a socket upstream.
//   2. Mid-stream kill. As the SSE response flows through, the shared
//      forward loop (services/anthropic-stream.js) tees each chunk into a
//      tiny SSE parser, computes a running cost, and aborts the upstream
//      socket the moment running_total + this call's running cost would
//      cross the effective cap. The `claude` CLI sees the truncated stream
//      as a normal API error and the turn ends. Worst-case overshoot is
//      bounded to "what landed between two `message_delta` events":
//      typically a few cents.
//
// The stream-forwarding mechanics (SSE tee, header filtering, the
// forward/kill loop) live in src/services/anthropic-stream.js, shared
// with the app-LLM proxy (routes/app-llm-proxy.js, issue #34). What
// stays here is worker-specific: session→user resolution, the budget
// caches, and the gates. There is no payer switch any more: people's own
// Anthropic keys are gone, so the platform's allowance is the only payer.

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
// spend we read from the DB: what llm_usage has settled plus what
// running turns' calls have cost and no turn's end has settled yet
// (turn_spend, written per call below, whichever process the call
// reached); `liveDeltaCents` is the sum of finalized Anthropic-call costs
// this process observed via the SSE tee since that checkpoint. On each
// refresh we re-read the DB and reset liveDeltaCents to 0: a call this
// process saw is in turn_spend by then. A call whose row is still being
// written at the refresh is missed for one window, i.e. cents.
const userBudgetCache = new Map();
//   userId -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

// #361: process-local mirror of userBudgetCache for the system-token
// budget. Merge-conflict / sync turns bill this single daily bucket
// instead of any user, so there's one tracker (not keyed by user). Same
// checkpoint+liveDelta shape so the mid-stream kill works identically.
let systemBudgetCache = null; // { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

async function refreshSystemBudget(pool) {
  const now = Date.now();
  if (systemBudgetCache && now - systemBudgetCache.fetchedAt < BUDGET_CACHE_TTL_MS) {
    return systemBudgetCache;
  }
  try {
    const { rows } = await pool.query(
      'SELECT cost_cents FROM system_token_usage WHERE date = CURRENT_DATE'
    );
    const totalAtCheckpointCents = parseFloat(rows[0]?.cost_cents || 0);
    systemBudgetCache = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    return systemBudgetCache;
  } catch (err) {
    log.warn('anthropic-proxy', 'System budget refresh failed; failing closed', { err: err.message });
    systemBudgetCache = spendCache.unavailable(systemBudgetCache, now, BUDGET_CACHE_TTL_MS);
    return systemBudgetCache;
  }
}

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
    const { rows } = await pool.query(`SELECT ${limits.TODAY_USER_SPEND_SQL} AS total_cost_cents`, [userId]);
    const totalAtCheckpointCents = parseFloat(rows[0]?.total_cost_cents || 0);
    const fresh = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    userBudgetCache.set(userId, fresh);
    return fresh;
  } catch (err) {
    log.warn('anthropic-proxy', 'Budget refresh failed; failing closed', {
      userId, err: err.message,
    });
    // #2513: keep the last real figure rather than inventing zero, and retry
    // sooner than a full TTL. With nothing known at all, refuse — an
    // unbounded bill is worse than a retryable 429.
    const fresh = spendCache.unavailable(cached, now, BUDGET_CACHE_TTL_MS);
    userBudgetCache.set(userId, fresh);
    return fresh;
  }
}

// #1788: process-local mirror of userBudgetCache for the WEEKLY per-user
// cap. Same checkpoint+liveDelta shape and the same fail-open posture as
// refreshUserBudget above — a bookkeeping read must never be what refuses
// a turn. Keyed by user; only populated when a weekly cap actually
// applies, so users with the weekly layer switched off pay nothing for it.
const weeklyBudgetCache = new Map();
//   userId -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

async function refreshUserWeeklySpend(pool, userId) {
  const cached = weeklyBudgetCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached;
  try {
    const totalAtCheckpointCents = (await limits.getWeeklyTotalsCents(pool, userId)).platformCents;
    const fresh = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    weeklyBudgetCache.set(userId, fresh);
    return fresh;
  } catch (err) {
    log.warn('anthropic-proxy', 'Weekly budget refresh failed; failing closed', {
      userId, err: err.message,
    });
    const fresh = spendCache.unavailable(cached, now, BUDGET_CACHE_TTL_MS);
    weeklyBudgetCache.set(userId, fresh);
    return fresh;
  }
}

// #1788: shown when BOTH caps are switched off for an account. Fails
// closed by design — an account with no allowance configured has nothing
// to draw from, so it is refused rather than granted the platform key.
const NO_ALLOWANCE_MESSAGE =
  'No AI allowance is configured for this account. An admin can set a daily or weekly cap in the admin console.';

// #800: accumulate this call's cost onto the session's coding-agent
// spend ledger (chat_sessions.agent_cost_cents) — the platform's only
// per-change cost record. Everything else the proxy does with
// result.costCents is in-memory (budget trackers) or per-user-per-day
// (llm_usage), so without this the agent's spend — the large majority of
// what a change costs — is unattributable to the change forever.
//
// This is a list-price cost record, not a billing record.
//
// Three gates, all "don't record it":
//   - `isSyncTurn`: platform-driven merge-conflict / sync-with-main
//     turns bill system_token_usage and run on a fixed model. They are
//     housekeeping, not a consequence of the user's model choice.
//   - zero cost: a killed or empty call shouldn't churn the row.
//   - no sessionId: the id comes from a signed JWT claim
//     (middleware/anthropic-proxy-auth.js) and is read with optional
//     chaining, so never build `WHERE id = undefined`.
//
// FIRE-AND-FORGET by contract: never awaited into the response path, and
// a failure is a log.warn and nothing more. Bookkeeping must not be able
// to fail or delay a turn.
//
// #2592: it records WHICH MODEL spent it, too. The ledger column has no
// model dimension, so services/model-costs.js had to leave the agent's
// spend out of its per-model aggregate entirely — which is why the
// observed average and median on the Model costs console read far below
// what a change really costs. The proxy is the one place that knows: the
// stream reports the model it actually ran on (falling back to the one
// the request asked for), so the breakdown is recorded rather than
// inferred. A call whose model could not be determined still lands on the
// ledger; it just adds no per-model row.
//
// ONE STATEMENT, not two. The breakdown rides on a CTE over the ledger
// UPDATE so the pair cannot half-happen: a session's per-model rows sum to
// its ledger, or neither was written. That is what lets a reader trust
// either number on its own.
const LEDGER_SQL =
  `UPDATE chat_sessions SET agent_cost_cents = agent_cost_cents + $1 WHERE id = $2`;

const LEDGER_WITH_MODEL_SQL =
  `WITH ledger AS (
     UPDATE chat_sessions SET agent_cost_cents = agent_cost_cents + $1 WHERE id = $2
     RETURNING id
   )
   INSERT INTO chat_session_agent_model_costs (session_id, model, cost_cents)
     SELECT ledger.id, $3::varchar, $1::numeric FROM ledger
   ON CONFLICT (session_id, model) DO UPDATE
     SET cost_cents = chat_session_agent_model_costs.cost_cents + EXCLUDED.cost_cents,
         updated_at = NOW()`;

// The breakdown column is VARCHAR(128); a model id is far shorter than
// that, but an upstream that answered with something long must not turn a
// bookkeeping write into an error.
const MAX_MODEL_ID = 128;

function noteAgentSpend(pool, { sessionId, costCents, isSyncTurn, model }) {
  if (isSyncTurn) return;
  if (!sessionId) return;
  const cents = Number(costCents);
  if (!Number.isFinite(cents) || cents <= 0) return;
  const modelId = (typeof model === 'string' ? model.trim() : '').slice(0, MAX_MODEL_ID);
  Promise.resolve()
    .then(() => (modelId
      ? pool.query(LEDGER_WITH_MODEL_SQL, [cents, sessionId, modelId])
      : pool.query(LEDGER_SQL, [cents, sessionId])))
    .catch((err) => {
      log.warn('anthropic-proxy', 'Failed to record agent spend on session', {
        sessionId, costCents: cents, model: modelId || null, err: err.message,
      });
    });
}

function anthropicProxyRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Scoped JSON parser. Global parser (server.js) is skipped for our
  // path so we can carry our own 32mb limit — the Messages API caps
  // request bodies at 32MB, and a normal CC turn can carry several
  // MB of file context. See server.js comment near the global
  // express.json() mount for context.
  //
  // #2512: this is a route-chain step, NOT a `router.use`, so it runs AFTER
  // `anthropicProxyAuth` and the rate limiter. Mounted on the router it ran
  // first, and an unauthenticated caller could make the platform read and
  // JSON.parse 32 MB before anything checked the worker JWT — the parse
  // blocks the event loop, and the request needed no credential at all.
  // Auth here reads headers only (middleware/anthropic-proxy-auth.js never
  // touches req.body), so it does not need the body.
  const parseBody = express.json({ limit: '32mb' });

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
  router.all(`${ROUTE_PREFIX}*`, anthropicProxyAuth, proxyLimiter, parseBody, async (req, res) => {
    const sessionId = req.workerSession?.sessionId;
    const userId = await resolveUserId(pool, sessionId);
    if (!userId) {
      // No session row in DB (or the session has no user). Refuse —
      // we can't enforce a budget for an anonymous caller, and a
      // missing session row likely means the JWT outlived its row.
      return res.status(403).json({ ok: false, code: 'session_not_found' });
    }

    // Only the two Messages routes are relayed (OpenRouter serves no other
    // Claude endpoint); anything else Claude Code might ask for is refused
    // before any budget work.
    const upstreamPath = req.params[0] ? `/${req.params[0]}` : '/';
    const upstreamUrl = openrouterMessages.upstreamUrlFor(config.openrouterApiBase, upstreamPath);
    if (!upstreamUrl) {
      return res.status(404).json({ ok: false, code: 'unsupported_path' });
    }

    // #361: merge-conflict / sync turns are platform housekeeping and
    // bill the dedicated system-token budget, not the owner's allowance.
    // The worker records the in-flight turn's mode in its warm registry;
    // read it synchronously to decide which cap+tracker to gate against.
    let workerMod = null;
    try { workerMod = require('../services/worker'); } catch {}

    // A before & after shots eval's trial runs the shots agent on somebody
    // else's merged proposal for an admin's comparison (the shots-eval
    // machine, src/workflow/shots-eval/). The platform's key pays for it and
    // the eval's own cap bounds it: never the proposal author's allowance,
    // never the system bucket the sync turns below live on, and never the
    // change's ledger. Each call is added to the trial, and one that would
    // take the eval past its cap is refused or cut off. Which turn is a
    // trial's is read from the session's turn record (its owner is the
    // eval machine's work), in any process and whether or not the process
    // that dispatched it is alive: never from this process's memory, and
    // never by the session alone (a person's own shots rerun of the same
    // proposal is theirs).
    let shotsEval = null;
    let turnMode = null;
    try { turnMode = workerMod ? await workerMod.turnModeFor(sessionId) : null; } catch { turnMode = null; }
    if (turnMode === 'shots' || turnMode == null) {
      try { shotsEval = await require('../services/shots-eval').billFor(pool, sessionId); } catch { shotsEval = null; }
      if (shotsEval) {
        const note = shotsEval.noteSpend;
        shotsEval.noteSpend = (cents) => Promise.resolve(note(cents)).catch((err) => {
          log.warn('anthropic-proxy', 'Could not record a shots eval call', { sessionId, err: err.message });
        });
      }
    }
    if (shotsEval) {
      if (shotsEval.overCap(0)) {
        return res.status(429).json({ ok: false, code: 'budget_exceeded', message: 'This shots eval reached its cap.' });
      }
      const evalKey = await openrouterMessages.platformKey(config, { pool });
      if (!evalKey) {
        return res.status(502).json({ ok: false, code: 'no_platform_key' });
      }
      const result = await anthropicStream.forwardCall({
        req,
        res,
        upstreamUrl,
        apiKey: evalKey,
        origin: config.openrouterOrigin,
        logTag: 'anthropic-proxy',
        logCtx: { sessionId, userId, upstreamPath, shotsEval: true },
        shouldKill: (currentCallCents) => (shotsEval.overCap(currentCallCents) ? 'over_budget' : null),
      });
      shotsEval.noteSpend(result.costCents);
      return;
    }

    const isSyncTurn = turnMode === 'sync';
    // The turn this call belongs to, read as it starts: its cost is kept
    // against that turn however late its write lands (limits.js
    // noteTurnSpend reconciles one that lands after the turn settled).
    const spendTurn = !isSyncTurn && turnMode !== 'shots' ? await limits.turnSpendTarget(pool, sessionId) : null;

    // Resolve effective cap + current spend snapshot. Both come from
    // small caches (limits.js's own 10s cache for the cap, our
    // per-user / system budget tracker for the daily total) so the
    // steady-state cost per Anthropic call is one hash-map lookup, not a
    // DB roundtrip.
    // #1788: the per-user allowance is two caps now — daily and weekly —
    // and either may be switched off (0/unset), so every gate below asks
    // resolveCaps which ones apply rather than comparing one number.
    // Sync turns are unchanged: they bill the single system-token bucket,
    // which has no weekly layer.
    const caps = isSyncTurn
      ? {
          dailyApplies: true,
          dailyLimitCents: await limits.getSystemTokensLimitCents(pool),
          weeklyApplies: false,
          weeklyLimitCents: 0,
        }
      : limits.resolveCaps(await limits.getUserCreditEntitlement(pool, userId));
    const capCents = caps.dailyLimitCents;
    const budget = isSyncTurn
      ? await refreshSystemBudget(pool)
      : await refreshUserBudget(pool, userId);
    const weeklyBudget = caps.weeklyApplies
      ? await refreshUserWeeklySpend(pool, userId)
      : null;
    // #2513: an UNREADABLE ledger is not the same thing as an exhausted cap,
    // and must not be fed to the logic below as if it were. Left to arithmetic
    // alone, the fail-closed sentinel reads as "over cap", and a Postgres blip
    // would end a turn as if its allowance were spent. Refuse first, with a
    // code that says "try again", and let the gates below see only real
    // numbers.
    if (spendCache.isUnavailable(budget)
      || (weeklyBudget && spendCache.isUnavailable(weeklyBudget))) {
      log.warn('anthropic-proxy', 'Spend ledger unavailable; refusing rather than billing', {
        sessionId, userId, isSyncTurn,
        dailyUnavailable: spendCache.isUnavailable(budget),
        weeklyUnavailable: !!weeklyBudget && spendCache.isUnavailable(weeklyBudget),
      });
      return res.status(429).json({
        ok: false,
        code: 'budget_unavailable',
        message: 'Spending records are briefly unavailable. Try again in a moment.',
      });
    }

    const spentBeforeCall = spendCache.spendTotal(budget);
    const weeklySpentBeforeCall = weeklyBudget
      ? spendCache.spendTotal(weeklyBudget)
      : 0;
    const dailyOver = caps.dailyApplies && spentBeforeCall >= caps.dailyLimitCents;
    const weeklyOver = caps.weeklyApplies && weeklySpentBeforeCall >= caps.weeklyLimitCents;
    const noAllowance = !caps.dailyApplies && !caps.weeklyApplies;
    // Whichever window is actually binding decides the copy the user sees.
    const boundWindow = weeklyOver ? 'weekly' : 'daily';
    const messageFor = (win) => {
      if (isSyncTurn) {
        return `System token budget reached ($${(capCents / 100).toFixed(2)}). Resets at midnight UTC.`;
      }
      if (noAllowance) return NO_ALLOWANCE_MESSAGE;
      return win === 'weekly'
        ? `Weekly limit reached ($${(caps.weeklyLimitCents / 100).toFixed(2)}). Resets ${limits.WEEKLY_RESET_LABEL}.`
        : `Daily limit reached ($${(capCents / 100).toFixed(2)}). Resets at midnight UTC.`;
    };
    const overMessage = messageFor(boundWindow);

    const platformKey = await openrouterMessages.platformKey(config, { pool });
    if (!platformKey) {
      return res.status(502).json({ ok: false, code: 'no_platform_key' });
    }

    // Start-of-call gate: if we already know we're over cap, refuse
    // before opening any socket upstream. The gate uses the cached
    // snapshot, so it's only as fresh as BUDGET_CACHE_TTL_MS — but
    // mid-stream kill catches anything the gate misses.
    if (dailyOver || weeklyOver || noAllowance) {
      log.info('anthropic-proxy', 'Start-of-call gate fired', {
        sessionId, userId, isSyncTurn, spentCents: spentBeforeCall, capCents,
        window: noAllowance ? 'none' : boundWindow,
        weeklySpentCents: weeklySpentBeforeCall,
        weeklyCapCents: caps.weeklyApplies ? caps.weeklyLimitCents : null,
      });
      return res.status(429).json({
        ok: false,
        code: 'budget_exceeded',
        message: overMessage,
      });
    }

    const result = await anthropicStream.forwardCall({
      req,
      res,
      upstreamUrl,
      apiKey: platformKey,
      origin: config.openrouterOrigin,
      logTag: 'anthropic-proxy',
      logCtx: { sessionId, userId, upstreamPath },
      shouldKill: (currentCallCents, model) => {
        // Re-read the snapshot in case a parallel session updated
        // liveDeltaCents while we were streaming. Sync turns track the
        // single system bucket; everything else the per-user bucket.
        const live = isSyncTurn ? systemBudgetCache : userBudgetCache.get(userId);
        const spentEffectiveCents =
          (live ? live.totalAtCheckpointCents + live.liveDeltaCents : spentBeforeCall) +
          currentCallCents;
        // #1788: the weekly bucket runs the same checkpoint+liveDelta
        // arithmetic against its own tracker, and either cap crossing kills.
        const liveWeekly = caps.weeklyApplies ? weeklyBudgetCache.get(userId) : null;
        const weeklyEffectiveCents = caps.weeklyApplies
          ? (liveWeekly
              ? liveWeekly.totalAtCheckpointCents + liveWeekly.liveDeltaCents
              : weeklySpentBeforeCall) + currentCallCents
          : 0;
        const overDailyNow = caps.dailyApplies && spentEffectiveCents > capCents;
        const overWeeklyNow = caps.weeklyApplies && weeklyEffectiveCents > caps.weeklyLimitCents;
        if (overDailyNow || overWeeklyNow) {
          log.info('anthropic-proxy', 'Mid-stream kill — over budget', {
            sessionId, userId,
            window: overWeeklyNow ? 'weekly' : 'daily',
            spentEffectiveCents: spentEffectiveCents.toFixed(2),
            capCents,
            weeklyEffectiveCents: weeklyEffectiveCents.toFixed(2),
            weeklyCapCents: caps.weeklyApplies ? caps.weeklyLimitCents : null,
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
      const live = isSyncTurn ? systemBudgetCache : userBudgetCache.get(userId);
      if (live) {
        live.liveDeltaCents += result.costCents;
      }
      if (!isSyncTurn) {
        // #1788: platform-billed user spend draws down the weekly bucket
        // as well, so a mid-turn weekly crossing is visible to the next call.
        const liveWeekly = weeklyBudgetCache.get(userId);
        if (liveWeekly) liveWeekly.liveDeltaCents += result.costCents;
        // #2598: and to the user. This call has RETURNED and been priced —
        // the same figure the kill gate above would refuse the next one on —
        // so the weekly meter can tick now rather than when the turn's ledger
        // receipt is written. Every coding-agent call the platform key pays
        // for passes through here, which is what makes "$x left this week"
        // move every few seconds during a build. Sync turns bill the system
        // bucket, which is nobody's meter.
        budgetLive.notifySpend(pool, userId, {
          liveWeeklySpentCents: liveWeekly
            ? liveWeekly.totalAtCheckpointCents + liveWeekly.liveDeltaCents
            : null,
        });
      }
    }
    // The call, kept against its turn as it is made: the caps count it at
    // once, in every process, and its turn's end settles it. Not a sync
    // turn's (the system bucket), nor a person's shots run's (gated by the
    // owner's caps, never settled into their allowance).
    if (!isSyncTurn && turnMode !== 'shots') {
      void limits.noteTurnSpend(pool, { sessionId, userId, cents: result.costCents, byok: false, turn: spendTurn });
    }
    // #800: same cost, recorded durably against the change rather than
    // only in the in-memory trackers above. Counted on kills too, for the
    // same reason the trackers count them — the tokens were consumed.
    noteAgentSpend(pool, {
      sessionId, costCents: result.costCents, isSyncTurn, model: result.model,
    });
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
// #800: exposed for tests/anthropic-proxy-agent-spend.test.js. The ledger
// has no UI, so its gates (sync turn / zero cost / missing session) and
// its swallow-on-failure contract are only observable through a direct
// unit test. Attached as a property so `require(...)(config)` — how
// server.js mounts the router — keeps working unchanged.
module.exports.noteAgentSpend = noteAgentSpend;
