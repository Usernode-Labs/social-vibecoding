'use strict';

const dns = require('node:dns');
const net = require('node:net');
const log = require('./logger');

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 1_000;

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const unwrapped = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  const normalized = unwrapped.replace(/^::ffff:/, '');
  return net.isIP(normalized) ? normalized : '';
}

function socketIp(req) {
  return normalizeIp(req.socket?.remoteAddress || '');
}

function clientIp(req) {
  return normalizeIp(req.clientIp || '') || socketIp(req);
}

// Is this address on a private network? Loopback, plus the three RFC1918
// ranges — Docker bridge networks land in 172.16.0.0/12 by default, and
// user-defined networks can also use 10/8 or 192.168/16.
//
// #2506: this lived twice, character for character, in internal-auth.js and
// anthropic-proxy-auth.js. Two copies of a security predicate is a hazard in
// itself — a fix to one is invisible to the other — so it lives here now and
// both import it.
function isPrivateIp(ip) {
  if (!ip) return false;
  // Normalize IPv6-mapped IPv4 (`::ffff:172.18.0.5` -> `172.18.0.5`).
  const v4 = String(ip).replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || v4 === '::1') return true;
  if (/^10\./.test(v4)) return true;
  if (/^192\.168\./.test(v4)) return true;
  const m = v4.match(/^172\.(\d+)\./);
  if (m) {
    const oct = parseInt(m[1], 10);
    return oct >= 16 && oct <= 31;
  }
  return false;
}

// Headers a proxy hop adds. Their PRESENCE is the signal, not their value:
// a genuine server-to-server call carries none (see trustedProxyClientIp
// below — "their normal internal calls carry no forwarding header").
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
];

// Did this request come DIRECTLY from inside, with no proxy in front?
//
// #2506: the four server-to-server gates used to ask
// `isPrivateIp(clientIp(req))`, which is sound only while `clientIp` returns
// the real originator. It does not always. `trustedProxyClientIp` resolves
// the trusted proxy by DNS and, on a lookup failure, empties
// `trustedAddresses` and falls back to the SOCKET PEER. That is genuinely
// fail-closed for the rate limiters — grouping callers under one key only
// over-counts — but it is fail OPEN here, because the address it falls back
// to is the ingress's, and the ingress lives on a private network. DNS
// blips, an external request arrives through Caddy, and the gate sees
// `172.18.0.9` and says yes.
//
// Kubernetes mode reaches the same place without any DNS failure:
// `trustDirectPeer` trusts every peer to supply a forwarding header (the
// TODO below).
//
// So ask the real question instead. Two conditions, and the second is what
// makes it independent of whatever DNS managed to resolve:
//
//   1. the SOCKET PEER is private — deliberately not `clientIp`, which is a
//      value a forwarding header can set;
//   2. the request carries NO forwarding header, so nothing proxied it.
function isDirectInternalCall(req) {
  if (!req) return false;
  const headers = req.headers || {};
  for (const name of FORWARDING_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) return false;
    if (Array.isArray(value) && value.length) return false;
  }
  return isPrivateIp(socketIp(req));
}

function forwardedClientIp(req) {
  const value = req.headers['x-forwarded-for'];
  // Caddy replaces untrusted incoming X-Forwarded-For and sends one client
  // address. Reject ambiguous/malformed values rather than choosing one.
  if (typeof value !== 'string' || value.includes(',')) return '';
  return normalizeIp(value.trim());
}

function trustedProxyClientIp({
  hostname = '',
  trustDirectPeer = false,
  lookup = dns.promises.lookup,
  refreshMs = DEFAULT_REFRESH_MS,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
} = {}) {
  let trustedAddresses = new Set();
  let refreshAfter = 0;
  let refreshPromise = null;

  async function refresh() {
    if (!hostname) return;
    if (!refreshPromise) {
      let timeout;
      const lookupPromise = Promise.resolve()
        .then(() => lookup(hostname, { all: true }));
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('trusted proxy lookup timed out')),
          lookupTimeoutMs
        );
        timeout.unref?.();
      });
      refreshPromise = Promise.race([lookupPromise, timeoutPromise])
        .then((records) => {
          trustedAddresses = new Set(
            (Array.isArray(records) ? records : [records])
              .map((record) => normalizeIp(record?.address || ''))
              .filter(Boolean)
          );
        })
        .catch((err) => {
          // Fail closed to the socket peer. This can temporarily group
          // external callers under Caddy's address, but never trusts a
          // child-provided forwarding header.
          trustedAddresses = new Set();
          log.warn('client-ip', 'Trusted proxy resolution failed', {
            hostname,
            message: err.message,
          });
        })
        .finally(() => {
          clearTimeout(timeout);
          refreshAfter = Date.now() + refreshMs;
          refreshPromise = null;
        });
    }
    await refreshPromise;
  }

  return async (req, _res, next) => {
    if (hostname && Date.now() >= refreshAfter) await refresh();
    const peer = socketIp(req);
    // In Kubernetes this enables the ingress controller's forwarded address
    // without resolving a proxy hostname (and without a Caddy sidecar).
    // NetworkPolicy limits other direct peers to the app/worker namespaces;
    // their normal internal calls carry no forwarding header.
    // TODO: before opening the platform to untrusted app authors, split the
    // ingress and internal listeners (or authenticate the proxy hop) so a
    // generated app cannot deliberately forge a single forwarding header.
    const trustedPeer = trustedAddresses.has(peer) || (trustDirectPeer && Boolean(peer));
    const forwarded = trustedPeer ? forwardedClientIp(req) : '';
    req.clientIp = forwarded || peer;
    next();
  };
}

module.exports = {
  normalizeIp,
  socketIp,
  clientIp,
  isPrivateIp,
  isDirectInternalCall,
  FORWARDING_HEADERS,
  forwardedClientIp,
  trustedProxyClientIp,
};
