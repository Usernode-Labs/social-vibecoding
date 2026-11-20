'use strict';

// Claude's Messages API, served through OpenRouter (task 2275).
//
// Homeroom used to hold a separate Anthropic key and send three kinds of
// traffic to api.anthropic.com with it: the short housekeeping calls in
// llm.js (titles, summaries, translation, the Workshop's themes...), the
// Claude Code turns behind before & after shots and Sync with main (the
// worker relay, routes/anthropic-proxy.js), and the apps' own AI calls (the
// app relay, routes/app-llm-proxy.js). All three now go to OpenRouter's
// Anthropic-compatible endpoint, `${OPENROUTER_API_BASE}/messages`, which
// takes and returns the same request and response shapes (the Claude Code
// harness's worker listener, worker/claude-openrouter-request.js, has used
// it since #3296). What changes on the way:
//
//   the model   a Claude id as the platform writes it ('claude-sonnet-5-5')
//               becomes OpenRouter's ('anthropic/claude-sonnet-5.5');
//               anything that is not a Claude model is refused, so the
//               relays stay the Claude Messages contract they always were.
//   the key     the platform's existing OpenRouter key, the Homeroom bot's
//               included key that the helpers (llm.js) and small changes
//               already send platform traffic on. It never leaves this
//               process.
//   routing     every body denies data collection (worker/openrouter-
//               privacy.js, #5123), over whatever a caller asked for.

const log = require('./logger');
const { platformHeaders } = require('./openrouter-client');
const { withNoTraining } = require('../../worker/openrouter-privacy');

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Whose key the platform's own model calls are paid with (llm.js helpers,
// small-change.js, openrouter-credit.js all read the same one).
const PLATFORM_KEY_USERNAME = 'homeroom_bot';
// How long a read of that key is reused: one query and one decrypt a minute,
// not one per call (the feedback title preview fires as people type).
const PLATFORM_KEY_TTL_MS = 60 * 1000;

// The two Messages routes a caller may reach, by the path a Claude client
// sends (the SDK and Claude Code put `/v1` in front) and OpenRouter's own.
const MESSAGES_ROUTES = new Map([
  ['/v1/messages', '/messages'],
  ['/v1/messages/count_tokens', '/messages/count_tokens'],
]);

/**
 * Pure: OpenRouter's id for a Claude model, or null when `model` is not one.
 *
 *   claude-sonnet-5-5            -> anthropic/claude-sonnet-5.5
 *   claude-haiku-4-5-20251001    -> anthropic/claude-haiku-4.5
 *   claude-opus-5                -> anthropic/claude-opus-5
 *   claude-3-5-haiku-latest      -> anthropic/claude-3.5-haiku
 *   claude-sonnet-5-5[1m]        -> anthropic/claude-sonnet-5.5
 *   anthropic/claude-sonnet-5.5  -> unchanged
 */
function toOpenRouterModel(model) {
  if (typeof model !== 'string') return null;
  const id = model.trim().replace(/\[[^\]]*\]$/, '').toLowerCase();
  if (/^anthropic\/claude-[a-z0-9.-]+$/.test(id)) return id;
  const m = id.match(/^claude-([a-z0-9-]+?)(?:-\d{8})?(?:-latest)?$/);
  if (!m) return null;
  const rest = m[1];
  // Current naming: claude-<family>-<major>[-<minor>].
  let parts = rest.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (parts) {
    const [, family, major, minor] = parts;
    return `anthropic/claude-${family}-${major}${minor != null ? `.${minor}` : ''}`;
  }
  // The older naming: claude-<major>[-<minor>]-<family>.
  parts = rest.match(/^(\d+)(?:-(\d+))?-([a-z]+)$/);
  if (parts) {
    const [, major, minor, family] = parts;
    return `anthropic/claude-${major}${minor != null ? `.${minor}` : ''}-${family}`;
  }
  return null;
}

/**
 * Pure: the platform's own spelling of an OpenRouter Claude id
 * ('anthropic/claude-sonnet-5.5' -> 'claude-sonnet-5-5'), for the price
 * table in llm.js estimateCostCents; anything else comes back unchanged.
 */
function fromOpenRouterModel(model) {
  if (typeof model !== 'string') return model;
  const m = model.trim().match(/^anthropic\/(claude-[a-z0-9.-]+)$/i);
  return m ? m[1].toLowerCase().replace(/\./g, '-') : model;
}

function isClaudeModel(model) {
  return toOpenRouterModel(model) != null;
}

function apiBase(baseUrl) {
  return String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

/** Pure: the OpenRouter URL for a Claude client's path, or null for any other path. */
function upstreamUrlFor(baseUrl, clientPath) {
  const pathname = String(clientPath || '').split('?')[0].replace(/\/+$/, '');
  const route = MESSAGES_ROUTES.get(pathname);
  return route ? `${apiBase(baseUrl)}${route}` : null;
}

class MessagesRequestError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'MessagesRequestError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Pure: the body sent upstream. The model becomes OpenRouter's id (a model
 * that is not Claude is refused: `unsupported_model`), and the provider
 * routing denies data collection over anything the caller sent.
 */
function requestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MessagesRequestError('invalid_request', 'A Messages request body is a JSON object');
  }
  const model = toOpenRouterModel(body.model);
  if (!model) {
    throw new MessagesRequestError('unsupported_model', 'Only Claude models are served here');
  }
  return withNoTraining({ ...body, model });
}

// Request headers a Claude client sends that mean something upstream. Its
// own credentials (x-api-key, a bearer token, x-usernode-*) and everything
// else stay here.
const FORWARDED_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta'];

/** Pure: the headers for one upstream request on `apiKey`. */
function upstreamHeaders(reqHeaders, apiKey, origin) {
  const headers = {
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    authorization: `Bearer ${apiKey}`,
    ...platformHeaders(origin),
  };
  for (const name of FORWARDED_HEADERS) {
    const value = reqHeaders && reqHeaders[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  return headers;
}

// ── The platform's key ────────────────────────────────────────────────

let keyCache = null; // { key, at }
let keyOverride; // tests: undefined = read normally

/**
 * The platform's OpenRouter key (the Homeroom bot's included key), or null
 * when there is none to read: no bot yet, no stored key, no data key, or a
 * read that failed. Never throws.
 */
async function platformKey(config, { pool = null } = {}) {
  if (keyOverride !== undefined) return keyOverride;
  if (!config || !config.dataEncryptionKey) return null;
  if (keyCache && Date.now() - keyCache.at < PLATFORM_KEY_TTL_MS) return keyCache.key;
  let key = null;
  try {
    const db = pool || require('../db/pool').getPool(config);
    const { rows } = await db.query(
      'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [PLATFORM_KEY_USERNAME],
    );
    if (rows[0]) {
      key = await require('./credential-store').readSecret({
        pool: db, userId: rows[0].id, provider: 'openrouter', purpose: 'coding_agent',
        dataKey: config.dataEncryptionKey,
      });
    }
  } catch (err) {
    log.warn('openrouter-messages', 'Platform OpenRouter key unreadable', { err: err.message });
  }
  keyCache = { key: key || null, at: Date.now() };
  return keyCache.key;
}

/** True while the last read found no platform key (until it is read again). */
function platformKeyMissing() {
  if (keyOverride !== undefined) return !keyOverride;
  return !!(keyCache && !keyCache.key && Date.now() - keyCache.at < PLATFORM_KEY_TTL_MS);
}

function forgetPlatformKey() {
  keyCache = null;
}

// ── One call ──────────────────────────────────────────────────────────

function providerErrorMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  } catch { /* not JSON */ }
  return `OpenRouter answered ${status}`;
}

/**
 * One non-streaming Messages call. Resolves the provider's JSON message
 * (content, stop_reason, usage, model). Throws an Error with `status` on a
 * refusal (402 is OpenRouter's "out of credit", `code` 'credit_out'), a
 * timeout or a network failure; an abort keeps its AbortError name.
 */
async function createMessage({
  apiKey, baseUrl, origin, params, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw Object.assign(new Error('No platform OpenRouter key is configured'), { code: 'no_platform_key', status: 503 });
  }
  const body = requestBody({ ...params, stream: false });
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs);
  timeout.unref?.();
  let res;
  try {
    res = await fetchImpl(`${apiBase(baseUrl)}/messages`, {
      method: 'POST',
      headers: upstreamHeaders({}, apiKey, origin),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (signal && signal.aborted) {
      const abort = new Error('Request cancelled');
      abort.name = 'AbortError';
      throw abort;
    }
    if (timer.signal.aborted) throw Object.assign(new Error('OpenRouter did not answer in time'), { code: 'ETIMEDOUT', status: 408 });
    throw Object.assign(new Error(`OpenRouter unreachable: ${err.message}`), { code: err.code || 'ECONNRESET' });
  }
  let text;
  try {
    text = await res.text();
  } finally {
    clearTimeout(timeout);
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('OpenRouter answer too large'), { status: 502 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(providerErrorMessage(text, res.status)), {
      status: res.status,
      ...(res.status === 402 ? { code: 'credit_out' } : {}),
    });
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('OpenRouter answered with something that is not JSON'), { status: 502 });
  }
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
    throw Object.assign(new Error(providerErrorMessage(text, res.status)), { status: 502 });
  }
  return message;
}

/**
 * A client with the `messages.create(params, options)` surface llm.js was
 * written against, bound to the platform's key. `options.signal` cancels a
 * call and `options.timeout` (ms) bounds it.
 */
function platformClient(config) {
  return clientWith(config, () => platformKey(config), platformKeyMissing);
}

/**
 * The same client on a key the caller holds: a person's machine running
 * scripts/language-sync.js with OPENROUTER_API_KEY set. Never the platform.
 */
function keyClient({ apiKey, openrouterApiBase = null, openrouterOrigin = null }) {
  return clientWith({ openrouterApiBase, openrouterOrigin }, async () => apiKey, () => !apiKey);
}

function clientWith(config, keyFor, keyMissing) {
  return {
    keyMissing,
    messages: {
      async create(params, options = {}) {
        const apiKey = await keyFor();
        return createMessage({
          apiKey,
          baseUrl: config && config.openrouterApiBase,
          origin: config && config.openrouterOrigin,
          params,
          signal: options && options.signal ? options.signal : null,
          timeoutMs: options && Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS,
        });
      },
    },
  };
}

// Test hook: a fixed platform key (a string, or null for none); undefined
// reads it normally again. Returns the previous override.
function _setPlatformKeyForTests(key) {
  const prev = keyOverride;
  keyOverride = key;
  keyCache = null;
  return prev;
}

module.exports = {
  DEFAULT_BASE,
  MESSAGES_ROUTES,
  PLATFORM_KEY_USERNAME,
  MessagesRequestError,
  toOpenRouterModel,
  fromOpenRouterModel,
  isClaudeModel,
  upstreamUrlFor,
  requestBody,
  upstreamHeaders,
  platformKey,
  platformKeyMissing,
  forgetPlatformKey,
  createMessage,
  platformClient,
  keyClient,
  _setPlatformKeyForTests,
};
