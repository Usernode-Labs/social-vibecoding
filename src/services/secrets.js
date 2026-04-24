'use strict';

// #30 BYOK encryption helpers.
//
// We store Anthropic API keys at rest encrypted with AES-256-GCM. The
// key material is derived from `config.jwtSecret` via SHA-256 so we
// don't introduce a second secret for operators to manage — losing the
// JWT secret already invalidates every session, so no additional risk.
//
// Ciphertext is serialized as "v1:<iv_b64>:<tag_b64>:<ct_b64>" to keep
// the scheme versioned; future key rotations can add a "v2" prefix
// without ambiguity.

const crypto = require('crypto');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function deriveKey(secret) {
  if (!secret) throw new Error('secrets: jwtSecret required');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plaintext, secret) {
  if (typeof plaintext !== 'string' || !plaintext.length) {
    throw new Error('secrets.encrypt: plaintext required');
  }
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(payload, secret) {
  if (typeof payload !== 'string' || !payload.length) return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const key = deriveKey(secret);
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
