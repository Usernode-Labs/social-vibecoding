'use strict';

const MAX_RESPONSE_BYTES = 64 * 1024;
const { parseStrictJson } = require('../services/cli-auth');

class CliHttpError extends Error {
  constructor(message, { code = 'network_error', status = null, retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function retryAfterSeconds(value) {
  if (typeof value !== 'string') return null;
  if (/^[0-9]+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function readLimitedJson(response, maxResponseBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    throw new CliHttpError('Server response exceeded the size limit', {
      code: 'protocol_error',
      status: response.status,
    });
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new CliHttpError('Server response exceeded the size limit', {
          code: 'protocol_error',
          status: response.status,
        });
      }
      chunks.push(value);
    }
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  if (!body) return null;
  try {
    return parseStrictJson(body);
  } catch {
    throw new CliHttpError('Server returned malformed JSON', {
      code: 'protocol_error',
      status: response.status,
    });
  }
}

async function requestJson(origin, pathname, {
  method = 'GET',
  body,
  token,
  deadlineMs = 30000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin) throw new CliHttpError('Refusing cross-origin request', {
    code: 'configuration_error',
  });
  const controller = new AbortController();
  let connected = false;
  const connectTimer = setTimeout(() => {
    if (!connected) controller.abort(new Error('connect timeout'));
  }, Math.min(10000, deadlineMs));
  const totalTimer = setTimeout(() => controller.abort(new Error('request timeout')), deadlineMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    connected = true;
    clearTimeout(connectTimer);
    if (response.status >= 300 && response.status < 400) {
      throw new CliHttpError('Server redirects are not allowed', {
        code: 'redirect_error',
        status: response.status,
      });
    }
    const data = response.status === 204
      ? null
      : await readLimitedJson(response, maxResponseBytes);
    return {
      ok: response.ok,
      status: response.status,
      data,
      retryAfter: retryAfterSeconds(response.headers.get('retry-after')),
    };
  } catch (err) {
    if (err instanceof CliHttpError) throw err;
    const causeCode = err?.cause?.code || err?.code;
    const tlsCodes = new Set([
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ]);
    if (tlsCodes.has(causeCode)
        || (typeof causeCode === 'string'
          && /(?:CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY)/.test(causeCode))) {
      throw new CliHttpError('Server TLS validation failed', {
        code: 'tls_validation_error',
      });
    }
    const message = err.name === 'AbortError'
      ? 'Server request timed out'
      : 'Server is unreachable';
    throw new CliHttpError(message, { code: 'network_error' });
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
  }
}

module.exports = {
  MAX_RESPONSE_BYTES,
  CliHttpError,
  retryAfterSeconds,
  readLimitedJson,
  requestJson,
};
