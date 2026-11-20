'use strict';

// One reading of a model provider's HTTP refusal, for both OpenRouter
// clients (openrouter.js, which the chat, the thread voice and the helpers
// call, and openrouter-mayor.js).
//
// Each client kept its own copy of the status table, and only one of them
// told OpenRouter's two 402s apart. So the chat's and the voice's outage
// handling, which looks for `credit_out`, could not be reached: their client
// said `billing` (review A1, 19 Nov 2026). The table and that reading live
// here once.

/** Pure: an HTTP status as the code a caller branches on. */
function providerErrorCode(status) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_request';
}

// The most of a refusal's body that is read to tell the two 402s apart.
const MAX_REFUSAL_CHARS = 2000;

/**
 * Pure: the code of a refused request. A 402 is out of credit
 * (`credit_out`), unless its body asks only for a shorter reply ("requires
 * more credits, or fewer max_tokens"), which stays the key's `billing`
 * refusal: a smaller request gets through. openrouter-credit.js creditOut is
 * the one classifier; `body` is the provider's own text, never a person's.
 */
function refusalCode(status, body = '') {
  const text = String(body == null ? '' : body).slice(0, MAX_REFUSAL_CHARS);
  if (status === 402 && require('./openrouter-credit').creditOut({ status, body: text })) return 'credit_out';
  return providerErrorCode(status);
}

/**
 * Pure: the code of an error a 200 response carried in its body
 * (`{ error: { code, message } }`), or null when it names no HTTP status.
 */
function bodyErrorCode(error) {
  const status = Number(error?.code);
  if (!Number.isInteger(status)) return null;
  return refusalCode(status, typeof error?.message === 'string' ? error.message : '');
}

module.exports = { MAX_REFUSAL_CHARS, providerErrorCode, refusalCode, bodyErrorCode };
