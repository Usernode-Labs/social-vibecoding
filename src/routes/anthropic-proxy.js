'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { anthropicProxyAuth } = require('../middleware/anthropic-proxy-auth');
const { getPool } = require('../db/pool');
const limits = require('../services/limits');
const llm = require('../services/llm');
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
//   2. Mid-stream kill. As Anthropic's SSE response flows through, we
//      tee each chunk into a tiny SSE parser, watch
//      message_start.usage.input_tokens and message_delta.usage.
//      output_tokens, compute a running cost via `llm.estimateCostCents`,
//      and abort the upstream socket the moment running_total + this
//      call's running cost would cross the user's effective cap. The
//      Anthropic SDK in the `claude` CLI sees the truncated stream as
//      a normal API error and the turn ends. Worst-case overshoot is
//      bounded to "what landed between two `message_delta` events" —
//      typically a few cents.
//
// BYOK turns bypass the proxy entirely (worker.js sets the user's key
// directly in ANTHROPIC_API_KEY and leaves ANTHROPIC_BASE_URL unset),
// so this enforcement only applies to the platform-key code path.

const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const ROUTE_PREFIX = '/api/internal/anthropic/';

// Hop-by-hop headers (RFC 7230 §6.1) that must NEVER be forwarded
// through a proxy, plus a few Node/Express layer headers that would
// double-up if we passed them through.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length', // recomputed by fetch / Express
]);

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

// Minimal SSE parser that handles fragmented chunks. Anthropic frames
// each event as:
//
//   event: <name>\n
//   data: <json>\n
//   \n
//
// Multiple data lines are concatenated with '\n'. Lines may be split
// across chunks; we buffer until we see a newline. Returns a `feed`
// closure to be called with each Uint8Array → invokes onEvent({event,
// data}) for each complete event observed.
function makeSseTee(onEvent) {
  let buf = '';
  let eventName = '';
  let dataLines = [];
  function flush() {
    if (eventName || dataLines.length) {
      try {
        onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
      } catch (e) {
        // Don't let a bad onEvent crash the forward loop.
        log.warn('anthropic-proxy', 'SSE tee handler threw', { err: e.message });
      }
    }
    eventName = '';
    dataLines = [];
  }
  return function feed(chunkText) {
    buf += chunkText;
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        flush();
      } else if (line.startsWith(':')) {
        // SSE comment / heartbeat — ignore.
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // Spec: optional single space after colon.
        let v = line.slice(5);
        if (v.startsWith(' ')) v = v.slice(1);
        dataLines.push(v);
      }
      // Other field types (id:, retry:) are ignored for our purposes.
    }
  };
}

function anthropicProxyRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  if (!config.anthropicApiKey) {
    log.warn('anthropic-proxy', 'ANTHROPIC_API_KEY not set — proxy will 502 platform-key requests');
  }

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
    const upstreamUrl = `${ANTHROPIC_UPSTREAM}${upstreamPath}${qs}`;

    // Build forwarded headers: drop hop-by-hop, drop the worker JWT,
    // inject the real key. Preserve `anthropic-version`,
    // `anthropic-beta`, `accept`, `content-type`, etc.
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === 'x-api-key') continue;
      if (Array.isArray(v)) fwdHeaders[k] = v.join(', ');
      else if (v != null) fwdHeaders[k] = String(v);
    }
    fwdHeaders['x-api-key'] = config.anthropicApiKey;

    // Body: express.json() already parsed it (the global json parser
    // runs before this router). Re-stringify for forwarding. Anthropic
    // endpoints we proxy (/v1/messages, /v1/messages/count_tokens) all
    // take JSON bodies, so this is safe; if/when we forward a binary
    // endpoint later we'd need a raw-body branch above.
    let body;
    let requestModel = null;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
      body = JSON.stringify(req.body);
      fwdHeaders['content-type'] = 'application/json';
      // Capture the model from the request body in case message_start
      // doesn't include it (the SDK always does, but be safe).
      requestModel = typeof req.body.model === 'string' ? req.body.model : null;
    }

    // Abort upstream when the worker disconnects mid-stream so we
    // don't keep the Anthropic socket open after the client gives up.
    // This same controller is what the budget kill triggers.
    const abort = new AbortController();
    let killReason = null; // 'over_budget' | null
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: fwdHeaders,
        body,
        signal: abort.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return; // client gave up; nothing to send
      log.error('anthropic-proxy', 'Upstream fetch failed', {
        sessionId, userId, upstreamPath, err: err.message,
      });
      if (!res.headersSent) {
        return res.status(502).json({ ok: false, code: 'upstream_unreachable', message: err.message });
      }
      return;
    }

    // Mirror status + headers (skip hop-by-hop on the way back).
    // Node 22 fetch (undici) auto-decompresses the response body but
    // keeps the original `content-encoding` header — if we forwarded
    // that header the client would try to gunzip plain bytes and fail
    // mid-stream ("terminated"). Strip both `content-encoding` and
    // `content-length` (the latter no longer matches the on-wire
    // length anyway, and Express handles chunking on its own).
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (HOP_BY_HOP.has(k)) return;
      if (k === 'content-length') return;
      if (k === 'content-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstream.body) {
      return res.end();
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isSse = contentType.toLowerCase().includes('text/event-stream');

    // Per-call running cost in cents. Updated on each message_start /
    // message_delta event we observe in the SSE tee. On stream end
    // (success or kill) we fold this into the user's liveDeltaCents
    // so subsequent calls see the spend.
    let currentCallCents = 0;
    let currentInputTokens = 0;
    let currentOutputTokens = 0;
    let currentModel = requestModel;

    function recomputeCost() {
      currentCallCents = llm.estimateCostCents(
        { input_tokens: currentInputTokens, output_tokens: currentOutputTokens },
        currentModel
      );
    }

    function checkKill() {
      if (killReason) return; // already aborting
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
          model: currentModel,
        });
        killReason = 'over_budget';
        // Cancel the upstream socket so we stop pulling tokens, and
        // also signal the read loop directly: aborting the fetch
        // controller doesn't always synchronously fail the in-flight
        // `reader.read()` (undici may have already emitted the next
        // chunk into a pipe), so we rely on the loop's own
        // post-tee killReason check to break.
        abort.abort();
      }
    }

    // SSE tee: parse events as bytes flow through and update running
    // cost. We do NOT block the forward — chunks are written to the
    // worker as soon as they arrive; the tee just observes.
    // Output-token estimator. Anthropic only emits a final
    // `message_delta` with `usage.output_tokens` near the very end of
    // the stream, so a kill check that only watches that event would
    // fire ~99% through the generation — too late to actually truncate
    // anything. To catch a long generation as it grows, we estimate
    // `currentOutputTokens` from each `content_block_delta` payload
    // as it streams in (text deltas, tool-use partial-json, etc.).
    // The estimate is intentionally simple — Anthropic's tokenizer is
    // BPE, so we use a 4-chars-per-token heuristic which slightly
    // overestimates prose and slightly underestimates code. The final
    // `message_delta` then overwrites the estimate with Anthropic's
    // exact count. For cost-cap enforcement an estimate within
    // ±25 % is plenty: we want to catch users running away with
    // dollars of spend, not police pennies.
    let estimatedOutputTokensFromDeltas = 0;
    function bumpEstimateFromDelta(parsed) {
      const d = parsed && parsed.delta;
      if (!d) return;
      let text = '';
      if (typeof d.text === 'string') text += d.text;
      if (typeof d.partial_json === 'string') text += d.partial_json;
      if (typeof d.thinking === 'string') text += d.thinking;
      if (!text) return;
      estimatedOutputTokensFromDeltas += Math.ceil(text.length / 4);
    }

    const tee = isSse
      ? makeSseTee(({ event, data }) => {
          // Events we observe:
          //   message_start         — sets input_tokens + model
          //   content_block_delta   — incremental output text → estimate tokens
          //   message_delta         — final usage.output_tokens (replaces estimate)
          if (event !== 'message_start' &&
              event !== 'content_block_delta' &&
              event !== 'message_delta') {
            return;
          }
          let parsed;
          try { parsed = JSON.parse(data); } catch { return; }
          if (event === 'message_start') {
            const m = parsed.message;
            if (m && typeof m.model === 'string') currentModel = m.model;
            const usage = m && m.usage;
            if (usage && Number.isFinite(usage.input_tokens)) {
              currentInputTokens = usage.input_tokens;
            }
            if (usage && Number.isFinite(usage.output_tokens)) {
              currentOutputTokens = usage.output_tokens;
            }
          } else if (event === 'content_block_delta') {
            bumpEstimateFromDelta(parsed);
            // Use the larger of "what we estimated" vs "what Anthropic
            // last told us" so we don't go backwards if message_start
            // already reported a non-zero output count.
            currentOutputTokens = Math.max(currentOutputTokens, estimatedOutputTokensFromDeltas);
          } else {
            const usage = parsed.usage;
            if (usage && Number.isFinite(usage.output_tokens)) {
              currentOutputTokens = usage.output_tokens;
            }
          }
          recomputeCost();
          checkKill();
        })
      : null;

    // For non-streaming JSON responses, accumulate the body so we can
    // parse `usage` once the response ends and add it to liveDelta.
    // No mid-call kill is possible here (single round-trip), so the
    // cost just accounts post-hoc.
    let nonStreamingBody = isSse ? null : '';

    try {
      const reader = upstream.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          if (tee) {
            // Decoding to UTF-8 here is safe: SSE bodies are text and
            // Anthropic doesn't split a multi-byte char across chunks
            // in practice. Worst case a fragment lands at a boundary
            // and the parser sees it on the next chunk's append.
            tee(Buffer.from(value).toString('utf8'));
          } else if (nonStreamingBody !== null) {
            nonStreamingBody += Buffer.from(value).toString('utf8');
          }
          res.write(Buffer.from(value));
          // Break out of the loop the moment the SSE tee decided to
          // kill this call. abort.abort() above also fires, but the
          // upstream reader.read() can sit blocked on the socket
          // until undici fully cancels — which can take long enough
          // that the worker observes a 60s+ stall instead of a clean
          // truncation. Breaking here ends the client response now;
          // the reader.cancel() below releases the socket without
          // waiting for the cancel-via-signal to round-trip.
          if (killReason) {
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
        }
      }
      if (!res.writableEnded) res.end();

      // Parse a non-streaming response's `usage` post-hoc.
      if (nonStreamingBody) {
        try {
          const parsed = JSON.parse(nonStreamingBody);
          if (parsed.model && typeof parsed.model === 'string') currentModel = parsed.model;
          const usage = parsed.usage;
          if (usage && Number.isFinite(usage.input_tokens)) {
            currentInputTokens = usage.input_tokens;
          }
          if (usage && Number.isFinite(usage.output_tokens)) {
            currentOutputTokens = usage.output_tokens;
          }
          recomputeCost();
        } catch {
          // Not JSON, or no usage block — non-/v1/messages endpoint.
          // Skip cost accounting; we'll see it (or not) via the
          // turn-end llm_usage write that sessions.js already does.
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Either the worker disconnected, or our budget kill fired.
        // For budget kill, we've already logged at the abort() site;
        // the SDK on the worker side sees the truncated stream as a
        // normal stream-error and the turn ends.
        if (!res.writableEnded) res.end();
      } else {
        log.error('anthropic-proxy', 'Upstream stream error', {
          sessionId, userId, err: err.message,
        });
        if (!res.writableEnded) res.end();
      }
    }

    // Fold this call's cost into the user's running tracker so the
    // next request sees it. Even on kill we count what we sent — the
    // worker really did consume those tokens (Anthropic charges for
    // partial generations). currentCallCents is the most recent
    // running estimate from the SSE tee (or the post-hoc parse for
    // non-streaming).
    if (currentCallCents > 0) {
      const live = userBudgetCache.get(userId);
      if (live) {
        live.liveDeltaCents += currentCallCents;
      }
    }
    if (killReason === 'over_budget') {
      log.info('anthropic-proxy', 'Killed call settled', {
        sessionId, userId,
        currentCallCents: currentCallCents.toFixed(4),
        model: currentModel,
      });
    }
  });

  return router;
}

module.exports = anthropicProxyRoutes;
