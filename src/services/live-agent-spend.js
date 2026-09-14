'use strict';

// Display-only running estimate. Billing continues to use Claude's terminal
// result; no partial usage from this observer is written to a credit ledger.
const { estimateCostCents } = require('./llm');

const tokenCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

function createTracker() {
  return { messages: new Map(), active: new Map(), seen: new Set(), finalCents: null };
}

function mergeUsage(message, usage) {
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (tokenCount(usage?.[key]) !== null) message.usage[key] = usage[key];
  }
  const hour = tokenCount(usage?.cache_creation?.ephemeral_1h_input_tokens);
  if (hour !== null) message.hourCacheTokens = hour;
}

function messageCost(message) {
  const u = message.usage;
  // Cache reads cost 10% of input; writes cost 125% (5m) or 200% (1h).
  const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1
    + (u.cache_creation_input_tokens || 0) * 1.25
    + Math.min(message.hourCacheTokens || 0, u.cache_creation_input_tokens || 0) * 0.75;
  const output = message.complete ? (u.output_tokens || 0)
    : Math.max(u.output_tokens || 0, Math.ceil(message.characters / 4));
  return estimateCostCents({ input_tokens: input, output_tokens: output }, message.model);
}

function snapshot(tracker) {
  const costCents = tracker.finalCents ?? [...tracker.messages.values()]
    .reduce((sum, message) => sum + messageCost(message), 0);
  return Number.isFinite(costCents) && costCents > 0
    ? { costCents, estimated: tracker.finalCents === null } : null;
}

function observe(tracker, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'result' && !event.parent_tool_use_id) {
    const total = tokenCount(event.cost_usd ?? event.total_cost_usd);
    if (total !== null) tracker.finalCents = total * 100;
    return;
  }
  const partial = event.type === 'stream_event' ? event.event : null;
  const message = partial?.type === 'message_start' ? partial.message
    : event.type === 'assistant' ? event.message : null;
  const scope = `${event.session_id || ''}:${event.parent_tool_use_id || ''}`;
  if (message) {
    if (!message.id || typeof message.model !== 'string' || message.model === '<synthetic>') return;
    const id = `${scope}:${message.id}`;
    let record = tracker.messages.get(id);
    if (!record) {
      record = { model: message.model, usage: {}, characters: 0, complete: false };
      tracker.messages.set(id, record);
    }
    mergeUsage(record, message.usage);
    // Full assistant messages may arrive once per content block with the
    // SAME id and usage. Replace that message's estimate, never add it again.
    if (event.type === 'assistant') record.complete = true;
    else tracker.active.set(scope, id);
    tracker.finalCents = null;
    return;
  }
  if (!partial) return;
  const record = tracker.messages.get(tracker.active.get(scope));
  if (!record || record.complete) return;
  if (event.uuid) {
    if (tracker.seen.has(event.uuid)) return;
    tracker.seen.add(event.uuid);
  }
  if (partial.type === 'content_block_delta') {
    const delta = partial.delta || {};
    for (const key of ['text', 'thinking', 'partial_json']) {
      if (typeof delta[key] === 'string') record.characters += delta[key].length;
    }
  } else if (partial.type === 'message_delta') {
    mergeUsage(record, partial.usage);
    if (tokenCount(partial.usage?.output_tokens) !== null) record.complete = true;
  }
}

module.exports = { createTracker, observe, snapshot };
