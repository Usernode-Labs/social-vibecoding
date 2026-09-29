'use strict';

const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');
const { clientIp, isPrivateIp, isDirectInternalCall } = require('../services/client-ip');

// Authenticates worker → platform Anthropic-proxy requests
// (POST /api/internal/anthropic/v1/messages, etc.).
//
// Sibling of internal-auth.js — same token authority (WORKER_JWT_SECRET,
// verified through platform-jwt with HS256 / issuer / `usernode:worker`
// audience / purpose all pinned), same private-IP gate — but reads the token from
// `x-api-key` instead of `Authorization: Bearer`. The Anthropic SDK and
// the `claude` CLI authenticate via `x-api-key`, so the worker container
// puts a purpose-bound proxy token in `ANTHROPIC_API_KEY` and the SDK
// forwards it here without us having to fork either client. The legacy
// worker:session purpose remains accepted during rolling deploys so a turn
// dispatched by the previous process is not cut off mid-stream.
//
// Two narrow middlewares (this + internal-auth) is intentional — the
// existing internal endpoints (push, pr) should NOT accidentally accept
// api-key auth, and the proxy should NOT accept Authorization-header
// tokens. Keeping the headers segregated keeps the auth surface small
// and easy to reason about.

// #2506: the predicate is canonical in services/client-ip.js now — it was
// duplicated character for character here and in internal-auth.js. Still
// re-exported below, because app-storage-auth.js and app-llm-auth.js import
// it from this module.

function anthropicProxyAuth(req, res, next) {
  // #2506: ask whether this came DIRECTLY from inside, not whether the
  // RESOLVED address happens to be private. On a trusted-proxy DNS failure
  // `clientIp` falls back to the socket peer — the ingress's own private
  // address — and the old question then answered yes for an external caller.
  if (!isDirectInternalCall(req)) {
    log.warn('anthropic-proxy-auth', 'Rejected non-direct internal call',
      { ip: clientIp(req), path: req.path });
    return res.status(403).json({ ok: false, code: 'forbidden_ip' });
  }

  const token = req.headers['x-api-key'];
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ ok: false, code: 'missing_api_key' });
  }

  if (!process.env.WORKER_JWT_SECRET) {
    log.error('anthropic-proxy-auth', 'WORKER_JWT_SECRET not configured');
    return res.status(500).json({ ok: false, code: 'server_misconfigured' });
  }

  let claims = null;
  let lastErr = null;
  for (const purpose of [platformJwt.PUR_ANTHROPIC_PROXY, platformJwt.PUR_WORKER]) {
    try {
      claims = platformJwt.verifyWorkerPurpose(token, purpose);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!claims) {
    return res.status(401).json({
      ok: false,
      code: 'bad_token',
      message: lastErr?.message || 'unmatched purpose',
    });
  }

  req.workerSession = { sessionId: claims.session_id, purpose: claims.pur };
  next();
}

module.exports = { anthropicProxyAuth, isPrivateIp };
