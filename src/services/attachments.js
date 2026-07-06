'use strict';

// Dev-chat file attachments (#450): validation + prompt-assembly helpers.
//
// Everything in this module that doesn't take a `pool` is PURE so
// tests/attachments.test.js can exercise it without Postgres. Storage is
// bytea-in-Postgres (chat_session_attachments, staging:private) following
// the session_visuals pattern — the platform container has no persistent
// file volume. No new npm deps: magic-byte sniffing instead of a MIME
// library, raw-body upload instead of multer.

// ── Limits (mirrored client-side in public/js/dev-chat.js) ──────────
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // under Anthropic's 5 MB/image cap
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_PER_MESSAGE = 4;
const MAX_SESSION_BYTES = 25 * 1024 * 1024;
// Per-file inline cap when text-file content is injected into a prompt.
const INLINE_CHAR_CAP = 50000;
// Image replay policy: image blocks are re-sent to the Mayor only for
// user rows within the last IMAGE_REPLAY_TURNS user turns, and at most
// IMAGE_REPLAY_MAX images per request. Older rows degrade to a textual
// placeholder — bounds recurring vision cost on long conversations.
const IMAGE_REPLAY_TURNS = 4;
const IMAGE_REPLAY_MAX = 8;

// The stored text a user row gets when the user sent attachments with no
// typed message — downstream code never sees empty content.
const ATTACHMENTS_ONLY_TEXT = '(attached files)';

const IMAGE_EXT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Anything on this list must decode as UTF-8; stored content_type is
// always text/plain so serving can never execute markup.
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log',
  'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'sql', 'sh',
]);

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

// Full upload validation. Returns { ok: true, kind, contentType } or
// { ok: false, error } with a user-facing message.
function validateUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, error: 'Empty file' };
  }
  const ext = fileExt(name);
  if (ext === 'svg') {
    return { ok: false, error: 'SVG is not supported — export it as PNG and attach that instead' };
  }
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
    return { ok: true, kind: 'image', contentType: sniffed };
  }
  if (TEXT_EXTS.has(ext)) {
    if (data.length > MAX_TEXT_BYTES) {
      return { ok: false, error: `Text file too large (max ${Math.round(MAX_TEXT_BYTES / 1024)} KB)` };
    }
    if (!isUtf8Text(data)) {
      return { ok: false, error: `"${name}" isn't readable text (must be UTF-8)` };
    }
    return { ok: true, kind: 'text', contentType: 'text/plain' };
  }
  return {
    ok: false,
    error: `File type ".${ext || '?'}" isn't supported — attach an image (PNG/JPEG/GIF/WebP) or a text file`,
  };
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

// Cap inlined text-file content with an explicit marker.
function clipText(str, cap = INLINE_CHAR_CAP) {
  const s = String(str || '');
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n[truncated — file continues past ${cap} characters]`;
}

function attachedFileBlock(filename, text) {
  return `==== ATTACHED FILE: ${filename} ====\n${clipText(text)}\n==== END ATTACHED FILE ====`;
}

// Image replay planning. `imageCounts` is the per-user-turn image count,
// CHRONOLOGICAL order. Returns a same-length array of booleans: whether
// that turn's images are included as vision blocks. A turn's images are
// all-or-nothing (partial inclusion would make the placeholder text lie).
function planImageInclusion(imageCounts, { turnWindow = IMAGE_REPLAY_TURNS, maxImages = IMAGE_REPLAY_MAX } = {}) {
  const include = imageCounts.map(() => false);
  let budget = maxImages;
  for (let back = 0; back < Math.min(turnWindow, imageCounts.length); back++) {
    const i = imageCounts.length - 1 - back;
    const count = imageCounts[i];
    if (!count) continue;
    if (count <= budget) {
      include[i] = true;
      budget -= count;
    }
  }
  return include;
}

// Build the Mayor-facing content for one user row that has attachments.
// `attachments` entries: { kind, filename, contentType, data: Buffer }.
// Returns a plain string when there are no attachments, otherwise an
// Anthropic content-block array: image blocks first, then a single text
// block carrying the user's text + inlined text files (+ placeholders for
// images excluded by the replay policy). Only user rows ever become
// arrays — assistant rows stay strings (buildMayorMessages merges them).
function buildUserMessageContent({ text, attachments, includeImages }) {
  const atts = attachments || [];
  if (!atts.length) return text;

  const blocks = [];
  const textParts = [String(text || '')];

  for (const att of atts) {
    if (att.kind === 'image') {
      if (includeImages) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.contentType || att.content_type,
            data: att.data.toString('base64'),
          },
        });
      } else {
        textParts.push(`[image attachment: ${att.filename} — shown in an earlier turn]`);
      }
    } else {
      textParts.push(attachedFileBlock(att.filename, att.data.toString('utf8')));
    }
  }

  // Anthropic rejects empty text blocks — only emit one when there's
  // text to carry (the chat route stores a stub caption for
  // attachments-only sends, so this is belt-and-suspenders).
  const joined = textParts.filter(Boolean).join('\n\n');
  if (joined) blocks.push({ type: 'text', text: joined });
  if (!blocks.length) return String(text || '');
  return blocks;
}

// The scout/build dispatch prompt block for the CURRENT turn's
// attachments. Text files are inlined verbatim (clipped); images are
// listed with the usernode-attachments CLI instructions so Claude Code
// can download and Read them in the worker container. '' when empty.
function buildDispatchBlock(attachments) {
  const atts = attachments || [];
  if (!atts.length) return '';
  const parts = [];
  let hasImages = false;
  for (const att of atts) {
    if (att.kind === 'image') {
      hasImages = true;
      parts.push(`image: ${att.filename} (id ${att.id}) — download it with \`usernode-attachments ${att.id} /tmp/${att.filename}\` (run via Bash), then use your Read tool on /tmp/${att.filename} to view it.`);
    } else {
      parts.push(attachedFileBlock(att.filename, att.data.toString('utf8')));
    }
  }
  const cliNote = hasImages
    ? '\n\nA read-only helper `usernode-attachments` is available (run it via Bash): with no arguments it lists this session\'s attachments as JSON; `usernode-attachments <id> <outpath>` downloads one attachment\'s bytes to a file. Use it to view the image attachments above.'
    : '';
  return `\n\n==== USER-ATTACHED FILES (this turn) ====\n\n${parts.join('\n\n')}\n\n==== END USER-ATTACHED FILES ====${cliNote}`;
}

// ── DB helpers (thin — the pure logic above stays pg-free) ──────────

// Bulk-load attachment rows (with bytes) for the user rows of a loaded
// chat history. Returns Map<messageId, [{ id, kind, filename,
// contentType, data }]>. History rows carry metadata.attachments (the
// render-time summary); the bytea rows are the prompt-time source.
async function loadForHistory(pool, history) {
  const ids = [];
  for (const row of history) {
    if (row.role === 'user' && row.id != null
        && Array.isArray(row.metadata?.attachments) && row.metadata.attachments.length) {
      ids.push(row.id);
    }
  }
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await pool.query(
    `SELECT id, message_id, kind, filename, content_type, data
       FROM chat_session_attachments
      WHERE message_id = ANY($1)
      ORDER BY created_at ASC, id ASC`,
    [ids]
  );
  for (const r of rows) {
    const entry = { id: r.id, kind: r.kind, filename: r.filename, contentType: r.content_type, data: r.data };
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push(entry);
  }
  return map;
}

// Load the current turn's attachments (with bytes) for the dispatch
// block. `ids` are already ownership-verified by the chat handler.
async function loadByIds(pool, ids) {
  if (!ids || !ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id, kind, filename, content_type, size_bytes, data
       FROM chat_session_attachments
      WHERE id = ANY($1)
      ORDER BY created_at ASC, id ASC`,
    [ids]
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, filename: r.filename,
    contentType: r.content_type, sizeBytes: r.size_bytes, data: r.data,
  }));
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_PER_MESSAGE,
  MAX_SESSION_BYTES,
  INLINE_CHAR_CAP,
  IMAGE_REPLAY_TURNS,
  IMAGE_REPLAY_MAX,
  ATTACHMENTS_ONLY_TEXT,
  fileExt,
  sniffImageType,
  isUtf8Text,
  validateUpload,
  sanitizeAttachmentIds,
  clipText,
  attachedFileBlock,
  planImageInclusion,
  buildUserMessageContent,
  buildDispatchBlock,
  loadForHistory,
  loadByIds,
};
