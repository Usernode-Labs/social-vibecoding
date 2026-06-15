'use strict';

const llm = require('./llm');
const log = require('./logger');

// Shared Anthropic stream-forwarding mechanics, extracted from
// routes/anthropic-proxy.js (issue #34) so the worker proxy and the
// app-LLM proxy (/api/app-llm) don't duplicate ~200 lines of SSE
// parsing, hop-by-hop header filtering, and the forward/kill loop.
//
// The two proxies differ in WHO is calling (worker JWT vs app token +
// user iframe token) and in WHICH budgets gate the call — those
// decisions stay in the routes. What lives here is the mechanical
// middle: forward the request to api.anthropic.com with the real key,
// tee the SSE response to estimate running cost, ask the caller's
// `shouldKill` after every cost update, and report the final cost so
// the caller can settle its ledgers.

const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';

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

// Minimal SSE parser that handles fragmented chunks. Anthropic frames
// each event as:
//
//   event: <name>\n
//   data: <json>\n
//   \n
//
// Multiple data lines are concatenated with '\n'. Lines may be split
// across chunks; we buffer until we see a newline. Returns a `feed`
// closure to be called with each chunk's text → invokes onEvent({event,
// data}) for each complete event observed.
function makeSseTee(onEvent, logTag = 'anthropic-stream') {
  let buf = '';
  let eventName = '';
  let dataLines = [];
  function flush() {
    if (eventName || dataLines.length) {
      try {
        onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
      } catch (e) {
        // Don't let a bad onEvent crash the forward loop.
        log.warn(logTag, 'SSE tee handler threw', { err: e.message });
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

// Build forwarded headers: drop hop-by-hop, drop the caller's auth
// headers (x-api-key plus anything in `strip`), inject the real key.
// Preserves `anthropic-version`, `anthropic-beta`, `accept`,
// `content-type`, etc.
function buildForwardHeaders(reqHeaders, apiKey, { strip = [] } = {}) {
  const stripSet = new Set(strip.map((h) => h.toLowerCase()));
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const kl = k.toLowerCase();
    if (HOP_BY_HOP.has(kl)) continue;
    if (kl === 'x-api-key') continue;
    if (stripSet.has(kl)) continue;
    if (Array.isArray(v)) fwdHeaders[k] = v.join(', ');
    else if (v != null) fwdHeaders[k] = String(v);
  }
  fwdHeaders['x-api-key'] = apiKey;
  return fwdHeaders;
}

// Forward one request to Anthropic and stream the response back,
// estimating running cost from the SSE tee and killing the upstream
// the moment `shouldKill(currentCallCents)` returns a truthy reason.
//
//   req, res       — Express request/response. req.body must already be
//                    parsed JSON (both proxies mount their own scoped
//                    express.json()).
//   upstreamUrl    — full https://api.anthropic.com/... URL.
//   apiKey         — the real key to inject (platform or BYOK).
//   stripHeaders   — extra request headers to drop before forwarding
//                    (caller-side credentials like x-usernode-*).
//   shouldKill     — optional (currentCallCents, model) => reason|null,
//                    consulted after every cost update. A truthy return
//                    aborts the upstream; the client sees a truncated
//                    stream (a normal API error to the SDK).
//   logTag, logCtx — logging identity for warn/error lines.
//
// Resolves { costCents, model, killed, status } once the response has
// ended (normally, by kill, or by client disconnect). Mid-call costs
// are best-effort estimates (see the output-token estimator below);
// the final message_delta overwrites the estimate with Anthropic's
// exact count, so the settled cost is accurate to one event gap.
async function forwardCall({
  req,
  res,
  upstreamUrl,
  apiKey,
  stripHeaders = [],
  shouldKill = null,
  logTag = 'anthropic-stream',
  logCtx = {},
}) {
  const fwdHeaders = buildForwardHeaders(req.headers, apiKey, { strip: stripHeaders });

  let body;
  let requestModel = null;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
    body = JSON.stringify(req.body);
    fwdHeaders['content-type'] = 'application/json';
    // Capture the model from the request body in case message_start
    // doesn't include it (the SDK always does, but be safe).
    requestModel = typeof req.body.model === 'string' ? req.body.model : null;
  }

  // Abort upstream when the client disconnects mid-stream so we don't
  // keep the Anthropic socket open after the caller gives up. This
  // same controller is what the budget kill triggers.
  const abort = new AbortController();
  let killReason = null;
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
    if (err.name === 'AbortError') {
      // Client gave up; nothing to send.
      return { costCents: 0, model: requestModel, killed: false, status: 0 };
    }
    log.error(logTag, 'Upstream fetch failed', { ...logCtx, err: err.message });
    if (!res.headersSent) {
      res.status(502).json({ ok: false, code: 'upstream_unreachable', message: err.message });
    }
    return { costCents: 0, model: requestModel, killed: false, status: 502 };
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
    res.end();
    return { costCents: 0, model: requestModel, killed: false, status: upstream.status };
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isSse = contentType.toLowerCase().includes('text/event-stream');

  // Per-call running cost in cents. Updated on each message_start /
  // message_delta event we observe in the SSE tee. The caller folds
  // the settled value into its own spend trackers.
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
    if (killReason || !shouldKill) return;
    const reason = shouldKill(currentCallCents, currentModel);
    if (reason) {
      killReason = reason;
      // Cancel the upstream socket so we stop pulling tokens, and
      // also signal the read loop directly: aborting the fetch
      // controller doesn't always synchronously fail the in-flight
      // `reader.read()` (undici may have already emitted the next
      // chunk into a pipe), so we rely on the loop's own
      // post-tee killReason check to break.
      abort.abort();
    }
  }

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

  // SSE tee: parse events as bytes flow through and update running
  // cost. We do NOT block the forward — chunks are written to the
  // client as soon as they arrive; the tee just observes.
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
      }, logTag)
    : null;

  // For non-streaming JSON responses, accumulate the body so we can
  // parse `usage` once the response ends. No mid-call kill is possible
  // here (single round-trip), so the cost just accounts post-hoc.
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
        // that the client observes a 60s+ stall instead of a clean
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
        // Skip cost accounting; the caller's turn-end settlement (if
        // any) will see it or not.
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // Either the client disconnected, or the budget kill fired.
      // The SDK on the client side sees the truncated stream as a
      // normal stream-error and the turn ends.
      if (!res.writableEnded) res.end();
    } else {
      log.error(logTag, 'Upstream stream error', { ...logCtx, err: err.message });
      if (!res.writableEnded) res.end();
    }
  }

  return {
    costCents: currentCallCents,
    model: currentModel,
    killed: !!killReason,
    status: upstream.status,
  };
}

module.exports = {
  ANTHROPIC_UPSTREAM,
  HOP_BY_HOP,
  makeSseTee,
  buildForwardHeaders,
  forwardCall,
};
