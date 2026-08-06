'use strict';

// Incremental SSE parser for OpenRouter Responses streams (plan.md §8.5).
// Tees the raw bytes to the worker while extracting the terminal usage /
// cost / routed-provider metadata for idempotent settlement. OpenRouter's
// Responses API emits `response.completed` (and `response.done`) events
// carrying a `usage` object with prompt/completion/cached/reasoning token
// counts and a `cost` field (actual USD).

const log = require('./logger');

// Parse one SSE frame from an accumulating buffer. Returns { events, rest }
// where events is an array of { event, data } parsed frames and rest is the
// unconsumed remainder (handles frames split across TCP chunks).
function parseSseFrames(buf) {
  const events = [];
  let rest = '';
  let text = typeof buf === 'string' ? buf : buf.toString('utf8');
  // SSE frames are separated by a blank line.
  let idx;
  while ((idx = text.indexOf('\n\n')) !== -1) {
    const frame = text.slice(0, idx);
    text = text.slice(idx + 2);
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
    }
    events.push({ event, data });
  }
  return { events, rest: text };
}

// Extract terminal usage/cost from a parsed event's data (JSON). Returns
// null when the event carries no settlement-relevant usage.
function extractUsage(eventType, dataStr) {
  let data;
  try { data = JSON.parse(dataStr); } catch { return null; }
  // response.completed / response.done carry the final response object.
  if (eventType !== 'response.completed' && eventType !== 'response.done' && eventType !== 'response.created') {
    // Some providers emit a top-level `usage` on the final chunk.
    if (!data.usage && !data.cost) return null;
  }
  const usage = data.usage || {};
  const response = data.response || data;
  return {
    requestId: data.id || response.id || null,
    model: data.model || response.model || null,
    routedProvider: data.provider || response.provider || data.metadata?.provider || null,
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens || usage.cached_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
    reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    cost: typeof data.cost === 'number' ? data.cost
      : (typeof usage.cost === 'number' ? usage.cost : null),
  };
}

module.exports = { parseSseFrames, extractUsage };
