// Trusted-integrator credential for the public waitlist join endpoint.
//
// The join POST is rate-limited per IP (5 / 15 min), which is the only
// thing standing between an anonymous write endpoint and bulk email
// harvesting. That budget breaks down for exactly one caller shape: an
// agency landing page that proxies signups server-to-server, so every
// visitor it sends arrives as ONE address.
//
// It cannot avoid that. Express trusts no forwarding header of its own
// (server.js sets `trust proxy` false) and only the configured Caddy peer
// may supply one, so a proxy upstream of Caddy is invisible — and the
// public API sends no CORS headers, so calling it from the visitor's own
// browser is not an available shape either.
//
// So: an optional shared secret re-keys that caller's budget to its own
// identity instead of to an address. Note what this deliberately is NOT:
//   - It is not an exemption. A leaked key would otherwise be an
//     unbounded faucet on the platform's only anonymous write; a keyed
//     caller gets a much larger ceiling, not an unlimited one.
//   - It is not required. Unset means the feature is off and every caller
//     is anonymous — unlike topochainPartnerApiKey, an unconfigured value
//     here must never 500, because this endpoint is genuinely public and
//     works fine without a key.
//
// A keyed caller may additionally pass the end user's own address in
// X-Waitlist-Client-IP. That is honoured ONLY after the secret matched,
// and is used for two things: keeping a per-visitor sub-budget so one bad
// actor cannot spam the list through the integrator, and recording the
// real address in waitlist_signups.ip (which today stores the proxy for
// every proxied signup).
'use strict';

const crypto = require('crypto');
const log = require('./logger');
const { normalizeIp } = require('./client-ip');

const KEY_HEADER = 'x-waitlist-client-key';
const CLIENT_IP_HEADER = 'x-waitlist-client-ip';

// A label is what shows up in throttle logs and in the rate-limit key, so
// keep it boring and short. The secret is everything after the FIRST
// colon, so a base64 secret containing ':' survives.
function parseIntegrationKeys(raw) {
  const out = [];
  if (typeof raw !== 'string' || !raw.trim()) return out;
  for (const chunk of raw.split(',')) {
    const entry = chunk.trim();
    if (!entry) continue;
    const idx = entry.indexOf(':');
    if (idx <= 0) {
      log.warn('waitlist-integrator', 'Ignoring malformed WAITLIST_INTEGRATION_KEYS entry', {});
      continue;
    }
    const label = entry.slice(0, idx).trim();
    const secret = entry.slice(idx + 1).trim();
    if (!label || !secret || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(label)) {
      log.warn('waitlist-integrator', 'Ignoring malformed WAITLIST_INTEGRATION_KEYS entry', {});
      continue;
    }
    out.push({ label, digest: crypto.createHash('sha256').update(secret).digest() });
  }
  return out;
}

// Compare over SHA-256 digests rather than the raw strings: timingSafeEqual
// throws on a length mismatch, which would leak the secret's length, and
// hashing first makes both sides a fixed 32 bytes.
function matchIntegrator(entries, presented) {
  if (!Array.isArray(entries) || !entries.length) return null;
  if (typeof presented !== 'string' || !presented) return null;
  const digest = crypto.createHash('sha256').update(presented).digest();
  let found = null;
  // No early return: every configured key is compared on every request so
  // the work does not depend on which one (if any) matched.
  for (const entry of entries) {
    if (crypto.timingSafeEqual(digest, entry.digest)) found = entry;
  }
  return found ? { label: found.label } : null;
}

// Express middleware. NEVER responds — a missing or wrong key simply means
// the request stays anonymous and gets the ordinary public budget.
function waitlistIntegratorAuth(config) {
  const entries = parseIntegrationKeys(config?.waitlistIntegrationKeys);
  return (req, _res, next) => {
    const matched = matchIntegrator(entries, req.headers[KEY_HEADER]);
    if (matched) {
      req.waitlistIntegrator = matched;
      // Only trusted after the secret matched, and only ever a validated
      // address. It does not touch req.clientIp: the socket peer stays the
      // truth for everything else the request does.
      const forwarded = normalizeIp(
        typeof req.headers[CLIENT_IP_HEADER] === 'string' ? req.headers[CLIENT_IP_HEADER].trim() : ''
      );
      if (forwarded) req.waitlistEndUserIp = forwarded;
    }
    next();
  };
}

module.exports = {
  KEY_HEADER,
  CLIENT_IP_HEADER,
  parseIntegrationKeys,
  matchIntegrator,
  waitlistIntegratorAuth,
};
