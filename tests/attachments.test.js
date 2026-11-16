// Tests for file attachments (#450, expanded to any file type) — the pure
// helpers in src/services/attachments.js: the four-way upload classifier
// (magic-byte sniffing, UTF-8 gate, size caps, binary fallback), the group
// chat's classifier, zip central-directory safety validation, attachment-id
// sanitizing, and the PDF checks (#3557) that keep a document block the
// model provider could not read out of a conversation's history.
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

// ── validateChatUpload (#694 — group-chat classifier) ───────────────

test('validateChatUpload: valid image passes with sniffed content type', () => {
  const v = att.validateChatUpload({ filename: 'shot.png', data: PNG });
  assert.deepEqual(v, { ok: true, kind: 'image', contentType: 'image/png', meta: null });
});

test('validateChatUpload: image extension must agree with magic bytes', () => {
  const v = att.validateChatUpload({ filename: 'lies.png', data: JPEG });
  assert.equal(v.ok, false);
  assert.match(v.error, /extension doesn't match/);
});

test('validateChatUpload: markdown happy path (.md and .markdown)', () => {
  const data = Buffer.from('# Title\n\n- list\n', 'utf8');
  for (const name of ['notes.md', 'notes.markdown']) {
    const v = att.validateChatUpload({ filename: name, data });
    assert.deepEqual(v, { ok: true, kind: 'markdown', contentType: 'text/markdown', meta: null });
  }
});

test('validateChatUpload: oversize markdown rejected, not reclassified', () => {
  const v = att.validateChatUpload({
    filename: 'big.md',
    data: Buffer.alloc(att.MAX_MARKDOWN_BYTES + 1, 0x61),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /Markdown file too large/);
});

test('validateChatUpload: html happy path (.html and .htm)', () => {
  const data = Buffer.from('<!doctype html><html><body>hi</body></html>', 'utf8');
  for (const name of ['page.html', 'page.htm']) {
    const v = att.validateChatUpload({ filename: name, data });
    assert.deepEqual(v, { ok: true, kind: 'html', contentType: 'text/html', meta: null });
  }
});

test('validateChatUpload: oversize html rejected, not reclassified', () => {
  const v = att.validateChatUpload({
    filename: 'big.html',
    data: Buffer.alloc(att.MAX_HTML_BYTES + 1, 0x61),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /HTML file too large/);
});

test('validateChatUpload: non-UTF-8 html rejected', () => {
  const data = Buffer.concat([Buffer.from('<html>'), Buffer.from([0xff, 0xfe, 0x00])]);
  const v = att.validateChatUpload({ filename: 'weird.html', data });
  assert.equal(v.ok, false);
  assert.match(v.error, /isn't valid UTF-8/);
});

test('validateChatUpload: svg is text (never an image type)', () => {
  const v = att.validateChatUpload({
    filename: 'icon.svg',
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
  });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'text');
  assert.equal(v.contentType, 'text/plain');
});

test('validateChatUpload: zip rides the binary path (no zip validation in group chat)', () => {
  // Not even a valid zip — group chat treats .zip as an opaque download.
  const v = att.validateChatUpload({
    filename: 'stuff.zip',
    data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 0xd0)]),
  });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'binary');
  assert.equal(v.contentType, 'application/octet-stream');
});

test('validateChatUpload: oversize binary rejected', () => {
  const v = att.validateChatUpload({
    filename: 'huge.bin',
    data: Buffer.alloc(att.MAX_BINARY_BYTES + 1, 0xd0),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /File too large/);
});

test('validateChatUpload: small UTF-8 file of any other extension is text', () => {
  const v = att.validateChatUpload({ filename: 'config.json', data: Buffer.from('{"a":1}', 'utf8') });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'text');
});

test('validateChatUpload: empty file and bad filename rejected', () => {
  assert.equal(att.validateChatUpload({ filename: 'a.md', data: Buffer.alloc(0) }).ok, false);
  assert.equal(att.validateChatUpload({ filename: '', data: Buffer.from('x') }).ok, false);
  assert.equal(att.validateChatUpload({ filename: 'x'.repeat(300), data: Buffer.from('x') }).ok, false);
});

// ── PDFs (#3557) ────────────────────────────────────────────────────

// Starts with the `%PDF-` magic and carries a byte that is not UTF-8, as a
// real PDF's binary comment line does.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj\n<<>>\nendobj\n%%EOF\n')]);

test('#3557 validateUpload: a PDF is told by its bytes and stored as application/pdf', () => {
  for (const validate of [att.validateUpload, att.validateChatUpload]) {
    const v = validate({ filename: 'brief.pdf', data: PDF });
    assert.deepEqual(v, { ok: true, kind: 'binary', contentType: 'application/pdf', meta: null });
    // The name does not decide it either way.
    assert.equal(validate({ filename: 'brief', data: PDF }).contentType, 'application/pdf');
    // A PDF whose bytes all happen to be text is still a PDF, not inlined source.
    const asciiPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    assert.deepEqual(validate({ filename: 'plain.pdf', data: asciiPdf }),
      { ok: true, kind: 'binary', contentType: 'application/pdf', meta: null });
  }
});

test('#3557 validateUpload: a fake .pdf that is not one stays an opaque binary', () => {
  const fake = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x25, 0x50, 0x44, 0x46, 0x2d]);
  for (const validate of [att.validateUpload, att.validateChatUpload]) {
    assert.equal(validate({ filename: 'invoice.pdf', data: fake }).contentType, 'application/octet-stream');
    // A text file named .pdf stays text.
    assert.equal(validate({ filename: 'notes.pdf', data: Buffer.from('hello') }).kind, 'text');
  }
  assert.equal(att.isPdf(Buffer.from('%PDF')), false, 'truncated magic');
  assert.equal(att.isPdf('%PDF-1.7'), false, 'only a Buffer');
});

test('#3557 validateUpload: a PDF over the binary cap is rejected', () => {
  const big = Buffer.concat([PDF, Buffer.alloc(att.MAX_BINARY_BYTES)]);
  assert.equal(att.validateUpload({ filename: 'big.pdf', data: big }).ok, false);
  assert.equal(att.validateChatUpload({ filename: 'big.pdf', data: big }).ok, false);
});

test('#3557 withoutDocuments: every document block, nested or not, becomes a line naming it', () => {
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'brief.pdf' };
  const messages = [
    { role: 'user', content: [doc, { type: 'text', text: 'hi' }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [doc] }] },
  ];
  assert.equal(att.hasDocumentBlocks(messages), true);
  const stripped = att.withoutDocuments(messages);
  assert.equal(att.hasDocumentBlocks(stripped), false);
  assert.match(stripped[0].content[0].text, /brief\.pdf — PDF\. The model provider could not read it/);
  assert.match(stripped[2].content[0].content[0].text, /brief\.pdf/);
  assert.equal(JSON.stringify(stripped).includes('JVBERi0'), false);
  assert.equal(messages[0].content[0], doc, 'the caller\'s history is not mutated');
});

test('#3557 validate: the bytes decide before any extension, so a PDF named .png/.zip/.md/.html is a PDF', () => {
  for (const name of ['scan.png', 'bundle.zip', 'notes.md', 'page.html']) {
    for (const validate of [att.validateUpload, att.validateChatUpload]) {
      assert.deepEqual(validate({ filename: name, data: PDF }),
        { ok: true, kind: 'binary', contentType: 'application/pdf', meta: null }, `${validate.name} ${name}`);
    }
  }
});
