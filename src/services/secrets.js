'use strict';

// #30 BYOK encryption helpers.
//
// We store Anthropic API keys and app secret values at rest encrypted
// with AES-256-GCM. The key material is derived from
// `config.dataEncryptionKey` via SHA-256.
//
// That key used to be `config.jwtSecret` — the same value also signed
// every platform token AND was handed to every child container. It is
// now a dedicated env var (DATA_ENCRYPTION_KEY) holding the *same bytes*
// the old JWT_SECRET held: this was an env-var rename, not a rotation,
// because the KDF and the envelope below are unchanged and every
// ciphertext already in the database must keep decrypting.
//
// So: do not touch deriveKey, ALGO, IV_LEN or the VERSION prefix without
// a real migration that re-encrypts every stored row. A genuine key
// rotation belongs behind a "v2" prefix.
//
// Ciphertext is serialized as "v1:<iv_b64>:<tag_b64>:<ct_b64>" to keep
// the scheme versioned; future key rotations can add a "v2" prefix
// without ambiguity.

const crypto = require('crypto');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function deriveKey(dataKey) {
  if (!dataKey) throw new Error('secrets: dataEncryptionKey required');
  return crypto.createHash('sha256').update(String(dataKey)).digest();
}

function encrypt(plaintext, dataKey) {
  if (typeof plaintext !== 'string' || !plaintext.length) {
    throw new Error('secrets.encrypt: plaintext required');
  }
  const key = deriveKey(dataKey);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(payload, dataKey) {
  if (typeof payload !== 'string' || !payload.length) return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const key = deriveKey(dataKey);
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
