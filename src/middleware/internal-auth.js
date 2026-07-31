'use strict';

const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');
const { clientIp } = require('../services/client-ip');

// Authenticates requests from worker containers calling back into the
// platform's internal API surface (see src/routes/internal.js). Worker
// JWTs are minted by src/services/worker.js at warm-container bootstrap
// (and re-minted on every per-turn `docker exec`) and carry a single
// scope: 'worker:session'. The session id in the claim must match the
// session id in the route param — checked in the route handler, not
// here, so an obviously-malformed token gets a clean 401 before any
// route logic runs.
//
// The signing key is WORKER_JWT_SECRET, an authority of its own that is
// never placed in any container. verifyWorkerToken pins HS256, the
// `usernode` issuer, the `usernode:worker` audience and the
// `worker:session` purpose, so an app-identity or edge token — or
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

function isPrivateIp(ip) {
  if (!ip) return false;
  // Normalize IPv6-mapped IPv4 (`::ffff:172.18.0.5` -> `172.18.0.5`).
  const v4 = ip.replace(/^::ffff:/, '');
  // Docker bridge networks land in 172.16.0.0/12 by default; user-
  // defined networks can also use 10/8 or 192.168/16. Loopback covers
  // local-dev runs where the platform and "worker" both run on the host.
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

function internalAuth(req, res, next) {
  // IP gate first — if this somehow leaks externally, fail fast before
  // even parsing the JWT.
  const ip = clientIp(req);
  if (!isPrivateIp(ip)) {
    log.warn('internal-auth', 'Rejected non-private source IP', { ip, path: req.path });
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

  let claims;
  try {
    claims = platformJwt.verifyWorkerToken(m[1]);
  } catch (err) {
    return res.status(401).json({ ok: false, code: 'bad_token', message: err.message });
  }

  if (!claims || claims.scope !== platformJwt.PUR_WORKER || typeof claims.session_id === 'undefined') {
    return res.status(403).json({ ok: false, code: 'bad_scope' });
  }

  req.workerSession = {
    sessionId: claims.session_id,
    // #616: set only on the PROD_DEBUG_JWT minted by
    // worker.mintProdDebugJwt for eligible turns (admin-owned session on
    // the self-edit app). The prod-debug routes additionally re-check
    // eligibility in the DB on every request.
    prodDebug: claims.prod_debug === true,
  };
  next();
}

module.exports = { internalAuth };
