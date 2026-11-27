'use strict';
// crypto, the common parts: random bytes and UUIDs, hashes and HMACs (sha1,
// sha256, sha384, sha512; computed by the runner), timingSafeEqual.
// Ciphers, key pairs and signing are not available.

const rt = require('../runtime.js');
const { Buffer } = rt;

class Hash {
  constructor(alg, key) { this._alg = String(alg).toLowerCase(); this._key = key; this._parts = []; }
  update(data, encoding) { this._parts.push(rt.toBytes(data, encoding)); return this; }
  digest(encoding) {
    const data = Buffer.concat(this._parts);
    const out = this._key ? rt.hmac(this._alg, this._key, data) : rt.digest(this._alg, data);
    return encoding ? out.toString(encoding) : out;
  }
  copy() { const h = new Hash(this._alg, this._key); h._parts = this._parts.slice(); return h; }
}
function randomBytes(n, cb) {
  const b = rt.randomBytes(n);
  if (cb) { rt.queueJob(() => cb(null, b)); return undefined; }
  return b;
}
function randomInt(min, max, cb) {
  if (max === undefined || typeof max === 'function') { cb = max; max = min; min = 0; }
  const range = max - min;
  const b = rt.randomBytes(6);
  const v = min + Math.floor(((b[0] * 2 ** 40) + (b[1] * 2 ** 32) + ((b[2] << 24) >>> 0) + (b[3] << 16) + (b[4] << 8) + b[5]) / 2 ** 48 * range);
  if (cb) { rt.queueJob(() => cb(null, v)); return undefined; }
  return v;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const unavailable = (name) => () => { throw new Error(`crypto.${name} is not available in Wasm previews`); };
module.exports = {
  randomBytes,
  randomUUID: rt.randomUUID,
  randomInt,
  getRandomValues: rt.getRandomValues,
  randomFillSync: (b) => rt.getRandomValues(b),
  createHash: (alg) => new Hash(alg, null),
  createHmac: (alg, key) => new Hash(alg, rt.toBytes(key)),
  timingSafeEqual,
  getHashes: () => ['sha1', 'sha256', 'sha384', 'sha512'],
  webcrypto: globalThis.crypto,
  createCipheriv: unavailable('createCipheriv'),
  createDecipheriv: unavailable('createDecipheriv'),
  createSign: unavailable('createSign'),
  createVerify: unavailable('createVerify'),
  generateKeyPairSync: unavailable('generateKeyPairSync'),
  pbkdf2Sync: unavailable('pbkdf2Sync'),
  scryptSync: unavailable('scryptSync'),
  createPublicKey: unavailable('createPublicKey'),
  createPrivateKey: unavailable('createPrivateKey'),
};
module.exports.default = module.exports;
