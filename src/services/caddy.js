// Hostname helpers for the platform's public URLs.
//
// Routing + TLS are handled entirely by Caddy via a single wildcard site
// (see Caddyfile): the hostname is mapped to a container name
// deterministically and certs are issued on-demand. The platform no
// longer writes per-host route blocks or runs `caddy reload`, so the old
// registerRoute/removeRoute/reloadCaddy functions (and the shared-file
// read-modify-write race that silently dropped routes) are gone. These
// two builders remain the single source of truth for the hostnames the
// Caddy `map` in the Caddyfile expects to see.

const https = require('https');

const USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';

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

// Pre-warm a hostname's on-demand TLS certificate at deploy time so a real
// user never lands on a cold hostname. On the first-ever request to a new
// hostname Caddy issues the cert lazily; with ZeroSSL ACME that validation
// takes ~60-90s, during which the TLS handshake hangs and the browser shows
// a blank/black page (it's before any HTML loads). We trigger issuance
// proactively by opening one TLS connection to Caddy with the hostname as
// the SNI — Caddy treats it like any other first hit and issues + caches the
// cert (good ~90 days). The handshake/request resolves only once the cert
// exists and Caddy can proxy upstream, so awaiting it is a reliable "the
// preview link actually works now" signal — the deploy path awaits it
// (bounded) before exposing the preview button, so users never click a cold
// link.
//
// Returns a Promise that ALWAYS resolves (never rejects) to
// `{ ok, code, error }`:
//   - ok=true,  code=<http status>  → cert issued, Caddy responded
//   - ok=false, error=<Error>       → timed out / network error / no-op
// Fire-and-forget callers can ignore the promise; the internal `timeoutMs`
// bounds the wait either way, so a slow/failed warm can never hang or fail a
// deploy (the cert still issues lazily on first visit, exactly as before —
// this only removes the cold-start wait). No-op (resolves ok=false) unless
// given an https hostname; local-dev maps previews to http://localhost:<port>
// with no Caddy in front, so there's nothing to warm. Caddy is reached by its
// container name on the shared docker network (override with CADDY_HOST);
// `rejectUnauthorized` is off because the cert is literally being minted
// during the handshake.
function warmCert(hostname, { onResult, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      if (typeof onResult === 'function') {
        try { onResult(err, code); } catch { /* callback errors are not our problem */ }
      }
      resolve({ ok: !err, code, error: err || null });
    };
    if (!hostname || typeof hostname !== 'string') {
      return finish(new Error('warmCert: no hostname'));
    }
    try {
      const req = https.request({
        host: process.env.CADDY_HOST || 'caddy',
        port: 443,
        method: 'GET',
        path: '/',
        servername: hostname,
        headers: { Host: hostname },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      }, (res) => {
        res.resume(); // drain so the socket frees
        res.on('end', () => finish(null, res.statusCode));
        res.on('error', (err) => finish(err));
      });
      req.on('timeout', () => req.destroy(new Error(`warmCert timeout after ${timeoutMs}ms`)));
      req.on('error', (err) => finish(err));
      req.end();
    } catch (err) {
      finish(err);
    }
  });
}

module.exports = {
  productionHostname,
  stagingHostname,
  warmCert,
  USERNODE_DOMAIN,
};
