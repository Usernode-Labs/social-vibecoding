'use strict';

// Fable 5 classifier-fallback bookkeeping (spec: "Adopt Claude Fable 5
// classifier-fallback handling in the platform's Anthropic calls").
//
// llm.streamChat opts Fable 5 requests into Anthropic's server-side
// fallback beta and reports back whether a turn was actually served by
// the fallback model (usage.iterations detection — the only reliable
// signal; sticky-served turns carry no `fallback` content block). This
// module holds the shared user-facing wording plus the admin record
// (log.warn → /status recent-events ring, and an `events` analytics row)
// so the chat handler, headless runner, and proposal-discuss don't
// duplicate them.

const log = require('./logger');
const models = require('./models');
const events = require('./events');

// Short human label for a model id ("Fable 5", "Opus 4.8"). Falls back
// to the raw id so an unknown slug still reads as something identifiable.
function label(modelId) {
  const entry = modelId && models.MODELS[modelId];
  return (entry && entry.label) || modelId || 'the selected model';
}

// In-chat notice for a turn that was served by the fallback model.
// `category` is stop_details.category when known ('cyber' | 'bio' |
// 'reasoning_extraction' | null) — omitted from the text when null
// (successful fallbacks usually don't carry one).
function noticeText(requested, served, category) {
  const cat = category ? ` (safety classifier: ${category})` : ' (safety classifier)';
  return `${label(requested)} declined part of this request${cat} — it was completed by ${label(served)}.`;
}

// In-chat notice for a whole-chain refusal (the fallback also declined,
// or couldn't run and the direct retry declined too).
function refusalText(requested, category) {
  const cat = category ? ` (safety classifier: ${category})` : '';
  return `${label(requested)}'s safety classifiers declined this request${cat} and the fallback couldn't complete it — try rephrasing or switching models.`;
}

// Durable admin record: one log.warn (visible in container logs and the
// admin /status recent-events feed) plus one analytics `events` row.
// Best-effort — events.record never rejects, and this must never break
// the turn that triggered it.
function record(pool, { kind, userId, appId, sessionId, requested, served, category, source }) {
  log.warn('llm', 'Fable 5 classifier fallback/refusal', {
    kind, sessionId: sessionId ?? null, userId: userId ?? null,
    requested, served, category: category ?? null, source,
  });
  return events.record(pool, {
    type: kind,
    userId,
    appId,
    sessionId,
    metadata: { requested, served, category: category ?? null, source },
  });
}

module.exports = { label, noticeText, refusalText, record };
