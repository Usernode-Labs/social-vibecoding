'use strict';

// #6994: reading an uploaded website archive (services/archive-import.js).
// Archives are built in memory, so the suite needs no fixture files:
//   * zip and tar.gz are both read, and one wrapping folder is unwrapped;
//   * an archive with no top-level index.html is refused;
//   * paths that climb out, absolute paths, backslashes and links are refused;
//   * the file-count and per-file caps hold;
//   * Mac clutter is dropped without a word;
//   * a wrong extension or wrong magic bytes is refused;
//   * projectFiles keeps the scaffold's dapp.json and server.js, puts the
//     archive under public/, and inserts the Dev console forwarder once.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const archiveImport = require('../src/services/archive-import');

// ── Building archives in memory ────────────────────────────────────────
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A store-only zip. `mode` sets the unix mode the reader checks for links. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const crc = crc32(data);
    const mode = entry.mode ?? 0o100644;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made on unix
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function tarHeader({ name, size = 0, type = '0', linkname = '', mode = 0o644 }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function makeTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    parts.push(tarHeader({ name: entry.name, size: data.length, type: entry.type || '0', linkname: entry.linkname || '' }));
    if (entry.type !== '1' && entry.type !== '2') {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const filesOf = (result) => Object.fromEntries(result.files.map((file) => [file.path, file.content.toString('utf8')]));

test('a zip is read, and one wrapping folder is unwrapped', async () => {
  const zip = makeZip([
    { name: 'my-site/', mode: 0o040755 },
    { name: 'my-site/index.html', data: '<!doctype html><html><head><title>Hi</title></head><body>Hello</body></html>' },
    { name: 'my-site/app.js', data: 'console.log(1)' },
    { name: 'my-site/img/logo.svg', data: '<svg/>' },
  ]);
  const result = await archiveImport.read(zip, 'my-site.zip');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.fileCount, 3);
  assert.deepEqual(Object.keys(filesOf(result)).sort(), ['app.js', 'img/logo.svg', 'index.html']);
  assert.match(filesOf(result)['index.html'], /Hello/);
});

test('a tar.gz is read, and its top-level index.html found', async () => {
  const tarGz = makeTarGz([
    { name: 'index.html', data: '<html><head></head><body>Tar</body></html>' },
    { name: 'style.css', data: 'body{}' },
  ]);
  const result = await archiveImport.read(tarGz, 'site.tar.gz');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.keys(filesOf(result)).sort(), ['index.html', 'style.css']);
});

test('a 7z archive is read', async (t) => {
  let seven;
  try {
    const SevenZip = require('7z-wasm');
    seven = await SevenZip({ print: () => {}, printErr: () => {} });
  } catch {
    return t.skip('7z-wasm is not installed');
  }
  seven.FS.writeFile('/index.html', '<html><head></head><body>Seven</body></html>');
  assert.equal(seven.callMain(['a', '-bso0', '-bsp0', '/site.7z', '/index.html']), 0);
  const buffer = Buffer.from(seven.FS.readFile('/site.7z'));
  const result = await archiveImport.read(buffer, 'site.7z');
  assert.equal(result.ok, true, result.error);
  assert.match(filesOf(result)['index.html'], /Seven/);
});

test('an archive with no top-level index.html is refused', async () => {
  const zip = makeZip([{ name: 'page.html', data: 'hi' }]);
  const result = await archiveImport.read(zip, 'site.zip');
  assert.equal(result.ok, false);
  assert.match(result.error, /no index\.html at the top/i);
});

test('a wrong extension and wrong magic bytes are refused', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'hi' }]);
  assert.equal((await archiveImport.read(zip, 'site.tar.gz')).ok, false, 'magic and extension must agree');
  assert.equal((await archiveImport.read(Buffer.from('not an archive'), 'site.zip')).ok, false);
  assert.equal((await archiveImport.read(zip, 'site.bin')).ok, false);
});

test('unsafe paths are refused: .., absolute, drive letters and backslashes', async () => {
  for (const name of ['../index.html', '/etc/index.html', 'C:/index.html', 'a\\b/index.html']) {
    const result = await archiveImport.read(makeZip([{ name, data: 'x' }, { name: 'index.html', data: 'x' }]), 'x.zip');
    assert.equal(result.ok, false, name);
    assert.match(result.error, /path is unsafe/i, name);
  }
});

test('a tar symlink or hardlink is refused', async () => {
  const symlink = makeTarGz([
    { name: 'index.html', data: '<html></html>' },
    { name: 'passwd', type: '2', linkname: '/etc/passwd' },
  ]);
  assert.equal((await archiveImport.read(symlink, 'x.tar.gz')).ok, false);
  const hardlink = makeTarGz([
    { name: 'index.html', data: '<html></html>' },
    { name: 'passwd', type: '1', linkname: 'index.html' },
  ]);
  assert.equal((await archiveImport.read(hardlink, 'x.tar.gz')).ok, false);
});

test('a zip entry whose unix mode is a symlink is refused', async () => {
  const zip = makeZip([
    { name: 'index.html', data: '<html></html>' },
    { name: 'passwd', data: '/etc/passwd', mode: 0o120777 },
  ]);
  assert.equal((await archiveImport.read(zip, 'x.zip')).ok, false);
});

test('Mac clutter is dropped without a word', async () => {
  const zip = makeZip([
    { name: 'index.html', data: '<html></html>' },
    { name: '__MACOSX/index.html', data: 'junk' },
    { name: '.DS_Store', data: 'junk' },
  ]);
  const result = await archiveImport.read(zip, 'x.zip');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.keys(filesOf(result)), ['index.html']);
});

test('the file-count and per-file caps hold', async () => {
  const many = Array.from({ length: archiveImport.MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
  many.push({ name: 'index.html', data: 'x' });
  const tooMany = await archiveImport.read(makeZip(many), 'x.zip');
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /too many files/i);

  const big = [{ name: 'index.html', data: 'x' }, { name: 'big.bin', data: Buffer.alloc(archiveImport.MAX_FILE_BYTES + 1) }];
  const tooBig = await archiveImport.read(makeZip(big), 'x.zip');
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /file in that archive is too big/i);
});

test('duplicate paths are refused', async () => {
  const zip = makeZip([
    { name: 'index.html', data: 'one' },
    { name: 'index.html', data: 'two' },
  ]);
  assert.equal((await archiveImport.read(zip, 'x.zip')).ok, false);
});

test('projectFiles keeps the scaffold, drops its screen, and adds the archive under public/', () => {
  const scaffold = [
    { path: 'public/index.html', content: 'starter page' },
    { path: 'dapp.json', content: '{"name":"x"}' },
    { path: 'server.js', content: 'server' },
  ];
  const archiveFiles = [
    { path: 'index.html', content: Buffer.from('<html><head><title>Mine</title></head><body>Mine</body></html>') },
    { path: 'style.css', content: Buffer.from('body{}') },
  ];
  const files = archiveImport.projectFiles(scaffold, archiveFiles);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  assert.equal(byPath['dapp.json'], '{"name":"x"}');
  assert.equal(byPath['server.js'], 'server');
  assert.equal(byPath['public/index.html'] instanceof Buffer, true);
  const html = byPath['public/index.html'].toString('utf8');
  assert.match(html, /<title>Mine<\/title>/);
  assert.match(html, /usernode-dev-console@1/);
  assert.equal((html.match(/usernode-dev-console@1/g) || []).length, 1, 'inserted once');
  assert.equal(byPath['public/style.css'].toString('utf8'), 'body{}');
});

test('siteFiles is just the archive under public/, forwarder once on its index', () => {
  const archiveFiles = [
    { path: 'index.html', content: Buffer.from('<html><head></head><body>Mine</body></html>') },
    { path: 'game.js', content: Buffer.from('play()') },
  ];
  const files = archiveImport.siteFiles(archiveFiles);
  assert.deepEqual(files.map((file) => file.path), ['public/index.html', 'public/game.js']);
  const html = files[0].content.toString('utf8');
  assert.match(html, /usernode-dev-console@1/);
  assert.equal((html.match(/usernode-dev-console@1/g) || []).length, 1);
  assert.equal(files[1].content.toString('utf8'), 'play()');
});

test('safePath accepts a plain path and refuses a climb', () => {
  assert.equal(archiveImport.safePath('a/b.png'), 'a/b.png');
  assert.equal(archiveImport.safePath('./a//b.png'), 'a/b.png');
  assert.equal(archiveImport.safePath('../a'), null);
  assert.equal(archiveImport.safePath('/a'), null);
  assert.equal(archiveImport.safePath('a\\b'), null);
});
