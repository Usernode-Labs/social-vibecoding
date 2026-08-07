'use strict';

// Incremental SSE parser for OpenRouter Responses streams (plan.md §8.5).
// OpenRouter's Responses API uses DATA-ONLY frames (no `event:` header):
//
//   data: {"type":"response.created","response":{...}}
//   data: {"type":"response.output_text.delta","delta":"..."}
//   data: {"type":"response.done","response":{...,"usage":{...}}}
//   data: [DONE]
//
// The terminal usage lives inside response.usage on the response.done
// (or response.completed) frame. This parser tees the raw bytes to the
// worker while extracting that terminal usage/cost for idempotent
// settlement. See:
//   https://openrouter.ai/docs/api/reference/responses/basic-usage

// Parse SSE frames from an accumulating buffer. Returns { events, rest }.
// Handles data-only frames (no `event:` line) and frames split across TCP
// chunks. Each event is { type, data } where `type` comes from the JSON
// payload's `type` field (data-only) or the `event:` header (if present).
function parseSseFrames(buf) {
  const events = [];
  let text = (typeof buf === 'string' ? buf : buf.toString('utf8')).replace(/\r\n/g, '\n');
  let idx;
  while ((idx = text.indexOf('\n\n')) !== -1) {
    const frame = text.slice(0, idx);
    text = text.slice(idx + 2);
    let eventName = null;
    let dataStr = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
    }
    if (!dataStr) continue;
    // [DONE] terminator — not JSON, skip.
    if (dataStr === '[DONE]') { events.push({ event: 'done', data: null }); continue; }
    // Parse JSON to get the type from the payload (data-only frames).
    let parsed;
    try { parsed = JSON.parse(dataStr); } catch { continue; }
    const type = eventName || parsed.type || 'message';
    events.push({ event: type, data: parsed });
  }
  return { events, rest: text };
}

// Extract terminal usage/cost from a parsed event. Returns null when the
// event carries no settlement-relevant usage. Only response.done and
// response.completed carry the final usage; the `usage` object lives
// inside the nested `response` property (not at the top level).
function extractUsage(eventType, data) {
  if (!data) return null;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  if (eventType !== 'response.done' && eventType !== 'response.completed') {
    // Some providers emit a top-level usage on the final chunk.
    if (!data.usage && !data.cost) return null;
  }
  // The usage object lives inside response.usage on response.done frames.
  const response = data.response || data;
  const usage = response.usage || data.usage || {};
  return {
    requestId: response.id || data.id || null,
    model: response.model || data.model || null,
    routedProvider: response.provider || data.provider || response.metadata?.provider || null,
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens || usage.cached_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
    reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    cost: typeof response.cost === 'number' ? response.cost
      : (typeof data.cost === 'number' ? data.cost
      : (typeof usage.cost === 'number' ? usage.cost : null)),
  };
}

module.exports = { parseSseFrames, extractUsage };
