'use strict';
// jsonwebtoken 9. A token signed by Homeroom (RS256 for a person, ES256 for a
// guest) is checked by the runner with Homeroom's own public keys: the key
// the app passes is not used, since the only keys an app is given for these
// are the same public keys (USERNODE_JWT_PUBLIC_KEY, USERNODE_GUEST_JWT_PUBLIC_KEY).
// The request's own identity token, already checked by the runner, costs
// nothing to verify again. HS256/384/512 tokens (an app's own secret) are
// signed and checked here, with the runner computing the HMAC.
// The claims checks (exp, nbf, aud, iss, sub, maxAge) follow jsonwebtoken.

const rt = require('../runtime.js');
const { Buffer } = rt;

class JsonWebTokenError extends Error { constructor(message, error) { super(message); this.name = 'JsonWebTokenError'; if (error) this.inner = error; } }
class NotBeforeError extends JsonWebTokenError { constructor(message, date) { super(message); this.name = 'NotBeforeError'; this.date = date; } }
class TokenExpiredError extends JsonWebTokenError { constructor(message, expiredAt) { super(message); this.name = 'TokenExpiredError'; this.expiredAt = expiredAt; } }

const HS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };

function b64urlJson(part) { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }

function decode(token, options) {
  const o = options || {};
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlJson(parts[0]); } catch (_) { return null; }
  payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  try { payload = JSON.parse(payload); } catch (_) { if (o.json) return null; }
  if (o.complete) return { header, payload, signature: parts[2] };
  return payload;
}

function secretBytes(secret) {
  if (typeof secret === 'string') return rt.encoder.encode(secret);
  if (secret instanceof Uint8Array) return secret;
  if (secret && typeof secret.export === 'function') return secret.export();
  throw new JsonWebTokenError('secret or public key must be provided');
}

function timespan(v, now) {
  if (typeof v === 'number') return now + v;
  const m = /^(-?\d+(?:\.\d+)?)\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i.exec(String(v));
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = (m[2] || 'ms').toLowerCase();
  const ms = u.startsWith('ms') || u.startsWith('milli') ? 1 : u.startsWith('s') ? 1000 : u.startsWith('m') ? 60000 : u.startsWith('h') ? 3600000 : u.startsWith('d') ? 86400000 : u.startsWith('w') ? 604800000 : 31557600000;
  return Math.floor(now + (n * ms) / 1000);
}

function checkClaims(payload, o) {
  const now = Math.floor((o.clockTimestamp || Date.now() / 1000));
  const tol = o.clockTolerance || 0;
  if (typeof payload.nbf !== 'undefined' && !o.ignoreNotBefore) {
    if (typeof payload.nbf !== 'number') throw new JsonWebTokenError('invalid nbf value');
    if (payload.nbf > now + tol) throw new NotBeforeError('jwt not active', new Date(payload.nbf * 1000));
  }
  if (typeof payload.exp !== 'undefined' && !o.ignoreExpiration) {
    if (typeof payload.exp !== 'number') throw new JsonWebTokenError('invalid exp value');
    if (now >= payload.exp + tol) throw new TokenExpiredError('jwt expired', new Date(payload.exp * 1000));
  }
  if (o.audience) {
    const want = [].concat(o.audience);
    const have = [].concat(payload.aud);
    const ok = have.some((a) => want.some((w) => (w instanceof RegExp ? w.test(a) : w === a)));
    if (!ok) throw new JsonWebTokenError('jwt audience invalid. expected: ' + want.join(' or '));
  }
  if (o.issuer) {
    const want = [].concat(o.issuer);
    if (!want.includes(payload.iss)) throw new JsonWebTokenError('jwt issuer invalid. expected: ' + want.join(','));
  }
  if (o.subject && payload.sub !== o.subject) throw new JsonWebTokenError('jwt subject invalid. expected: ' + o.subject);
  if (o.jwtid && payload.jti !== o.jwtid) throw new JsonWebTokenError('jwt jwtid invalid. expected: ' + o.jwtid);
  if (o.nonce && payload.nonce !== o.nonce) throw new JsonWebTokenError('jwt nonce invalid. expected: ' + o.nonce);
  if (o.maxAge) {
    if (typeof payload.iat !== 'number') throw new JsonWebTokenError('iat required when maxAge is specified');
    const max = timespan(o.maxAge, payload.iat);
    if (now >= max + tol) throw new TokenExpiredError('maxAge exceeded', new Date(max * 1000));
  }
}

function verifySync(token, secret, options) {
  const o = options || {};
  if (!token) throw new JsonWebTokenError('jwt must be provided');
  if (typeof token !== 'string') throw new JsonWebTokenError('jwt must be a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JsonWebTokenError('jwt malformed');
  const d = decode(token, { complete: true });
  if (!d) throw new JsonWebTokenError('invalid token');
  const alg = d.header.alg;
  if (o.algorithms && !o.algorithms.includes(alg)) throw new JsonWebTokenError('invalid algorithm');
  let payload;
  if (HS[alg]) {
    if (!secret) throw new JsonWebTokenError('secret or public key must be provided');
    const mac = rt.hmac(HS[alg], secretBytes(secret), rt.encoder.encode(parts[0] + '.' + parts[1]));
    if (mac.toString('base64url') !== parts[2]) throw new JsonWebTokenError('invalid signature');
    payload = d.payload;
  } else if (alg === 'RS256' || alg === 'ES256') {
    payload = rt.verifyToken(token).payload;
  } else {
    throw new JsonWebTokenError('invalid algorithm');
  }
  checkClaims(payload, o);
  return o.complete ? { header: d.header, payload, signature: parts[2] } : payload;
}

function verify(token, secret, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (typeof secret === 'function') throw new JsonWebTokenError('a secret callback is not available');
  if (!cb) return verifySync(token, secret, options);
  let out, err = null;
  try { out = verifySync(token, secret, options); } catch (e) { err = e; }
  rt.queueJob(() => (err ? cb(err) : cb(null, out)));
  return undefined;
}

function sign(payload, secret, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  const o = options || {};
  const alg = o.algorithm || 'HS256';
  if (!HS[alg]) throw new Error(`Signing with ${alg} is not available here: only HS256, HS384 and HS512`);
  const now = Math.floor((o.timestamp || Date.now()) / 1000);
  let body = typeof payload === 'object' && payload !== null && !Buffer.isBuffer(payload) ? Object.assign({}, payload) : payload;
  if (typeof body === 'object') {
    if (!o.noTimestamp && body.iat === undefined) body.iat = now;
    if (o.expiresIn !== undefined) body.exp = timespan(o.expiresIn, body.iat || now);
    if (o.notBefore !== undefined) body.nbf = timespan(o.notBefore, body.iat || now);
    if (o.audience !== undefined) body.aud = o.audience;
    if (o.issuer !== undefined) body.iss = o.issuer;
    if (o.subject !== undefined) body.sub = o.subject;
    if (o.jwtid !== undefined) body.jti = o.jwtid;
  }
  const header = Object.assign({ alg, typ: 'JWT' }, o.header || {});
  if (o.keyid) header.kid = o.keyid;
  const head = Buffer.from(JSON.stringify(header)).toString('base64url');
  const pl = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64url');
  const sig = rt.hmac(HS[alg], secretBytes(secret), rt.encoder.encode(head + '.' + pl)).toString('base64url');
  const token = `${head}.${pl}.${sig}`;
  if (cb) { rt.queueJob(() => cb(null, token)); return undefined; }
  return token;
}

module.exports = { verify, sign, decode, JsonWebTokenError, NotBeforeError, TokenExpiredError };
