// Hostname helpers for the platform's public URLs, plus the TLS edge probe.
//
// Routing + TLS are handled entirely by Caddy (see Caddyfile). ONE wildcard
// cert covers `*.<domain>` (plus the apex), issued once via the ACME DNS-01
// challenge against the self-hosted acme-dns. There is no on-demand,
// per-hostname issuance any more — no `on_demand_tls`, no `ask` gate — so a
// brand-new preview hostname is served instantly by a cert that already
// exists. The platform doesn't write per-host route blocks or run `caddy
// reload` either; the hostname maps to a container name deterministically.
// These two builders are the single source of truth for the hostnames the
// Caddy `map` expects to see.

const https = require('https');
const log = require('./logger');

const USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';

// Bound on a single edge probe (#767).
//
// The old value was 120000 — sized for the on-demand ZeroSSL era, when the
// first hit on a new hostname blocked on a 60-90s (sometimes 3-8 min)
// authorization. With one pre-existing wildcard cert there is nothing to
// issue: production probes measure 10ms - 2.1s. 15s is ~7x the observed
// p100, so it still absorbs a genuinely sick edge while removing the
// two-minute worst case from a path that gates the preview reveal.
const CERT_WARM_TIMEOUT_MS = parseInt(process.env.CERT_WARM_TIMEOUT_MS || '15000', 10);
// A probe slower than this gets a WARN. Well above the observed p100 so it
// fires on a real regression, not on noise.
const CERT_PROBE_SLOW_MS = parseInt(process.env.CERT_PROBE_SLOW_MS || '5000', 10);

function productionHostname(slug) {
  return `${slug}.${USERNODE_DOMAIN}`;
}

// Staging preview hostname. Stable per session (no commit hash): the label
// is `<slug>--s<sessionId>`, so every redeploy of a session reuses the same
// hostname and therefore the same TLS cert. (Embedding the commit hash here
// previously minted a brand-new hostname — and a brand-new ACME cert — on
// every redeploy, which is what exhausted Let's Encrypt's 50-cert/week/domain
// limit once real traffic arrived.) The Caddy `map` strips the `s` and routes
// `s<id>` -> `usernode-staging-<slug>--<id>`, matching the container name the
// platform already assigns. `sessionLabel` is `s${session.id}`.
function stagingHostname(slug, sessionLabel) {
  return `${slug}--${sessionLabel}.${USERNODE_DOMAIN}`;
}

// One-level wildcard match, the same rule browsers apply: `*.a.b` covers
// `x.a.b` but not `x.y.a.b` and not the bare apex `a.b`.
function matchesName(certName, hostname) {
  const name = String(certName).toLowerCase();
  const host = String(hostname).toLowerCase();
  if (name === host) return true;
  if (!name.startsWith('*.')) return false;
  const suffix = name.slice(1); // ".a.b"
  if (!host.endsWith(suffix)) return false;
  return !host.slice(0, host.length - suffix.length).includes('.');
}

// Flatten a node TLS peer certificate into the facts worth logging and
// surfacing. Issuer / serial / expiry are operational metadata, not
// credentials — nothing here needs redaction.
function summarizeCert(cert, hostname) {
  if (!cert || typeof cert !== 'object' || !cert.subject) return null;
  const subjectCN = cert.subject.CN || null;
  const issuerParts = [cert.issuer && cert.issuer.O, cert.issuer && cert.issuer.CN].filter(Boolean);
  const validTo = cert.valid_to || null;
  let daysToExpiry = null;
  if (validTo) {
    const expiresAt = Date.parse(validTo);
    if (!Number.isNaN(expiresAt)) {
      daysToExpiry = Math.floor((expiresAt - Date.now()) / 86400000);
    }
  }
  // subjectaltname looks like `DNS:*.example.org, DNS:example.org`.
  const sans = String(cert.subjectaltname || '')
    .split(',')
    .map((s) => s.trim().replace(/^DNS:/i, ''))
    .filter(Boolean);
  const names = subjectCN ? [subjectCN, ...sans] : sans;
  return {
    subject: subjectCN,
    issuer: issuerParts.length ? issuerParts.join(' / ') : null,
    serialNumber: cert.serialNumber || null,
    validFrom: cert.valid_from || null,
    validTo,
    daysToExpiry,
    isWildcard: names.some((n) => n.startsWith('*.')),
    sanMatched: hostname ? names.some((n) => matchesName(n, hostname)) : null,
  };
}

// Measure one TLS connection to the edge for `hostname`, and report which
// cert was actually served.
//
// This replaces the old blind "warm" (see warmCert below): instead of one
// opaque pass/fail it splits the connection into phases — TCP connect, TLS
// handshake, first byte — and reads the peer certificate's issuer, serial
// and expiry off the socket. That is what answers "did the cert path get
// slower, and is the edge serving the cert we think it is" rather than
// leaving it to inference.
//
// `handshakeOnly` (DEFAULT true) stops at `secureConnect` and destroys the
// socket without sending a request. The certificate is the thing being
// measured; a full `GET /` additionally traverses the wildcard site's
// forward_auth gate back into this very process and then wakes the app
// container, conflating three unrelated costs. Container readiness is
// already proven by the preceding docker.waitForHealthy, and the two deploy
// paths that reveal a URL with no probe at all (app-creator,
// staging-recovery) work fine — so the full request buys nothing on the
// reveal path. Pass `handshakeOnly: false` for a deliberate end-to-end probe.
//
// ALWAYS resolves, never rejects:
//   { ok, code, error, timings: { dnsMs, connectMs, tlsMs, ttfbMs, totalMs },
//     cert: { issuer, serialNumber, validTo, daysToExpiry, ... } | null,
//     tlsReused }
//
// `rejectUnauthorized` is off: we want to observe whatever cert is being
// served (including an unexpected or expired one) rather than abort the
// handshake — reporting the issuer IS the job here.
function probeEdge(hostname, {
  timeoutMs = CERT_WARM_TIMEOUT_MS,
  handshakeOnly = true,
  onResult,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timings = { dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null, totalMs: null };
    let cert = null;
    let tlsReused = null;
    let settled = false;

    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      timings.totalMs = Date.now() - startedAt;
      const statusCode = code === undefined ? null : code;
      if (typeof onResult === 'function') {
        try { onResult(err, statusCode); } catch { /* callback errors are not our problem */ }
      }
      const meta = {
        hostname,
        handshakeOnly,
        totalMs: timings.totalMs,
        connectMs: timings.connectMs,
        tlsMs: timings.tlsMs,
        ttfbMs: timings.ttfbMs,
        code: statusCode,
        issuer: cert ? cert.issuer : null,
        daysToExpiry: cert ? cert.daysToExpiry : null,
        tlsReused,
      };
      if (err) {
        log.warn('caddy', 'Edge probe failed', Object.assign({ err: err.message }, meta));
      } else if (timings.totalMs > CERT_PROBE_SLOW_MS) {
        log.warn('caddy', 'Edge probe slow', meta);
      } else {
        log.info('caddy', 'Edge probe', meta);
      }
      resolve({ ok: !err, code: statusCode, error: err || null, timings, cert, tlsReused });
    };

    if (!hostname || typeof hostname !== 'string') {
      return finish(new Error('probeEdge: no hostname'));
    }

    let req;
    try {
      req = https.request({
        host: process.env.CADDY_HOST || 'caddy',
        port: 443,
        method: 'GET',
        path: '/',
        servername: hostname,
        headers: { Host: hostname },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      }, (res) => {
        timings.ttfbMs = Date.now() - startedAt;
        res.resume(); // drain so the socket frees
        res.on('end', () => finish(null, res.statusCode));
        res.on('error', (err) => finish(err));
      });
    } catch (err) {
      return finish(err);
    }

    req.on('socket', (socket) => {
      socket.on('lookup', () => { timings.dnsMs = Date.now() - startedAt; });
      socket.on('connect', () => { timings.connectMs = Date.now() - startedAt; });
      socket.on('secureConnect', () => {
        const at = Date.now() - startedAt;
        // tlsMs is the handshake alone, i.e. what elapsed after TCP connect.
        timings.tlsMs = timings.connectMs === null ? at : at - timings.connectMs;
        try {
          cert = summarizeCert(socket.getPeerCertificate(), hostname);
          tlsReused = typeof socket.isSessionReused === 'function' ? socket.isSessionReused() : null;
        } catch { /* cert introspection is best-effort */ }
        if (handshakeOnly) {
          // The cert is in hand; never send a request line at all.
          try { req.destroy(); } catch { /* already gone */ }
          finish(null, null);
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error(`probeEdge timeout after ${timeoutMs}ms`)));
    // In handshakeOnly mode our own destroy() fires 'error' after we have
    // already settled; finish() is idempotent, so that is a no-op.
    req.on('error', (err) => finish(err));
    req.end();
  });
}

// Back-compat wrapper over probeEdge for the existing warm call sites.
//
// Historically this "pre-warmed" a hostname's on-demand TLS cert so a real
// user never landed on a cold hostname — under ZeroSSL the first hit blocked
// 60-90s on validation and showed a black page. That world is gone: the
// wildcard cert already covers every preview, so nothing is being warmed.
// The call now exists to MEASURE the edge (and confirm it answers) on a
// bounded budget before the preview link is revealed.
//
// Resolves (never rejects) to the old `{ ok, code, error }` shape plus the
// new `timings` / `cert` / `tlsReused` fields, so existing consumers and
// test stubs are unaffected.
function warmCert(hostname, {
  onResult,
  timeoutMs = CERT_WARM_TIMEOUT_MS,
  handshakeOnly = true,
} = {}) {
  return probeEdge(hostname, { onResult, timeoutMs, handshakeOnly });
}

module.exports = {
  productionHostname,
  stagingHostname,
  probeEdge,
  warmCert,
  summarizeCert,
  matchesName,
  USERNODE_DOMAIN,
  CERT_WARM_TIMEOUT_MS,
  CERT_PROBE_SLOW_MS,
};
