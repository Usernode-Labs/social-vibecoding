'use strict';

// Authenticates worker → platform OpenRouter Responses-relay requests
// (POST /api/internal/openrouter/v1/responses). Sibling of
// anthropic-proxy-auth.js — same WORKER_JWT_SECRET authority, same
// private-IP gate — but reads a scoped bearer token (Authorization:
// Bearer <agent-proxy-token>) carrying purpose agent:responses, and pins
// session/user/turn/backend/model/credential-revision. The relay then
// re-checks these claims against live DB state so a revoked key or
// completed turn cannot be used.

const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');
const { clientIp } = require('../services/client-ip');

function isPrivateIp(ip) {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || v4 === '::1') return true;
  if (/^10\./.test(v4)) return true;
  if (/^192\.168\./.test(v4)) return true;
  const m = v4.match(/^172\.(\d+)\./);
  if (m) { const oct = parseInt(m[1], 10); return oct >= 16 && oct <= 31; }
  return false;
}

function agentProxyAuth(req, res, next) {
  const ip = clientIp(req);
  if (!isPrivateIp(ip)) {
    log.warn('agent-proxy-auth', 'Rejected non-private source IP', { ip, path: req.path });
    return res.status(403).json({ ok: false, code: 'forbidden_ip' });
  }

  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ ok: false, code: 'missing_token' });
  }
  const token = auth.slice(7).trim();
  if (!token) return res.status(401).json({ ok: false, code: 'missing_token' });

  if (!process.env.WORKER_JWT_SECRET) {
    log.error('agent-proxy-auth', 'WORKER_JWT_SECRET not configured');
    return res.status(500).json({ ok: false, code: 'server_misconfigured' });
  }

  let claims;
  try {
    claims = platformJwt.verifyAgentProxyToken(token);
  } catch (err) {
    return res.status(401).json({ ok: false, code: 'bad_token', message: err.message });
  }
  if (!claims || claims.scope !== platformJwt.PUR_AGENT_PROXY) {
    return res.status(403).json({ ok: false, code: 'bad_scope' });
  }

  req.agentProxy = {
    sessionId: claims.session_id,
    userId: claims.user_id,
    turnId: claims.turn_id,
    backend: claims.backend,
    model: claims.model,
    credentialRevision: claims.credential_revision,
    agentConfigVersion: claims.agent_config_version,
  };
  next();
}

module.exports = { agentProxyAuth, isPrivateIp };
