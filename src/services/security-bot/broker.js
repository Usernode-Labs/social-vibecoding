'use strict';

// The security bot's only way to reach an arena target (#4678). Every probe
// request goes through one broker instance, pinned to a SINGLE fixed origin at
// construction, so no probe can ever aim traffic anywhere else:
//
//   * paths are relative only. An absolute URL, a protocol-relative `//host`,
//     a URL with userinfo (`user:pass@`), a backslash, whitespace or a control
//     character, or any `..`/encoded-traversal segment is refused before a
//     socket is opened. The resolved URL's origin must equal the pinned one.
//   * redirects are never followed. A 3xx is returned to the caller as-is; the
//     broker opens exactly one connection per request.
//   * the caller cannot set Host, the forwarding headers (X-Forwarded-*,
//     Forwarded, X-Real-IP, Via, True-Client-IP, CF-Connecting-IP) or any
//     hop-by-hop header. An attempt to is refused, never silently stripped,
//     so a probe cannot smuggle a spoofed origin past the target's own edge.
//   * identities are applied BY REFERENCE. The caller names a synthetic arena
//     identity; the broker resolves it against the CURRENT run record each
//     time (capabilities not revoked, generation unchanged) and never trusts a
//     cached grant. A revoked campaign cannot keep probing.
//
// Before each external action the broker asserts dispatch is still permitted
// (service enabled, lease live, deadline unexpired) and counts the physical
// request through the run's target-request ceiling. It bounds concurrency to
// the run's max_parallel_requests. It does no model work and holds no secret.

const runsModule = require('./runs');

class BrokerError extends Error {
  constructor(code) {
    super(`Security bot broker: ${code}`);
    this.name = 'SecurityBotBrokerError';
    this.code = code;
  }
}

// Headers a caller may never set: the target's own edge derives the client's
// origin from these, so a probe that set one could impersonate another caller
// or bypass an origin check. Compared case-insensitively.
const FORBIDDEN_HEADERS = new Set([
  'host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-port', 'x-forwarded-server', 'forwarded', 'x-real-ip',
  'via', 'true-client-ip', 'cf-connecting-ip', 'x-client-ip',
  'proxy-authorization', 'connection', 'keep-alive', 'upgrade',
  'transfer-encoding', 'te', 'trailer', 'proxy-connection',
  // The identity is applied by reference only; a caller-supplied credential or
  // cookie is never forwarded.
  'x-usernode-token', 'authorization', 'cookie',
]);

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// A relative request target: one leading slash, never `//` (protocol-relative),
// no scheme, no userinfo, no backslash, no whitespace or control character, and
// no `.`/`..` path segment in raw or percent-encoded form. The origin is added
// by the broker, so the caller never names a host.
function safePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new BrokerError('invalid_path');
  }
  if (path[0] !== '/' || path[1] === '/' || path[1] === '\\') throw new BrokerError('invalid_path');
  // Reject control chars, whitespace, backslash, and a userinfo `@` or scheme
  // `:` appearing before the first `/` segment boundary would already be caught
  // by the leading-slash rule, but a backslash or `@` anywhere is suspicious.
  if (/[\u0000- \u007f\\]/.test(path)) throw new BrokerError('invalid_path');
  if (path.includes('@')) throw new BrokerError('invalid_path');
  const [rawPathname] = path.split(/[?#]/, 1);
  // Catch `..` and `.` in raw and the common percent-encodings (%2e, %2E).
  const decodedOnce = rawPathname.replace(/%2e/gi, '.').replace(/%2f/gi, '/');
  for (const segment of decodedOnce.split('/')) {
    if (segment === '..' || segment === '.') throw new BrokerError('path_traversal');
  }
  return path;
}

// A bounded first-in semaphore so concurrency can never exceed the run's
// max_parallel_requests, however many probes race.
function semaphore(limit) {
  let active = 0;
  const waiters = [];
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) { active += 1; next(); }
  };
  return {
    acquire() {
      if (active < limit) { active += 1; return Promise.resolve(release); }
      return new Promise((resolve) => waiters.push(() => resolve(release)));
    },
  };
}

/**
 * One broker, pinned to a single arena origin for a single run lease.
 *
 *   origin           the arena's fixed base URL, e.g. http://arena-host:3000
 *   pool, lease      the run's pool and current lease (for dispatch gating and
 *                    request counting through runs.js)
 *   maxParallel      concurrency ceiling (run.limits_snapshot.max_parallel_requests)
 *   resolveIdentity  async (identityRef, run) => ({ headers }) — resolves a
 *                    synthetic arena identity BY REFERENCE against the current
 *                    run record. Must throw if the capability is revoked.
 *   fetchImpl        injected for tests; defaults to global fetch.
 *   runs             injected for tests; defaults to the runs module.
 */
function createBroker({
  origin, pool, lease, maxParallel, resolveIdentity,
  fetchImpl = globalThis.fetch, runs = runsModule,
} = {}) {
  if (typeof origin !== 'string') throw new BrokerError('invalid_origin');
  let base;
  try { base = new URL(origin); } catch { throw new BrokerError('invalid_origin'); }
  if (!['http:', 'https:'].includes(base.protocol) || !base.hostname
      || base.username || base.password || (base.pathname && base.pathname !== '/')
      || base.search || base.hash) {
    throw new BrokerError('invalid_origin');
  }
  const pinnedOrigin = base.origin;
  if (typeof resolveIdentity !== 'function') throw new BrokerError('identity_resolver_required');
  const limit = Number.isSafeInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 64
    ? maxParallel : 1;
  const gate = semaphore(limit);

  function buildHeaders(callerHeaders, identityHeaders) {
    const headers = {};
    for (const [name, value] of Object.entries(callerHeaders || {})) {
      const lower = String(name).toLowerCase();
      if (FORBIDDEN_HEADERS.has(lower)) throw new BrokerError('forbidden_header');
      if (!/^[\w-]+$/.test(name) || /[\r\n\u0000]/.test(String(value))) throw new BrokerError('invalid_header');
      headers[lower] = String(value);
    }
    // Identity headers are applied last and are the only source of credentials.
    for (const [name, value] of Object.entries(identityHeaders || {})) {
      headers[String(name).toLowerCase()] = String(value);
    }
    return headers;
  }

  async function request(path, {
    method = 'GET', headers: callerHeaders = {}, body = undefined,
    identityRef, signal,
  } = {}) {
    const verb = String(method).toUpperCase();
    if (!METHODS.has(verb)) throw new BrokerError('invalid_method');
    const target = safePath(path);

    // The resolved URL must land on the pinned origin and nowhere else. The
    // URL parser collapses remaining tricks (`/..%2f`, overlong encodings);
    // a mismatch here is a final backstop against an escape past safePath.
    const url = new URL(target, pinnedOrigin);
    if (url.origin !== pinnedOrigin || url.username || url.password) {
      throw new BrokerError('origin_escape');
    }

    const release = await gate.acquire();
    try {
      // Re-validate the lease (service enabled, not cancelled, within deadline)
      // immediately before counting and dispatching, and resolve the identity
      // against that same current record — never a cached grant.
      const run = await runs.assertCanDispatch(pool, lease);
      if (run.capabilities_revoked_at) throw new BrokerError('capabilities_revoked');
      const identity = await resolveIdentity(identityRef, run);
      if (!identity || typeof identity !== 'object') throw new BrokerError('identity_unresolved');
      const headers = buildHeaders(callerHeaders, identity.headers);

      // Count the physical request against the run's ceiling BEFORE the socket
      // opens: a request that would exceed max_target_requests never leaves.
      await runs.admitTargetRequest(pool, lease);

      const response = await fetchImpl(url.toString(), {
        method: verb,
        headers,
        body: verb === 'GET' || verb === 'HEAD' ? undefined : body,
        // One connection, one response. A redirect is surfaced, never chased.
        redirect: 'manual',
        signal,
      });
      return response;
    } finally {
      release();
    }
  }

  return { origin: pinnedOrigin, maxParallel: limit, request };
}

module.exports = { createBroker, safePath, BrokerError, FORBIDDEN_HEADERS };
