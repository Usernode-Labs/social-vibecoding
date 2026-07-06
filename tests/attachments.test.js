// Tests for dev-chat file attachments (#450) — the pure helpers in
// src/services/attachments.js: upload validation (magic-byte sniffing,
// UTF-8 gate, size caps), attachment-id sanitizing, prompt assembly
// (content-block construction, inline truncation marker), and the
// image replay policy (last-4-user-turns / max-8-images).
//
// Run with: node --test tests/attachments.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const att = require('../src/services/attachments');

// ── Fixture buffers ─────────────────────────────────────────────────

// Real 1×1 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// Minimal signature-only buffers (sniffing only reads the header).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]);

// ── sniffImageType ──────────────────────────────────────────────────

test('sniffImageType: detects each supported format', () => {
  assert.equal(att.sniffImageType(PNG), 'image/png');
  assert.equal(att.sniffImageType(JPEG), 'image/jpeg');
  assert.equal(att.sniffImageType(GIF), 'image/gif');
  assert.equal(att.sniffImageType(WEBP), 'image/webp');
});

test('sniffImageType: rejects non-image and truncated buffers', () => {
  assert.equal(att.sniffImageType(Buffer.from('hello world, not an image')), null);
  assert.equal(att.sniffImageType(Buffer.from([0x89, 0x50])), null); // too short
  assert.equal(att.sniffImageType(Buffer.from('<svg xmlns="..."></svg>')), null);
});

// ── isUtf8Text ──────────────────────────────────────────────────────

test('isUtf8Text: accepts UTF-8 incl. multibyte, rejects NUL and bad bytes', () => {
  assert.equal(att.isUtf8Text(Buffer.from('plain ascii')), true);
  assert.equal(att.isUtf8Text(Buffer.from('émoji ✅ 日本語')), true);
  assert.equal(att.isUtf8Text(Buffer.from([0x68, 0x00, 0x69])), false); // NUL byte
  assert.equal(att.isUtf8Text(Buffer.from([0xff, 0xfe, 0x41])), false); // invalid UTF-8
});

// ── validateUpload ──────────────────────────────────────────────────

test('validateUpload: valid image passes with sniffed content type', () => {
  const v = att.validateUpload({ filename: 'shot.png', data: PNG });
  assert.deepEqual(v, { ok: true, kind: 'image', contentType: 'image/png' });
});

test('validateUpload: jpg and jpeg extensions both map to image/jpeg', () => {
  assert.equal(att.validateUpload({ filename: 'a.jpg', data: JPEG }).ok, true);
  assert.equal(att.validateUpload({ filename: 'a.jpeg', data: JPEG }).ok, true);
});

test('validateUpload: extension/bytes mismatch is rejected', () => {
  const v = att.validateUpload({ filename: 'sneaky.png', data: JPEG });
  assert.equal(v.ok, false);
  assert.match(v.error, /doesn't match/);
});

test('validateUpload: image bytes with a text extension fail the UTF-8 gate', () => {
  const v = att.validateUpload({ filename: 'sneaky.txt', data: PNG });
  assert.equal(v.ok, false);
});

test('validateUpload: SVG rejected explicitly', () => {
  const v = att.validateUpload({ filename: 'logo.svg', data: Buffer.from('<svg/>') });
  assert.equal(v.ok, false);
  assert.match(v.error, /SVG/);
});

test('validateUpload: unsupported extension rejected', () => {
  const v = att.validateUpload({ filename: 'video.mp4', data: Buffer.alloc(64) });
  assert.equal(v.ok, false);
  assert.match(v.error, /isn't supported/);
});

test('validateUpload: text file accepted and stored as text/plain', () => {
  const v = att.validateUpload({ filename: 'notes.md', data: Buffer.from('# hi') });
  assert.deepEqual(v, { ok: true, kind: 'text', contentType: 'text/plain' });
});

test('validateUpload: size caps enforced per kind', () => {
  const bigImg = Buffer.concat([PNG, Buffer.alloc(att.MAX_IMAGE_BYTES)]);
  assert.equal(att.validateUpload({ filename: 'big.png', data: bigImg }).ok, false);
  const bigTxt = Buffer.alloc(att.MAX_TEXT_BYTES + 1, 0x61);
  assert.equal(att.validateUpload({ filename: 'big.txt', data: bigTxt }).ok, false);
});

test('validateUpload: empty file / bad filename rejected', () => {
  assert.equal(att.validateUpload({ filename: 'a.txt', data: Buffer.alloc(0) }).ok, false);
  assert.equal(att.validateUpload({ filename: '', data: PNG }).ok, false);
  assert.equal(att.validateUpload({ filename: 'x'.repeat(300) + '.png', data: PNG }).ok, false);
});

// ── sanitizeAttachmentIds ───────────────────────────────────────────

test('sanitizeAttachmentIds: null/undefined → empty list', () => {
  assert.deepEqual(att.sanitizeAttachmentIds(undefined), []);
  assert.deepEqual(att.sanitizeAttachmentIds(null), []);
});

test('sanitizeAttachmentIds: valid ids pass, dupes collapse', () => {
  const id = 'a'.repeat(32);
  assert.deepEqual(att.sanitizeAttachmentIds([id, id]), [id]);
});

test('sanitizeAttachmentIds: malformed input → null', () => {
  assert.equal(att.sanitizeAttachmentIds('not-an-array'), null);
  assert.equal(att.sanitizeAttachmentIds([123]), null);
  assert.equal(att.sanitizeAttachmentIds(['UPPERCASE'.padEnd(32, 'a')]), null);
  assert.equal(att.sanitizeAttachmentIds(['a'.repeat(31)]), null);
  const many = Array.from({ length: att.MAX_PER_MESSAGE + 1 }, (_, i) => String(i).padStart(32, '0'));
  assert.equal(att.sanitizeAttachmentIds(many), null);
});

// ── clipText / attachedFileBlock ────────────────────────────────────

test('clipText: under the cap passes through untouched', () => {
  assert.equal(att.clipText('short'), 'short');
});

test('clipText: over the cap truncates with an explicit marker', () => {
  const clipped = att.clipText('x'.repeat(att.INLINE_CHAR_CAP + 10));
  assert.ok(clipped.includes('[truncated'));
  assert.ok(clipped.length < att.INLINE_CHAR_CAP + 100);
});

test('attachedFileBlock: wraps content in named markers', () => {
  const block = att.attachedFileBlock('notes.txt', 'hello');
  assert.ok(block.startsWith('==== ATTACHED FILE: notes.txt ===='));
  assert.ok(block.includes('hello'));
  assert.ok(block.endsWith('==== END ATTACHED FILE ===='));
});

// ── planImageInclusion (replay policy) ──────────────────────────────

test('planImageInclusion: recent turns included, older excluded', () => {
  // 6 user turns, one image each; window is 4 → last 4 included.
  const plan = att.planImageInclusion([1, 1, 1, 1, 1, 1]);
  assert.deepEqual(plan, [false, false, true, true, true, true]);
});

test('planImageInclusion: image budget caps total across turns', () => {
  // Last turn takes 6 of the 8 budget; the turn before (3 images)
  // doesn't fit and is excluded all-or-nothing; earlier 2 fits.
  const plan = att.planImageInclusion([2, 3, 6]);
  assert.deepEqual(plan, [true, false, true]);
});

test('planImageInclusion: turns with no images stay false and don\'t eat budget', () => {
  const plan = att.planImageInclusion([0, 2, 0, 0, 0]);
  // The 2-image turn is 4 turns back (window covers last 4 → indices 1..4).
  assert.deepEqual(plan, [false, true, false, false, false]);
});

test('planImageInclusion: oversized single turn is excluded', () => {
  const plan = att.planImageInclusion([att.IMAGE_REPLAY_MAX + 1]);
  assert.deepEqual(plan, [false]);
});

// ── buildUserMessageContent ─────────────────────────────────────────

test('buildUserMessageContent: no attachments → plain string', () => {
  assert.equal(att.buildUserMessageContent({ text: 'hi', attachments: [] }), 'hi');
});

test('buildUserMessageContent: image + text file → block array', () => {
  const content = att.buildUserMessageContent({
    text: 'match this mockup',
    attachments: [
      { kind: 'image', filename: 'mock.png', contentType: 'image/png', data: PNG },
      { kind: 'text', filename: 'notes.txt', contentType: 'text/plain', data: Buffer.from('my notes') },
    ],
    includeImages: true,
  });
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.type, 'base64');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, PNG.toString('base64'));
  assert.equal(content[1].type, 'text');
  assert.ok(content[1].text.includes('match this mockup'));
  assert.ok(content[1].text.includes('==== ATTACHED FILE: notes.txt ===='));
  assert.ok(content[1].text.includes('my notes'));
});

test('buildUserMessageContent: excluded images degrade to a placeholder line', () => {
  const content = att.buildUserMessageContent({
    text: 'old turn',
    attachments: [{ kind: 'image', filename: 'old.png', contentType: 'image/png', data: PNG }],
    includeImages: false,
  });
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 1); // no image block
  assert.equal(content[0].type, 'text');
  assert.ok(content[0].text.includes('[image attachment: old.png — shown in an earlier turn]'));
});

test('buildUserMessageContent: text files inline regardless of image policy', () => {
  const content = att.buildUserMessageContent({
    text: 'old turn',
    attachments: [{ kind: 'text', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('still here') }],
    includeImages: false,
  });
  assert.ok(content[0].text.includes('still here'));
});

// ── buildDispatchBlock ──────────────────────────────────────────────

test('buildDispatchBlock: empty → empty string', () => {
  assert.equal(att.buildDispatchBlock([]), '');
  assert.equal(att.buildDispatchBlock(null), '');
});

test('buildDispatchBlock: inlines text, references images via the CLI', () => {
  const id = 'c'.repeat(32);
  const block = att.buildDispatchBlock([
    { id, kind: 'image', filename: 'mock.png', contentType: 'image/png', data: PNG },
    { id: 'd'.repeat(32), kind: 'text', filename: 'notes.txt', contentType: 'text/plain', data: Buffer.from('note body') },
  ]);
  assert.ok(block.includes('==== USER-ATTACHED FILES (this turn) ===='));
  assert.ok(block.includes(`usernode-attachments ${id} /tmp/mock.png`));
  assert.ok(block.includes('==== ATTACHED FILE: notes.txt ===='));
  assert.ok(block.includes('note body'));
  assert.ok(block.includes('read-only helper `usernode-attachments`'));
});

test('buildDispatchBlock: text-only turn omits the CLI note', () => {
  const block = att.buildDispatchBlock([
    { id: 'e'.repeat(32), kind: 'text', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('x') },
  ]);
  assert.ok(!block.includes('usernode-attachments'));
});
