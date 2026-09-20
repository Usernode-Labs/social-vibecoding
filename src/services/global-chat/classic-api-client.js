'use strict';

// Authenticated bridge from a Global Chat capability to the exact platform
// route Classic already uses. The model never supplies a URL, HTTP method,
// header, or credential: it selects a server-owned capability id and provides
// only that capability's parameters. Original Express handlers remain the
// authorization, validation, rate-limit, and side-effect source of truth.

const inventory = require('./classic-inventory.generated.json');

const SESSION_RE = /^[a-f0-9]{64}$/;
const QUERY_NAME_RE = /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,63}$/;
const MAX_QUERY_ITEMS = 50;
const MAX_QUERY_VALUE_CHARS = 8_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// global-chat/store.js accepts a 256 KiB JSON model result. Keep a deliberate
// envelope margin for { ok, status, data } and future metadata instead of
// letting a sanitised response fail persistence a few bytes over the line.
const MAX_MODEL_RESULT_BYTES = 240 * 1024;
const MAX_MODEL_STRING_CHARS = 4_000;
const MAX_MODEL_ARRAY_ITEMS = 50;
const MAX_MODEL_OBJECT_KEYS = 80;
const MAX_MODEL_DEPTH = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const MODEL_SANITIZE_PROFILES = Object.freeze([
  Object.freeze({
    stringChars: MAX_MODEL_STRING_CHARS,
    arrayItems: MAX_MODEL_ARRAY_ITEMS,
    objectKeys: MAX_MODEL_OBJECT_KEYS,
    depth: MAX_MODEL_DEPTH,
  }),
  Object.freeze({ stringChars: 2_000, arrayItems: 25, objectKeys: 60, depth: 7 }),
  Object.freeze({ stringChars: 1_000, arrayItems: 12, objectKeys: 40, depth: 6 }),
  Object.freeze({ stringChars: 500, arrayItems: 6, objectKeys: 24, depth: 5 }),
  Object.freeze({ stringChars: 200, arrayItems: 3, objectKeys: 16, depth: 4 }),
  Object.freeze({ stringChars: 80, arrayItems: 1, objectKeys: 8, depth: 3 }),
]);

class ClassicApiClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClassicApiClientError';
    this.code = code;
    this.details = details;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sensitiveKey(value) {
  const key = String(value).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return key === 'token'
    || key.startsWith('tokenhint')
    || /^(?:access|refresh|session|auth).*token/.test(key)
    || key.includes('secret')
    || key.includes('password')
    || key.includes('passphrase')
    || key.includes('privatekey')
    || key.includes('credential')
    || key.includes('cookie')
    || key.includes('authorization');
}

function canonicalOrigin(value, field) {
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ClassicApiClientError('invalid_configuration', `${field} must be an HTTP(S) origin`);
  }
  return url.origin;
}

function routeParameters(template) {
  return [...String(template).matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
}

function buildPath(template, supplied) {
  const params = plainObject(supplied) ? supplied : {};
  const expected = routeParameters(template);
  const extra = Object.keys(params).filter((key) => !expected.includes(key));
  if (extra.length) {
    throw new ClassicApiClientError('invalid_input', `Unexpected path parameter: ${extra[0]}`);
  }
  let value = template;
  for (const name of expected) {
    const raw = params[name];
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      throw new ClassicApiClientError('invalid_input', `Missing path parameter: ${name}`);
    }
    const text = String(raw);
    if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new ClassicApiClientError('invalid_input', `Invalid path parameter: ${name}`);
    }
    value = value.replace(`:${name}`, encodeURIComponent(text));
  }
  if (/:([A-Za-z][A-Za-z0-9_]*)/.test(value)) {
    throw new ClassicApiClientError('invalid_input', 'Not all path parameters were provided');
  }
  return value;
}

function appendQuery(url, query) {
  if (query == null) return;
  if (!Array.isArray(query) || query.length > MAX_QUERY_ITEMS) {
    throw new ClassicApiClientError('invalid_input', `query must contain at most ${MAX_QUERY_ITEMS} entries`);
  }
  for (const item of query) {
    if (!plainObject(item) || Object.keys(item).some((key) => !['name', 'value'].includes(key))
        || typeof item.name !== 'string' || !QUERY_NAME_RE.test(item.name)
        || !['string', 'number', 'boolean'].includes(typeof item.value)
        || String(item.value).length > MAX_QUERY_VALUE_CHARS) {
      throw new ClassicApiClientError('invalid_input', 'Invalid query entry');
    }
    url.searchParams.append(item.name, String(item.value));
  }
}

function requestBody(method, value) {
  if (value == null) return null;
  if (method === 'GET') {
    throw new ClassicApiClientError('invalid_input', 'GET capabilities cannot send a request body');
  }
  let json;
  try { json = JSON.stringify(value); } catch { json = null; }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ClassicApiClientError('invalid_input', 'Capability request body is not valid bounded JSON');
  }
  return json;
}

async function boundedResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ClassicApiClientError('response_too_large', 'Classic returned too much data');
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ClassicApiClientError('response_too_large', 'Classic returned too much data');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function sanitizeForModel(value, depth = 0, limits = MODEL_SANITIZE_PROFILES[0]) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.length <= limits.stringChars
      ? value
      : `${value.slice(0, limits.stringChars)}… [truncated]`;
  }
  if (depth >= limits.depth) return '[nested data omitted]';
  if (Array.isArray(value)) {
    const result = value.slice(0, limits.arrayItems)
      .map((item) => sanitizeForModel(item, depth + 1, limits));
    if (value.length > limits.arrayItems) {
      result.push(`[${value.length - limits.arrayItems} more items]`);
    }
    return result;
  }
  if (!plainObject(value)) return String(value).slice(0, limits.stringChars);
  const result = {};
  const entries = Object.entries(value)
    .filter(([key]) => !sensitiveKey(key))
    .slice(0, limits.objectKeys);
  for (const [key, child] of entries) {
    result[key] = sanitizeForModel(child, depth + 1, limits);
  }
  if (Object.keys(value).length > limits.objectKeys) result._truncated = true;
  return result;
}

function boundedModelData(value, maxBytes = MAX_MODEL_RESULT_BYTES) {
  const limit = Math.max(1024, Math.min(MAX_MODEL_RESULT_BYTES, Number(maxBytes) || 0));
  for (const profile of MODEL_SANITIZE_PROFILES) {
    const candidate = sanitizeForModel(value, 0, profile);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= limit) return candidate;
  }
  return {
    _truncated: true,
    note: 'The platform result was too large to include in model context. Ask for a narrower result.',
  };
}

function defaultRoutes() {
  return inventory.routes.filter((route) => route.status === 'mapped');
}

class ClassicApiClient {
  constructor({
    baseUrl,
    browserOrigin,
    sessionToken,
    fetchImpl = globalThis.fetch,
    routes = defaultRoutes(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
  }) {
    this.baseUrl = canonicalOrigin(baseUrl, 'baseUrl');
    this.browserOrigin = canonicalOrigin(browserOrigin, 'browserOrigin');
    if (typeof sessionToken !== 'string' || !SESSION_RE.test(sessionToken)) {
      throw new ClassicApiClientError('invalid_session', 'A canonical session credential is required');
    }
    if (typeof fetchImpl !== 'function') {
      throw new ClassicApiClientError('invalid_configuration', 'fetchImpl must be a function');
    }
    this.sessionToken = sessionToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Math.min(60_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    this.maxResponseBytes = Math.max(1024, Math.min(MAX_RESPONSE_BYTES, Number(maxResponseBytes) || MAX_RESPONSE_BYTES));
    this.routes = new Map();
    for (const route of routes) {
      if (route.status === 'mapped' && route.transport === 'server_loopback') {
        this.routes.set(route.capabilityId, Object.freeze({
          capabilityId: route.capabilityId,
          method: route.method,
          path: route.path,
        }));
      }
    }
  }

  route(capabilityId) {
    return this.routes.get(capabilityId) || null;
  }

  async invoke(capabilityId, input = {}) {
    const route = this.routes.get(capabilityId);
    if (!route) {
      throw new ClassicApiClientError(
        'capability_not_callable',
        'That capability is not available through the Classic API bridge.',
        { capabilityId },
      );
    }
    if (!plainObject(input) || Object.keys(input).some(
      (key) => !['pathParameters', 'query', 'body'].includes(key),
    )) {
      throw new ClassicApiClientError('invalid_input', 'Capability input must be an exact object');
    }

    const path = buildPath(route.path, input.pathParameters);
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.baseUrl) {
      throw new ClassicApiClientError('invalid_input', 'Capability path left the platform origin');
    }
    appendQuery(url, input.query);
    const body = requestBody(route.method, input.body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: route.method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          cookie: `session=${this.sessionToken}`,
          origin: this.browserOrigin,
          'sec-fetch-site': 'same-origin',
          'x-global-chat-loopback': '1',
        },
        ...(body == null ? {} : {
          body,
          headers: {
            accept: 'application/json',
            cookie: `session=${this.sessionToken}`,
            origin: this.browserOrigin,
            'sec-fetch-site': 'same-origin',
            'x-global-chat-loopback': '1',
            'content-type': 'application/json',
          },
        }),
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new ClassicApiClientError(
        timedOut ? 'classic_timeout' : 'classic_unavailable',
        timedOut ? 'Classic took too long to respond.' : 'Classic could not be reached.',
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await boundedResponseText(response, this.maxResponseBytes);
    const contentType = String(response.headers?.get?.('content-type') || '');
    let parsed = null;
    if (text) {
      if (!/\b(?:application\/json|[^;]+\+json)\b/i.test(contentType)) {
        throw new ClassicApiClientError(
          'unexpected_classic_response',
          `Classic returned unsupported content for ${capabilityId}.`,
          { status: response.status },
        );
      }
      try { parsed = JSON.parse(text); } catch {
        throw new ClassicApiClientError(
          'invalid_classic_response',
          `Classic returned invalid JSON for ${capabilityId}.`,
          { status: response.status },
        );
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      authoritativeResult: parsed == null ? {} : parsed,
      modelResult: {
        ok: response.ok,
        status: response.status,
        untrusted: true,
        data: boundedModelData(parsed == null ? {} : parsed),
      },
    };
  }
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_MODEL_RESULT_BYTES,
  ClassicApiClient,
  ClassicApiClientError,
  appendQuery,
  boundedModelData,
  boundedResponseText,
  buildPath,
  canonicalOrigin,
  routeParameters,
  sanitizeForModel,
  sensitiveKey,
};
