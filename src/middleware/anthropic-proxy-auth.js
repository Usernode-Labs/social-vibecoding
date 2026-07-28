'use strict';

const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');

// Authenticates worker → platform Anthropic-proxy requests
// (POST /api/internal/anthropic/v1/messages, etc.).
//
// Sibling of internal-auth.js — same token authority (WORKER_JWT_SECRET,
// verified through platform-jwt with HS256 / issuer / `usernode:worker`
// audience / `worker:session` purpose all pinned), same private-IP gate —
// but reads the token from
// `x-api-key` instead of `Authorization: Bearer`. The Anthropic SDK and
// the `claude` CLI authenticate via `x-api-key`, so the worker container
// puts its WORKER_JWT in `ANTHROPIC_API_KEY` and the SDK forwards it
// here without us having to fork either client.
//
// Two narrow middlewares (this + internal-auth) is intentional — the
// existing internal endpoints (push, pr) should NOT accidentally accept
// api-key auth, and the proxy should NOT accept Authorization-header
// tokens. Keeping the headers segregated keeps the auth surface small
// and easy to reason about.

function isPrivateIp(ip) {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, '');
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

function anthropicProxyAuth(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!isPrivateIp(ip)) {
    log.warn('anthropic-proxy-auth', 'Rejected non-private source IP', { ip, path: req.path });
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

  let claims;
  try {
    claims = platformJwt.verifyWorkerToken(token);
  } catch (err) {
    return res.status(401).json({ ok: false, code: 'bad_token', message: err.message });
  }

  if (!claims || claims.scope !== platformJwt.PUR_WORKER || typeof claims.session_id === 'undefined') {
    return res.status(403).json({ ok: false, code: 'bad_scope' });
  }

  req.workerSession = { sessionId: claims.session_id };
  next();
}

module.exports = { anthropicProxyAuth, isPrivateIp };
