// Tests for dev-chat file attachments (#450, expanded to any file
// type) — the pure helpers in src/services/attachments.js: the
// four-way upload classifier (magic-byte sniffing, UTF-8 gate, size
// caps, binary fallback), zip central-directory safety validation,
// attachment-id sanitizing, prompt assembly (content-block
// construction, placeholders, inline budgets), and the image replay
// policy (last-4-user-turns / max-8-images).
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

// Assemble a central-directory + EOCD zip skeleton from entry
// descriptors. validateZip never reads local file data (it walks the
// central directory only), so entries can declare arbitrary sizes /
// flags / attrs without carrying bytes — exactly what the traversal,
// bomb, and symlink tests need. Entry fields: name, compressed,
// uncompressed, flags (general-purpose bits), extAttrs.
function buildZip(entries) {
  const cdParts = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);          // central directory sig
    h.writeUInt16LE(20, 4);                  // version made by
    h.writeUInt16LE(20, 6);                  // version needed
    h.writeUInt16LE(e.flags || 0, 8);        // general-purpose bits
    h.writeUInt16LE(0, 10);                  // method: stored
    h.writeUInt32LE((e.compressed || 0) >>> 0, 20);
    h.writeUInt32LE((e.uncompressed || 0) >>> 0, 24);
    h.writeUInt16LE(nameBuf.length, 28);     // name len (extra/comment 0)
    h.writeUInt32LE((e.extAttrs || 0) >>> 0, 38);
    cdParts.push(h, nameBuf);
  }
  const cd = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16);                 // central directory at offset 0
  return Buffer.concat([cd, eocd]);
}

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
  assert.deepEqual(v, { ok: true, kind: 'image', contentType: 'image/png', meta: null });
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

test('validateUpload: image bytes with a text extension fall through to binary', () => {
  // PNG bytes contain NUL, so the UTF-8 gate fails and the file rides
  // the binary pass-through path instead of being rejected.
  const v = att.validateUpload({ filename: 'sneaky.txt', data: PNG });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'binary');
});

test('validateUpload: SVG accepted as plain text', () => {
  const v = att.validateUpload({ filename: 'logo.svg', data: Buffer.from('<svg/>') });
  assert.deepEqual(v, { ok: true, kind: 'text', contentType: 'text/plain', meta: null });
});

test('validateUpload: unknown-extension UTF-8 file classifies as text', () => {
  const v = att.validateUpload({ filename: 'config.toml', data: Buffer.from('[table]\nkey = 1') });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'text');
  const noExt = att.validateUpload({ filename: 'Makefile', data: Buffer.from('all:\n\techo hi') });
  assert.equal(noExt.ok, true);
  assert.equal(noExt.kind, 'text');
});

test('validateUpload: non-UTF-8 bytes classify as binary', () => {
  const v = att.validateUpload({ filename: 'video.mp4', data: Buffer.alloc(64) });
  assert.deepEqual(v, { ok: true, kind: 'binary', contentType: 'application/octet-stream', meta: null });
});

test('validateUpload: text file accepted and stored as text/plain', () => {
  const v = att.validateUpload({ filename: 'notes.md', data: Buffer.from('# hi') });
  assert.deepEqual(v, { ok: true, kind: 'text', contentType: 'text/plain', meta: null });
});

test('validateUpload: UTF-8 over the inline cap becomes binary, not rejected', () => {
  const bigTxt = Buffer.alloc(att.MAX_TEXT_BYTES + 1, 0x61);
  const v = att.validateUpload({ filename: 'big.txt', data: bigTxt });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'binary');
});

test('validateUpload: size caps enforced per kind', () => {
  const bigImg = Buffer.concat([PNG, Buffer.alloc(att.MAX_IMAGE_BYTES)]);
  assert.equal(att.validateUpload({ filename: 'big.png', data: bigImg }).ok, false);
  const bigBin = Buffer.alloc(att.MAX_BINARY_BYTES + 1);
  const v = att.validateUpload({ filename: 'huge.bin', data: bigBin });
  assert.equal(v.ok, false);
  assert.match(v.error, /too large/);
  const bigZip = Buffer.concat([Buffer.from('PK'), Buffer.alloc(att.MAX_ZIP_BYTES)]);
  assert.equal(att.validateUpload({ filename: 'big.zip', data: bigZip }).ok, false);
});

test('validateUpload: .zip without PK magic rejected', () => {
  const v = att.validateUpload({ filename: 'fake.zip', data: Buffer.from('just some text') });
  assert.equal(v.ok, false);
  assert.match(v.error, /valid zip/);
});

test('validateUpload: valid zip passes with manifest meta', () => {
  const zip = buildZip([
    { name: 'src/', compressed: 0, uncompressed: 0 },
    { name: 'src/app.js', compressed: 80, uncompressed: 100 },
    { name: 'README.md', compressed: 50, uncompressed: 50 },
  ]);
  const v = att.validateUpload({ filename: 'ref.zip', data: zip });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'zip');
  assert.equal(v.contentType, 'application/zip');
  assert.equal(v.meta.entryCount, 3);
  assert.equal(v.meta.uncompressedBytes, 150);
  assert.deepEqual(v.meta.topLevel, ['src/', 'README.md']);
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

// ── validateZip ─────────────────────────────────────────────────────

test('validateZip: valid archive returns a correct manifest', () => {
  const v = att.validateZip(buildZip([
    { name: 'proj/', compressed: 0, uncompressed: 0 },
    { name: 'proj/index.js', compressed: 200, uncompressed: 400 },
    { name: 'proj/lib/util.js', compressed: 100, uncompressed: 150 },
    { name: 'notes.txt', compressed: 10, uncompressed: 10 },
  ]));
  assert.equal(v.ok, true);
  assert.equal(v.manifest.entryCount, 4);
  assert.equal(v.manifest.uncompressedBytes, 560);
  assert.deepEqual(v.manifest.topLevel, ['proj/', 'notes.txt']);
});

test('validateZip: garbage / truncated buffers rejected', () => {
  assert.equal(att.validateZip(Buffer.from('PK')).ok, false);
  assert.equal(att.validateZip(Buffer.alloc(64, 0xaa)).ok, false);
  // EOCD claiming a central directory that runs out of bounds.
  const bad = buildZip([{ name: 'a.txt', compressed: 1, uncompressed: 1 }]);
  bad.writeUInt32LE(9999, bad.length - 22 + 12); // cdSize out of bounds
  assert.equal(att.validateZip(bad).ok, false);
});

test('validateZip: empty archive rejected', () => {
  assert.equal(att.validateZip(buildZip([])).ok, false);
});

test('validateZip: path traversal names rejected', () => {
  for (const name of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'C:\\boot.ini', 'a\\..\\b.txt']) {
    const v = att.validateZip(buildZip([{ name, compressed: 1, uncompressed: 1 }]));
    assert.equal(v.ok, false, `expected rejection for ${name}`);
    assert.match(v.error, /unsafe file path/);
  }
});

test('validateZip: NUL byte in entry name rejected', () => {
  const v = att.validateZip(buildZip([{ name: 'a\u0000b.txt', compressed: 1, uncompressed: 1 }]));
  assert.equal(v.ok, false);
});

test('validateZip: symlink entries rejected', () => {
  // Unix mode 0xA1FF (symlink, 0777) in the high 16 bits of external attrs.
  const v = att.validateZip(buildZip([
    { name: 'link', compressed: 5, uncompressed: 5, extAttrs: 0xa1ff0000 },
  ]));
  assert.equal(v.ok, false);
  assert.match(v.error, /symbolic links/);
});

test('validateZip: encrypted entries rejected', () => {
  const v = att.validateZip(buildZip([
    { name: 'secret.txt', compressed: 10, uncompressed: 10, flags: 0x0001 },
  ]));
  assert.equal(v.ok, false);
  assert.match(v.error, /[Pp]assword/);
});

test('validateZip: per-entry compression-ratio bomb rejected', () => {
  const v = att.validateZip(buildZip([
    { name: 'bomb.bin', compressed: 5000, uncompressed: 5000 * 200 },
  ]));
  assert.equal(v.ok, false);
  assert.match(v.error, /bomb/);
});

test('validateZip: tiny entries are exempt from the ratio check', () => {
  // 100 bytes → 50 KB is >100:1 but under the 4 KB compressed floor.
  const v = att.validateZip(buildZip([
    { name: 'tiny.txt', compressed: 100, uncompressed: 50 * 1024 },
  ]));
  assert.equal(v.ok, true);
});

test('validateZip: declared total uncompressed size cap enforced', () => {
  const sixtyMb = 60 * 1024 * 1024;
  const v = att.validateZip(buildZip([
    { name: 'a.bin', compressed: sixtyMb, uncompressed: sixtyMb },
    { name: 'b.bin', compressed: sixtyMb, uncompressed: sixtyMb },
  ]));
  assert.equal(v.ok, false);
  assert.match(v.error, /too large/);
});

test('validateZip: entry-count cap enforced', () => {
  const entries = Array.from({ length: att.MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
    name: `f${i}.txt`, compressed: 1, uncompressed: 1,
  }));
  const v = att.validateZip(buildZip(entries));
  assert.equal(v.ok, false);
  assert.match(v.error, /too many files/);
});

test('validateZip: ZIP64 sentinels rejected', () => {
  const zip = buildZip([{ name: 'a.txt', compressed: 1, uncompressed: 1 }]);
  zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16); // cdOffset sentinel
  const v = att.validateZip(zip);
  assert.equal(v.ok, false);
  assert.match(v.error, /ZIP64/);
});

test('validateZip: multi-disk archives rejected', () => {
  const zip = buildZip([{ name: 'a.txt', compressed: 1, uncompressed: 1 }]);
  zip.writeUInt16LE(1, zip.length - 22 + 4); // disk number 1
  const v = att.validateZip(zip);
  assert.equal(v.ok, false);
  assert.match(v.error, /Multi-disk/);
});

// ── zip/binary prompt placeholders ──────────────────────────────────

test('buildUserMessageContent: zip degrades to a manifest placeholder', () => {
  const content = att.buildUserMessageContent({
    text: 'port this project',
    attachments: [{
      kind: 'zip', filename: 'ref.zip', contentType: 'application/zip',
      sizeBytes: 3 * 1024 * 1024, data: Buffer.alloc(8),
      meta: { entryCount: 214, uncompressedBytes: 9000000, topLevel: ['src/', 'package.json', 'README.md'] },
    }],
    includeImages: true,
  });
  assert.ok(Array.isArray(content));
  const text = content[0].text;
  assert.ok(text.includes('ref.zip'));
  assert.ok(text.includes('zip archive'));
  assert.ok(text.includes('214 files'));
  assert.ok(text.includes('src/'));
  assert.ok(text.includes('coding agent'));
  assert.ok(!text.includes('==== ATTACHED FILE'));
});

test('buildUserMessageContent: binary degrades to a size placeholder', () => {
  const content = att.buildUserMessageContent({
    text: 'use this icon',
    attachments: [{
      kind: 'binary', filename: 'logo.ico', contentType: 'application/octet-stream',
      sizeBytes: 12 * 1024, data: Buffer.alloc(8),
    }],
    includeImages: true,
  });
  const text = content[0].text;
  assert.ok(text.includes('logo.ico'));
  assert.ok(text.includes('binary file'));
  assert.ok(text.includes('12 KB'));
});

test('buildDispatchBlock: zip gets an --unzip instruction with manifest summary', () => {
  const id = 'f'.repeat(32);
  const block = att.buildDispatchBlock([{
    id, kind: 'zip', filename: 'old dashboard.zip', contentType: 'application/zip',
    sizeBytes: 1024, data: Buffer.alloc(8),
    meta: { entryCount: 3, uncompressedBytes: 500, topLevel: ['src/', 'README.md'] },
  }]);
  assert.ok(block.includes(`usernode-attachments ${id} --unzip /home/node/attachments/old_dashboard/`));
  assert.ok(block.includes('3 files'));
  assert.ok(block.includes('read-only reference material'));
  assert.ok(block.includes('--unzip <dir>')); // generic CLI note present
});

test('buildDispatchBlock: binary gets a download instruction', () => {
  const id = 'a1'.repeat(16);
  const block = att.buildDispatchBlock([{
    id, kind: 'binary', filename: 'font.woff2', contentType: 'application/octet-stream',
    sizeBytes: 2048, data: Buffer.alloc(8),
  }]);
  assert.ok(block.includes(`usernode-attachments ${id} /home/node/attachments/font.woff2`));
  assert.ok(block.includes('read-only helper `usernode-attachments`'));
});

test('buildDispatchBlock: aggregate inline budget degrades overflow text to download', () => {
  // Two text files just under the per-file clip; the second blows the
  // aggregate budget and must degrade to a CLI instruction, unclipped.
  const bigBody = 'x'.repeat(att.INLINE_CHAR_CAP - 100);
  const atts = [
    { id: '1'.repeat(32), kind: 'text', filename: 'a.txt', data: Buffer.from(bigBody) },
    { id: '2'.repeat(32), kind: 'text', filename: 'b.txt', data: Buffer.from(bigBody) },
  ];
  const block = att.buildDispatchBlock(atts);
  assert.ok(block.includes('==== ATTACHED FILE: a.txt ===='));
  assert.ok(!block.includes('==== ATTACHED FILE: b.txt ===='));
  assert.ok(block.includes(`usernode-attachments ${'2'.repeat(32)} /home/node/attachments/b.txt`));
  assert.ok(block.length < att.INLINE_TOTAL_CHAR_CAP + 5000);
});

test('safePathName: shell-hostile filenames sanitized in instructions', () => {
  const id = 'b2'.repeat(16);
  const block = att.buildDispatchBlock([{
    id, kind: 'binary', filename: 'we$(rm -rf).bin', contentType: 'application/octet-stream',
    sizeBytes: 8, data: Buffer.alloc(8),
  }]);
  // The display label keeps the raw name; every path inside a
  // suggested shell command must be sanitized.
  assert.ok(block.includes('/home/node/attachments/we__rm_-rf_.bin'));
  assert.ok(!block.includes('attachments/we$('));
});
