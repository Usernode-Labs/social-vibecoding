'use strict';

// File attachments: upload validation. Four kinds: 'image', 'text', 'zip'
// (central-directory-validated archives) and 'binary' (opaque files).
//
// Everything in this module is PURE so tests/attachments.test.js can
// exercise it without Postgres. No new npm deps: magic-byte sniffing
// instead of a MIME library.

// ── Limits ──────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // under Anthropic's 5 MB/image cap
const MAX_TEXT_BYTES = 200 * 1024; // inline-into-prompt gate; bigger text rides the binary path
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED = 100 * 1024 * 1024; // declared-size cap across all entries
const MAX_ZIP_ENTRIES = 2000;
// Per-entry compression-ratio bomb guard; entries smaller than the floor
// are exempt (tiny highly-compressible files legitimately exceed 100:1).
const MAX_ZIP_RATIO = 100;
const ZIP_RATIO_FLOOR_BYTES = 4 * 1024;
const MAX_BINARY_BYTES = 10 * 1024 * 1024;
const MAX_PER_MESSAGE = 4;
// ── Group-chat attachment limits (#694, mirrored in public/js/group-chat.js) ──
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_APP_CHAT_BYTES = 200 * 1024 * 1024;
const PDF_CONTENT_TYPE = 'application/pdf';

const IMAGE_EXT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function fileExt(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// Magic-byte sniff. Returns the detected image content type or null.
// Never trusts the client's Content-Type.
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// #3940: video clips are told by their first bytes too — the feedback
// upload route never trusts the browser's declared type. MP4 and MOV are
// both ISO BMFF boxes, so both start (after the 4-byte box length) with
// the `ftyp` brand box; MOV's major brand begins with `qt`. WebM is a
// Matroska subtype and carries the EBML magic.
function sniffVideoType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    if (buf.subarray(8, 10).toString('latin1') === 'qt') return 'video/quicktime';
    return 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'video/webm';
  }
  return null;
}

// #3557: a PDF is told by its first bytes (`%PDF-`), never by its name or
// the client's Content-Type. It stays kind 'binary' (the kind every
// consumer and serve route already handles); only its content type says
// what it is.
function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5
    && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// The stored content type for a 'binary' upload.
function binaryContentType(buf) {
  return isPdf(buf) ? PDF_CONTENT_TYPE : 'application/octet-stream';
}

// Valid UTF-8 with no NUL bytes — the gate for `kind: 'text'` uploads.
function isUtf8Text(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// Zip central-directory safety validation — pure Node, no decompression,
// no new npm deps (same convention as the magic-byte sniffing above).
// Parses the End-of-Central-Directory record and walks every central
// directory entry, rejecting the classic extraction hazards BEFORE the
// bytes are ever stored: path traversal names, symlink entries,
// encrypted entries, declared-size bombs, and entry-count bombs. The
// declared sizes are advisory (a lying local header can differ), which
// is why extraction only ever happens inside the disposable worker
// container — this gate is defence in depth, not the sole defence.
// Returns { ok: true, manifest: { entryCount, uncompressedBytes,
// topLevel } } or { ok: false, error } with a user-facing message.
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function validateZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, error: 'Not a valid zip archive' };
  }
  // EOCD lives in the last 22..65557 bytes (22-byte record + up to
  // 64 KiB trailing comment). Scan backwards for the signature whose
  // comment length exactly reaches the end of the buffer.
  let eocd = -1;
  const scanFloor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG
        && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return { ok: false, error: 'Not a valid zip archive (no end-of-central-directory record)' };
  }
  const diskNum = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesThisDisk = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNum !== 0 || cdDisk !== 0 || entriesThisDisk !== entryCount) {
    return { ok: false, error: 'Multi-disk zip archives aren\'t supported' };
  }
  // ZIP64 sentinels — anything legitimately under our size caps never
  // needs ZIP64, so reject rather than parse the ZIP64 EOCD.
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, error: 'Zip archive is too large or uses an unsupported format (ZIP64)' };
  }
  if (!entryCount) {
    return { ok: false, error: 'Zip archive is empty' };
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    return { ok: false, error: `Zip archive has too many files (max ${MAX_ZIP_ENTRIES})` };
  }
  if (cdOffset + cdSize > eocd) {
    return { ok: false, error: 'Corrupt zip archive (central directory out of bounds)' };
  }

  let pos = cdOffset;
  let totalUncompressed = 0;
  const topLevel = [];
  const seenTop = new Set();
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== CD_SIG) {
      return { ok: false, error: 'Corrupt zip archive (bad central directory entry)' };
    }
    const flags = buf.readUInt16LE(pos + 8);
    const compressed = buf.readUInt32LE(pos + 20);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const extAttrs = buf.readUInt32LE(pos + 38);
    if (pos + 46 + nameLen > eocd) {
      return { ok: false, error: 'Corrupt zip archive (entry name out of bounds)' };
    }
    if (flags & 0x0001) {
      return { ok: false, error: 'Password-protected zip archives aren\'t supported' };
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      return { ok: false, error: 'Zip archive is too large or uses an unsupported format (ZIP64)' };
    }
    // Symlink entries (Unix mode in the high 16 bits of external
    // attributes) are the second traversal vector after ../ names.
    if (((extAttrs >>> 16) & 0xf000) === 0xa000) {
      return { ok: false, error: 'Zip archive contains symbolic links, which aren\'t supported' };
    }
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    if (rawName.includes(0)) {
      return { ok: false, error: 'Zip archive contains an invalid file name' };
    }
    const name = rawName.toString('utf8').replace(/\\/g, '/');
    if (!name || name.length > 512 || name.startsWith('/') || /^[a-z]:/i.test(name)
        || name.split('/').some((seg) => seg === '..')) {
      return { ok: false, error: 'Zip archive contains an unsafe file path' };
    }
    if (compressed >= ZIP_RATIO_FLOOR_BYTES && uncompressed / compressed > MAX_ZIP_RATIO) {
      return { ok: false, error: 'Zip archive looks like a decompression bomb (extreme compression ratio)' };
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) {
      return { ok: false, error: `Zip contents too large (max ${Math.round(MAX_ZIP_UNCOMPRESSED / 1024 / 1024)} MB uncompressed)` };
    }
    const isDir = name.endsWith('/');
    const topSeg = name.split('/')[0];
    const top = (name.indexOf('/') >= 0 || isDir) ? `${topSeg}/` : topSeg;
    if (!seenTop.has(top)) {
      seenTop.add(top);
      if (topLevel.length < 20) topLevel.push(top);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return {
    ok: true,
    manifest: { entryCount, uncompressedBytes: totalUncompressed, topLevel },
  };
}

// Full upload validation — the four-way classifier. Returns
// { ok: true, kind, contentType, meta? } or { ok: false, error } with a
// user-facing message. `kind` is one of 'image' | 'zip' | 'text' |
// 'binary'; `meta` is the zip manifest (null otherwise). Anything that
// isn't a recognised image, a valid zip, or inline-sized UTF-8 text
// rides the binary path — delivered to the coding agent as a workspace
// file rather than rejected.
function validateUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, error: 'Empty file' };
  }
  // #3557: a PDF is told by its magic bytes before any extension branch,
  // so a name never overrides them. It is binary even when every byte is
  // readable text (its source is never inlined), and its content type
  // records that it is a PDF, which is what lets an agent read it.
  if (isPdf(data)) {
    if (data.length > MAX_BINARY_BYTES) {
      return { ok: false, error: `File too large (max ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)} MB)` };
    }
    return { ok: true, kind: 'binary', contentType: binaryContentType(data), meta: null };
  }
  const ext = fileExt(name);
  if (IMAGE_EXT_TYPES[ext]) {
    if (data.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
    }
    const sniffed = sniffImageType(data);
    if (!sniffed) {
      return { ok: false, error: `"${name}" doesn't look like a valid PNG/JPEG/GIF/WebP image` };
    }
    // Extension and bytes must agree so a served file can't lie about
    // its type (jpg/jpeg both map to image/jpeg).
    if (sniffed !== IMAGE_EXT_TYPES[ext]) {
      return { ok: false, error: `"${name}" extension doesn't match its actual image format` };
    }
    return { ok: true, kind: 'image', contentType: sniffed, meta: null };
  }
  if (ext === 'zip') {
    if (data.length > MAX_ZIP_BYTES) {
      return { ok: false, error: `Zip too large (max ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB)` };
    }
    if (!(data[0] === 0x50 && data[1] === 0x4b)) {
      return { ok: false, error: `"${name}" doesn't look like a valid zip archive` };
    }
    const zv = validateZip(data);
    if (!zv.ok) return zv;
    return { ok: true, kind: 'zip', contentType: 'application/zip', meta: zv.manifest };
  }
  // Any readable UTF-8 file small enough to inline is text, regardless
  // of extension (including .svg and extensionless files). Stored
  // content_type is always text/plain so serving can never execute
  // markup. Bigger or non-UTF-8 files fall through to binary.
  if (data.length <= MAX_TEXT_BYTES && isUtf8Text(data)) {
    return { ok: true, kind: 'text', contentType: 'text/plain', meta: null };
  }
  if (data.length > MAX_BINARY_BYTES) {
    return { ok: false, error: `File too large (max ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)} MB)` };
  }
  return { ok: true, kind: 'binary', contentType: 'application/octet-stream', meta: null };
}

// Group-chat upload classifier (#694). Five kinds: 'image' (inline
// preview), 'markdown' (rendered in the chat side panel), 'html'
// (sandbox-previewable via the /view route), 'text' (other UTF-8,
// download-only), 'binary' (opaque download — zips ride this path too;
// nothing extracts them in group chat, so no central-directory
// validation is needed here). Oversized .md/.html files are rejected
// with a clear error, not silently reclassified, matching images.
function validateChatUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, error: 'Empty file' };
  }
  // #3557: a PDF is told by its magic bytes before any extension branch,
  // so a name never overrides them. It is binary even when every byte is
  // readable text (its source is never inlined), and its content type
  // records that it is a PDF, which is what lets an agent read it.
  if (isPdf(data)) {
    if (data.length > MAX_BINARY_BYTES) {
      return { ok: false, error: `File too large (max ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)} MB)` };
    }
    return { ok: true, kind: 'binary', contentType: binaryContentType(data), meta: null };
  }
  const ext = fileExt(name);
  if (IMAGE_EXT_TYPES[ext]) {
    if (data.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
    }
    const sniffed = sniffImageType(data);
    if (!sniffed) {
      return { ok: false, error: `"${name}" doesn't look like a valid PNG/JPEG/GIF/WebP image` };
    }
    if (sniffed !== IMAGE_EXT_TYPES[ext]) {
      return { ok: false, error: `"${name}" extension doesn't match its actual image format` };
    }
    return { ok: true, kind: 'image', contentType: sniffed, meta: null };
  }
  if (ext === 'md' || ext === 'markdown') {
    if (data.length > MAX_MARKDOWN_BYTES) {
      return { ok: false, error: `Markdown file too large (max ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB)` };
    }
    if (!isUtf8Text(data)) {
      return { ok: false, error: `"${name}" isn't valid UTF-8 text` };
    }
    return { ok: true, kind: 'markdown', contentType: 'text/markdown', meta: null };
  }
  if (ext === 'html' || ext === 'htm') {
    if (data.length > MAX_HTML_BYTES) {
      return { ok: false, error: `HTML file too large (max ${Math.round(MAX_HTML_BYTES / 1024 / 1024)} MB)` };
    }
    if (!isUtf8Text(data)) {
      return { ok: false, error: `"${name}" isn't valid UTF-8 text` };
    }
    return { ok: true, kind: 'html', contentType: 'text/html', meta: null };
  }
  // Any other readable UTF-8 file under the text cap is 'text' (stored
  // text/plain — keeps the .svg-is-text rule: SVG never serves as an
  // image type). Bigger or non-UTF-8 files fall through to binary.
  if (data.length <= MAX_TEXT_BYTES && isUtf8Text(data)) {
    return { ok: true, kind: 'text', contentType: 'text/plain', meta: null };
  }
  if (data.length > MAX_BINARY_BYTES) {
    return { ok: false, error: `File too large (max ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)} MB)` };
  }
  return { ok: true, kind: 'binary', contentType: 'application/octet-stream', meta: null };
}

// attachmentIds from the chat POST body → deduped array of valid 32-hex
// ids, or null when the input is malformed / over the per-message cap.
function sanitizeAttachmentIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !/^[a-f0-9]{32}$/.test(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_PER_MESSAGE) return null;
  return out;
}

// #3557: the line a document block becomes when the provider refused the
// request it was in.
function refusedDocumentLine(block) {
  const title = typeof block?.title === 'string' && block.title.trim() ? block.title.trim() : 'a PDF';
  return `[attached file: ${title} — PDF. The model provider could not read it, so it is not shown to you. It is made available to the coding agent on dispatch.]`;
}

function hasDocumentBlocks(messages) {
  const inBlocks = (blocks) => Array.isArray(blocks) && blocks.some((block) => block && (
    block.type === 'document' || (block.type === 'tool_result' && inBlocks(block.content))
  ));
  return Array.isArray(messages) && messages.some((message) => inBlocks(message && message.content));
}

// The same messages with every document block replaced by its line: the
// one retry a Mayor request gets when a provider refuses a request that
// carried a PDF, so one bad file cannot fail every turn it is replayed on.
function withoutDocuments(messages) {
  const strip = (blocks) => blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'document') return { type: 'text', text: refusedDocumentLine(block) };
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return { ...block, content: strip(block.content) };
    }
    return block;
  });
  return (Array.isArray(messages) ? messages : []).map((message) => (
    message && Array.isArray(message.content) ? { ...message, content: strip(message.content) } : message
  ));
}

// Content-Disposition's legacy filename parameter is a header, so Node only
// accepts Latin-1 in it. Real filenames are not: macOS screenshot names carry
// a narrow no-break space (U+202F) before AM/PM, and people attach files
// named in any script. Passing such a name through verbatim makes
// res.set() throw ERR_INVALID_CHAR, which every serve route turns into a
// 500 (#2113). Keep a readable ASCII fallback and carry the exact UTF-8
// filename in the RFC 5987 parameter browsers prefer.
function attachmentDisposition(type, filename) {
  const name = String(filename || 'file');
  const fallback = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'file';
  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_ZIP_BYTES,
  MAX_ZIP_UNCOMPRESSED,
  MAX_ZIP_ENTRIES,
  MAX_BINARY_BYTES,
  MAX_PER_MESSAGE,
  MAX_MARKDOWN_BYTES,
  MAX_HTML_BYTES,
  MAX_APP_CHAT_BYTES,
  PDF_CONTENT_TYPE,
  fileExt,
  sniffImageType,
  sniffVideoType,
  isPdf,
  hasDocumentBlocks,
  withoutDocuments,
  isUtf8Text,
  validateZip,
  validateUpload,
  validateChatUpload,
  attachmentDisposition,
  sanitizeAttachmentIds,
};
