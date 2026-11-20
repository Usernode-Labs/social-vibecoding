'use strict';

// One sort for every Homeroom bot turn that did not finish: whose failure
// was it?
//
//   credit    OpenRouter's credit ran out (a 402 for credit). An outage: it
//             is recorded once (openrouter-credit.js noteOutage), no try is
//             spent, the credit line is said, and the work is taken up again
//             where a resume exists.
//   platform  Homeroom or its provider failed under the turn: a provider's
//             5xx, a timeout, the network, a key that does not work, a
//             worker that ran out of memory or went away, a turn that could
//             not be dispatched, or the runtime's own "API Error" line where
//             an answer should be. No try is spent against the request or
//             the person; it is tried again after a wait, up to a cap, and
//             past the cap it is said in plain words as Homeroom's failure
//             and counted as an incident.
//   model     the turn ran and what it produced was not usable. A try.
//
// Before this module nine helpers each decided some of this (review B6, 19
// Nov 2026), and four turns had no platform class at all (review A2): a
// provider's 5xx spent one of a reply's two tries, handed a change's checks
// to a person, and counted toward the three failures that end a multi-day
// investigation. The lists below are the one source of the codes; the chat
// turn's own sets (what to ask again inside a turn, what to ask again later,
// which provider to leave out) are built from them in homeroom-bot-mayor.js.

// A model client's codes (openrouter.js, openrouter-mayor.js) for a provider
// or a transport that failed under the request.
const PROVIDER_CODES = Object.freeze([
  'timeout', 'network', 'provider_unavailable', 'provider_error', 'invalid_response', 'stream_error',
  'rate_limited', 'response_too_large',
]);
// The model's own shortfalls: it ran out of room, said nothing, or never
// called its reply tool. A later or larger try can get past each.
const MODEL_SHORT_CODES = Object.freeze(['output_limit', 'empty_answer', 'no_reply']);
// The bot's key: it has none, or the provider refuses it. Nothing a retry or
// the person can fix; an admin has to.
const KEY_CODES = Object.freeze(['no_key', 'key_unreadable', 'authentication', 'billing']);
// A routed coding turn that never ran: the worker could not be bootstrapped,
// the bot has no key or model, the ledger refused the turn.
const DISPATCH_CODES = Object.freeze([
  'backend_disabled', 'credential_required', 'model_required', 'invalid_base_url',
  'agent_context_changed', 'session_busy', 'ledger_start_failed', 'not_a_codex_session',
]);
// The Codex harness's own classification of a provider error
// (agents/codex-openrouter.js classifyProviderError).
const CREDIT_CODES = Object.freeze(['credit_out', 'insufficient_credits']);

const PROVIDER = new Set(PROVIDER_CODES);
const KEY = new Set(KEY_CODES);
const DISPATCH = new Set(DISPATCH_CODES);
const CREDIT = new Set(CREDIT_CODES);

const codeOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(v) ? v : null);

/** Pure: whether a routed turn's error code says the turn never ran (the platform's). */
function dispatchFailed(code) {
  const c = codeOf(code);
  return !!c && (DISPATCH.has(c) || c.startsWith('dispatch:'));
}

/**
 * Pure: whether the worker's own account of how a coding turn ended says the
 * platform or the provider ended it, and why (a short word for logs), or
 * null. Read from the result's own fields only: its process left no exit
 * marker (oom_killed, container_gone, ...), it could not be read at all (an
 * exit code below zero), the provider's own error code ended it, or the
 * runtime wrote its "API Error" notice where an answer should be.
 */
function turnPlatformCause(turn) {
  if (!turn || typeof turn !== 'object') return null;
  if (turn.markerlessCause) return String(turn.markerlessCause);
  const exit = Number(turn.exitCode);
  if (turn.exitCode != null && Number.isInteger(exit) && exit < 0) return 'no_result';
  if (turn.agentErrorCode) return String(turn.agentErrorCode);
  let api = null;
  try {
    api = require('./agent-result-text').agentApiFailure(turn.lastResultText);
  } catch { api = null; }
  return api ? 'api_error' : null;
}

/**
 * Pure: sort one failed turn. Give it what the caller really has, each in
 * its own field, so nothing a person or the model wrote is ever read as a
 * provider's words:
 *
 *   err           an error a model client threw ({ code, status });
 *   code          a routed turn's error code ('dispatch:...', 'session_busy');
 *   turn          the worker's result of a coding turn ({ agentErrorCode,
 *                 agentError, lastResultText, markerlessCause, exitCode,
 *                 providerErrorStatus, providerRequest });
 *   providerText  a provider's or the runtime's own error text (an HTTP
 *                 body, an "API Error: ..." line).
 *
 * Resolves { class: 'credit' | 'platform' | 'model', cause } where `cause`
 * is a short word for logs and records, never shown to people.
 */
function sort({ err = null, code = null, turn = null, providerText = null } = {}) {
  const credit = require('./openrouter-credit');
  const errCode = codeOf(err?.code);
  const routed = codeOf(code);
  if (CREDIT.has(errCode) || CREDIT.has(routed)
      || (turn && typeof turn === 'object' && credit.creditOut(turn))
      || (typeof providerText === 'string' && providerText.trim() && credit.creditOut(providerText))) {
    return { class: 'credit', cause: 'credit_out' };
  }
  if (errCode && (PROVIDER.has(errCode) || KEY.has(errCode))) return { class: 'platform', cause: errCode };
  if (dispatchFailed(routed)) return { class: 'platform', cause: routed };
  if (routed && (PROVIDER.has(routed) || KEY.has(routed))) return { class: 'platform', cause: routed };
  const cause = turnPlatformCause(turn);
  if (cause) return { class: 'platform', cause };
  if (typeof providerText === 'string' && providerText.trim()) return { class: 'platform', cause: 'api_error' };
  return { class: 'model', cause: errCode || routed || 'model' };
}

// ── What is said ───────────────────────────────────────────────────────
//
// The platform's own failure, in plain words, in the third person (a note on
// a request or a change, read by the group) and the first (the bot's own
// reply). Neither blames the request, the change or the person, and neither
// asks them to do anything but, at most, ask again.

/** Why a turn failed, as a clause, when Homeroom or its provider failed under it. */
const PLATFORM_WHY = 'Homeroom had a problem on its side, not with this change';

/** A reply the bot could not write because the platform failed, after its retries. */
const PLATFORM_REPLY_TEXT = 'I couldn\'t answer this because Homeroom had a problem on its side, not because of anything '
  + 'you wrote. The team has been told. Ask me again when you\'re ready.';

/**
 * Count one platform failure that outlasted its retries as an incident.
 * Never throws: an incident that cannot be written must not fail the turn it
 * is about.
 */
async function recordPlatformIncident(pool, { where, cause = null, detail = null } = {}, deps = {}) {
  try {
    const incidents = deps.incidents || require('./platform-incidents');
    await incidents.record(pool, {
      kind: incidents.KINDS.BOT_TURN_PLATFORM,
      appId: detail?.appId ?? null,
      sessionId: detail?.sessionId ?? null,
      detail: {
        // `why` is what the admin console lists.
        why: `${String(where || 'a turn').slice(0, 60)} failed on the platform${cause ? ` (${String(cause).slice(0, 80)})` : ''}`,
        where: String(where || 'turn').slice(0, 60),
        cause: cause ? String(cause).slice(0, 80) : null,
        ...(detail?.issueNumber != null ? { issueNumber: Number(detail.issueNumber) } : {}),
        ...(detail?.runId != null ? { runId: Number(detail.runId) } : {}),
      },
    });
  } catch (err) {
    require('./logger').warn('bot-turn-failure', 'Could not record a platform failure as an incident', { where, err: err.message });
  }
}

module.exports = {
  PROVIDER_CODES, MODEL_SHORT_CODES, KEY_CODES, DISPATCH_CODES, CREDIT_CODES,
  PLATFORM_WHY, PLATFORM_REPLY_TEXT,
  sort, dispatchFailed, turnPlatformCause, recordPlatformIncident,
};
