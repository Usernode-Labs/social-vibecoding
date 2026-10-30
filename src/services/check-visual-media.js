'use strict';

const { createHash } = require('node:crypto');
const media = require('./media-store');

// /visuals used Express's default weak response ETag, not the shots route's
// SHA-256 ETag. Preserve that validator when full bodies move to storage.
// SHA-256 remains the immutable object identity, separately from this tag.
function metadata(data) {
  return {
    sha256: media.objectKey(data).slice(media.PREFIX.length),
    bytes: data.length,
    legacyEtag: `W/"${data.length.toString(16)}-${createHash('sha1').update(data).digest('base64').slice(0, 27)}"`,
  };
}

// Preserve the old route's single-range parsing, including malformed
// headers falling through to a full response and unsatisfiable ranges 416.
function rangeFor(header, total) {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, total - parseInt(m[2], 10)) : parseInt(m[1], 10);
  const end = m[1] !== '' && m[2] !== '' ? parseInt(m[2], 10) : total - 1;
  if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
    return { start, end: Math.min(end, total - 1) };
  }
  return false;
}

module.exports = { metadata, rangeFor };
