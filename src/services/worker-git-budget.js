'use strict';

const zlib = require('zlib');
const { promisify } = require('util');
const inflate = promisify(zlib.inflate);

// A compressed pack can contain much larger objects, including unreachable
// objects and small delta instructions with huge results. Check every entry
// before handing the pack to Git, without inflating beyond its declared size.
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 10000;

async function validatePackBudget(pack) {
  const invalid = () => { throw new Error('Invalid worker Git pack'); };
  const oversized = () => {
    throw new Error('Worker Git pack exceeds the decoded object budget (16 MiB per object, 64 MiB total, 10000 objects)');
  };
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' || pack.readUInt32BE(4) !== 2) invalid();
  const count = pack.readUInt32BE(8);
  if (count > MAX_OBJECTS) oversized();
  const end = pack.length - 20; // SHA-1 trailer, checked by Git during import.
  let pos = 12;
  let total = 0;
  const byte = () => { if (pos >= end) invalid(); return pack[pos++]; };
  for (let i = 0; i < count; i++) {
    let b = byte();
    const type = (b >> 4) & 7;
    if (![1, 2, 3, 4, 6, 7].includes(type)) invalid();
    let size = b & 15;
    let scale = 16;
    while (b & 128) {
      b = byte();
      size += (b & 127) * scale;
      if (!Number.isSafeInteger(size) || size > MAX_OBJECT_BYTES) oversized();
      scale *= 128;
      if (!Number.isSafeInteger(scale)) oversized();
    }
    if (size > MAX_OBJECT_BYTES || total + size > MAX_DECODED_BYTES) oversized();
    if (type === 6) {
      // Skip OFS_DELTA's backward offset. Git validates its target; only a
      // bounded number of bytes may precede the compressed delta stream.
      let n = 0;
      do { b = byte(); if (++n > 10) invalid(); } while (b & 128);
    } else if (type === 7) {
      pos += 20;
      if (pos >= end) invalid();
    }
    let inflated;
    try {
      // Use zlib's asynchronous convenience API: the bounded work runs off
      // the HTTP event loop, with maxOutputLength enforced during inflation.
      inflated = await inflate(pack.subarray(pos, end), { maxOutputLength: Math.max(1, size), info: true });
    } catch (_) { invalid(); }
    if (inflated.buffer.length !== size || !inflated.engine.bytesWritten) invalid();
    pos += inflated.engine.bytesWritten;
    let charge = size;
    if (type === 6 || type === 7) {
      const data = inflated.buffer;
      let at = 0;
      const deltaSize = () => {
        let value = 0; let multiplier = 1; let part;
        do {
          if (at >= data.length) invalid();
          part = data[at++];
          value += (part & 127) * multiplier;
          if (!Number.isSafeInteger(value) || value > MAX_OBJECT_BYTES) oversized();
          multiplier *= 128;
          if (!Number.isSafeInteger(multiplier)) oversized();
        } while (part & 128);
        return value;
      };
      deltaSize(); // Base size also bounds what Git may read from a prerequisite.
      charge += deltaSize();
    }
    total += charge;
    if (total > MAX_DECODED_BYTES) oversized();
  }
  if (pos !== end) invalid();
}

module.exports = { validatePackBudget, MAX_OBJECT_BYTES, MAX_DECODED_BYTES, MAX_OBJECTS };
