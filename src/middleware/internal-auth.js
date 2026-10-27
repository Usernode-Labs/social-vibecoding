'use strict';

const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');
const { clientIp, isDirectInternalCall } = require('../services/client-ip');

// Authenticates requests from worker containers calling back into the
// platform's internal API surface (see src/routes/internal.js). Worker
// JWTs are minted by src/services/worker.js at warm-container bootstrap
// (and re-minted on every per-turn `docker exec`) and carry a single
// purpose allowed by the route. The session id in the claim must match the
// session id in the route param — checked in the route handler, not
// here, so an obviously-malformed token gets a clean 401 before any
// route logic runs.
//
// The signing key is WORKER_JWT_SECRET, an authority of its own that is
// never placed in any container. Verification pins HS256, the
// `usernode` issuer, the `usernode:worker` audience and the route
// purpose, so an app-identity or edge token — or
// anything minted with the old shared secret — cannot be presented here.
//
// This middleware mounts BEFORE the global authMiddleware in server.js
// so cookie auth doesn't apply. The endpoint is intentionally NOT
// reachable through Caddy's external vhosts — the worker reaches it on
// the docker bridge network via the compose service hostname `usernode`.
//
// Defense in depth: we also drop requests that don't originate from a
// private IP, so even if Caddy ever leaked the path externally the
// internal API stays unreachable.

// #2506: the predicate is canonical in services/client-ip.js now.

// Each route explicitly lists its accepted purposes. Declaration/issues
// routes also accept the general worker:session token held by Claude Code;
// OpenRouter workers use narrow purposes and never hold that general token.
function verifier(purposes) {
  return function internalAuth(req, res, next) {
    // IP gate first — if this somehow leaks externally, fail fast before
    // even parsing the JWT.
    // #2506: a private RESOLVED address is not the same question as "came
    // from inside" — on a trusted-proxy DNS failure clientIp falls back to
    // the ingress's own private address. Ask about the direct peer instead.
    if (!isDirectInternalCall(req)) {
      log.warn('internal-auth', 'Rejected non-direct internal call',
        { ip: clientIp(req), path: req.path });
      return res.status(403).json({ ok: false, code: 'forbidden_ip' });
    }

    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer (.+)$/);
    if (!m) {
      return res.status(401).json({ ok: false, code: 'missing_auth' });
    }

    if (!process.env.WORKER_JWT_SECRET) {
      log.error('internal-auth', 'WORKER_JWT_SECRET not configured');
      return res.status(500).json({ ok: false, code: 'server_misconfigured' });
    }

    let claims = null;
    let lastErr = null;
    // Verify against each accepted purpose; accept on the first success.
    for (const purpose of purposes) {
      try {
        claims = platformJwt.verifyWorkerPurpose(m[1], purpose);
        break;
      } catch (err) {
        lastErr = err;
        claims = null;
      }
    }
    if (!claims) {
      return res.status(401).json({ ok: false, code: 'bad_token', message: (lastErr && lastErr.message) || 'unmatched purpose' });
    }
    if (typeof claims.session_id === 'undefined') {
      return res.status(403).json({ ok: false, code: 'bad_scope' });
    }

    req.workerSession = {
      sessionId: claims.session_id,
      shotsRunId: claims.shots_run_id || null,
      // #616: set only on the PROD_DEBUG_JWT minted by
      // worker.mintProdDebugJwt for eligible turns (admin-owned session on
      // the self-edit app). The prod-debug routes additionally re-check
      // eligibility in the DB on every request.
      prodDebug: claims.prod_debug === true,
      purpose: claims.pur || claims.scope,
    };
    next();
  };
}

module.exports = { internalAuthPurpose: verifier };
